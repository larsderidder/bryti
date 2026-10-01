import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.js";
import type { IncomingMessage } from "../channels/types.js";
import type { WorkStore } from "../work/store.js";
import { writeJsonAtomic } from "../durable-file.js";
import { isTargetAllowed } from "../scheduler.js";
import { createEmailReader } from "./email-readers.js";
import type { EmailCursor, EmailNotice, EmailReader, EmailTrigger } from "./email-types.js";

/** Require one allowlisted mailbox and aligned DMARC evidence in the receiver's first authentication header. */
export function authenticatedSender(message: EmailNotice, trigger: EmailTrigger): string | null {
  const from = message.headers.filter((header) => header.name.toLowerCase() === "from");
  if (from.length !== 1 || from[0].value.length > 1000) {
    return null;
  }
  let address = from[0].value.trim();
  if (address.includes("<")) {
    const match = address.match(/^(?:"[^"<>\r\n]*"|[^<>@,\r\n]*)\s*<([^<>\s]+)>$/);
    if (!match) {
      return null;
    }
    address = match[1];
  }
  address = address.toLowerCase();
  if (!/^[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,63}$/.test(address)
    || !trigger.sender_allowlist.includes(address)) {
    return null;
  }
  const auth = message.headers.find((header) => header.name.toLowerCase() === "authentication-results");
  if (!auth || auth.value.length > 8000) {
    return null;
  }
  const parts = auth.value.replace(/\([^)]*\)/g, "").split(";");
  if (!trigger.trusted_authserv_ids.includes(parts[0].trim().toLowerCase())) {
    return null;
  }
  const domain = address.split("@")[1];
  const dmarc = parts.filter((part) => /^\s*dmarc=pass\b/i.test(part));
  if (dmarc.length !== 1 || dmarc[0].match(/\bheader\.from=([^\s;]+)/i)?.[1].toLowerCase() !== domain) {
    return null;
  }
  return address;
}

/** Fail closed on malformed cursor files rather than silently skipping mail by rebasing. */
function readCursor(file: string): EmailCursor | null {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  try {
    if (!fs.fstatSync(fd).isFile() || fs.fstatSync(fd).size > 256_000) {
      throw new Error("Invalid email cursor file");
    }
    const cursor = JSON.parse(fs.readFileSync(fd, "utf8")) as EmailCursor;
    if (cursor?.provider === "gmail" && typeof cursor.historyId === "string" && /^\d{1,100}$/.test(cursor.historyId)
      && (cursor.nextPageToken === undefined || (typeof cursor.nextPageToken === "string" && cursor.nextPageToken.length <= 2000))
      && (cursor.highWaterHistoryId === undefined || (typeof cursor.highWaterHistoryId === "string" && /^\d{1,100}$/.test(cursor.highWaterHistoryId)))
      && (cursor.pendingIds === undefined || (Array.isArray(cursor.pendingIds) && cursor.pendingIds.length <= 1000 && cursor.pendingIds.every((id) => typeof id === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(id))))) {
      return cursor;
    }
    if (cursor?.provider === "imap" && typeof cursor.uidValidity === "string" && /^\d{1,100}$/.test(cursor.uidValidity)
      && Number.isSafeInteger(cursor.lastUid) && cursor.lastUid >= 0 && cursor.lastUid <= 0xffff_ffff) {
      return cursor;
    }
    throw new Error("Invalid email cursor");
  } finally {
    fs.closeSync(fd);
  }
}

/** Deliver inert, bounded previews through durable work receipts. Email never enters the agent loop. */
export function createEmailWatcher(config: Config, store: WorkStore, enqueue: (message: IncomingMessage) => boolean, readerFactory: (config: Config, trigger: EmailTrigger) => EmailReader = createEmailReader) {
  const triggers = config.email?.triggers ?? [];
  const readers = new Map<string, EmailReader>();
  const failures = new Map<string, { count: number; retryAt: number }>();
  const controller = new AbortController();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;

  /** Validate routing before touching mailbox credentials, and advance only after durable acceptance. */
  async function pollTriggers(): Promise<void> {
    for (const trigger of triggers) {
      if (stopped) {
        return;
      }
      const target = { userId: trigger.user_id, channelId: trigger.channel_id, platform: trigger.platform,
        threadId: trigger.thread_id ?? "main", channelThreadId: trigger.channel_thread_id };
      if (!isTargetAllowed(config, target) || (failures.get(trigger.id)?.retryAt ?? 0) > Date.now()) {
        continue;
      }
      try {
        if (!readers.has(trigger.id)) {
          readers.set(trigger.id, readerFactory(config, trigger));
        }
        const binding: unknown[] = [trigger.user_id, trigger.id, trigger.provider];
        if (trigger.provider === "gmail") {
          binding.push(trigger.account);
        } else {
          binding.push(trigger.imap.host, trigger.imap.port, trigger.imap.user, trigger.imap.mailbox);
        }
        const key = crypto.createHash("sha256").update(JSON.stringify(binding)).digest("hex");
        let directory = config.data_dir;
        for (const part of ["users", trigger.user_id, "email-cursors"]) {
          directory = path.join(directory, part);
          fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
          const stat = fs.lstatSync(directory);
          if (stat.isSymbolicLink() || !stat.isDirectory()) {
            throw new Error("Invalid email state directory");
          }
        }
        const file = path.join(directory, `${key}.json`);
        const cursor = readCursor(file);
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(45_000)]);
        const page = await readers.get(trigger.id)!(cursor, signal);
        const notices: IncomingMessage[] = [];
        if (page.gap) {
          notices.push({ ...target, workId: `email-gap:${key}:${crypto.createHash("sha256").update(JSON.stringify(cursor)).digest("hex")}`,
            text: `Email trigger ${trigger.id} lost its history cursor. Monitoring restarts from the current mailbox state; some mail may have been missed. No old messages were replayed.`, raw: { type: "email_notice" } });
        }
        for (const message of page.messages) {
          const sender = authenticatedSender(message, trigger);
          if (!sender) {
            continue;
          }
          // Sender-controlled Message-ID headers can collide; use the provider's immutable identity.
          const workId = `email:${crypto.createHash("sha256").update(key).update(message.id).digest("hex")}`;
          notices.push({ ...target, workId, replyMode: "text", raw: { type: "email_notice" },
            text: `Untrusted email preview. No instructions were executed.\n${JSON.stringify({ trigger: trigger.id, from: sender, subject: message.subject.slice(0, 500), preview: message.body.slice(0, 4000) }, null, 2)}`.slice(0, 8000) });
        }
        let accepted = true;
        for (const notice of notices) {
          signal.throwIfAborted();
          if (!store.get(notice.workId!) && !enqueue(notice)) {
            accepted = false;
            break;
          }
        }
        signal.throwIfAborted();
        if (accepted) {
          writeJsonAtomic(file, page.cursor);
        }
        failures.delete(trigger.id);
      } catch {
        if (!stopped) {
          const count = Math.min((failures.get(trigger.id)?.count ?? 0) + 1, 6);
          failures.set(trigger.id, { count, retryAt: Date.now() + Math.min(3_600_000, (config.email?.poll_interval_seconds ?? 60) * 1000 * 2 ** count) });
          console.warn(`[email] Trigger ${trigger.id} failed; cursor retained. Check authentication and provider settings.`);
        }
      }
    }
  }

  /** Serialize polling so a mailbox cannot advance two cursors concurrently in this process. */
  function poll(): Promise<void> {
    if (stopped) {
      return Promise.resolve();
    }
    if (!running) {
      running = pollTriggers().finally(() => { running = undefined; });
    }
    return running;
  }

  return {
    poll,
    start() {
      if (timer || stopped || triggers.length === 0) {
        return;
      }
      const tick = async () => {
        await poll();
        if (!stopped) {
          timer = setTimeout(() => { void tick(); }, (config.email?.poll_interval_seconds ?? 60) * 1000);
          timer.unref();
        }
      };
      timer = setTimeout(() => { void tick(); }, 0);
      timer.unref();
    },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      controller.abort();
      await running;
    },
  };
}
