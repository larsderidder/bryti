import { ImapFlow } from "imapflow";
import PostalMime from "postal-mime";
import type { Config } from "../config.js";
import { createGoogleAccountStore, googleJson } from "./google-auth.js";
import { googleClient, type GmailMessage } from "./google-tools.js";
import type { EmailCursor, EmailNotice, EmailReader, EmailTrigger } from "./email-types.js";

const MAX_BATCH = 10;
const MAX_RAW_BYTES = 256_000;

/** Require lossless history IDs; Gmail's decimal counters must never pass through a JS number. */
function historyId(value: unknown): string {
  if (typeof value !== "string" || !/^\d{1,100}$/.test(value)) {
    throw new Error("Invalid Gmail history ID");
  }
  return value;
}

/** Read Gmail history one bounded page at a time, retaining continuation and pending IDs. */
export function createGmailReader(config: Config, trigger: Extract<EmailTrigger, { provider: "gmail" }>): EmailReader {
  const store = createGoogleAccountStore(config.data_dir, trigger.user_id, googleClient(config));
  return async (cursor, signal) => {
    const token = await store.accessToken(trigger.account, signal);
    const request = (endpoint: string) => googleJson(`https://www.googleapis.com/gmail/v1/users/me${endpoint}`, { headers: { Authorization: `Bearer ${token}` } }, signal);
    if (!cursor) {
      const profile = await request("/profile");
      return { cursor: { provider: "gmail", historyId: historyId(profile.historyId) }, messages: [] };
    }
    if (cursor.provider !== "gmail") {
      throw new Error("Email cursor provider mismatch");
    }
    let next = { ...cursor };
    let ids = [...(cursor.pendingIds ?? [])];
    if (ids.length === 0) {
      const params = new URLSearchParams({ startHistoryId: cursor.historyId, historyTypes: "messageAdded", labelId: "INBOX", maxResults: "25" });
      if (cursor.nextPageToken) {
        params.set("pageToken", cursor.nextPageToken);
      }
      let result: Record<string, unknown>;
      try {
        result = await request(`/history?${params}`);
      } catch (error) {
        if (error instanceof Error && error.message === "Google request failed (404)") {
          const profile = await request("/profile");
          return { cursor: { provider: "gmail", historyId: historyId(profile.historyId) }, messages: [], gap: true };
        }
        if (cursor.nextPageToken && error instanceof Error && error.message === "Google request failed (400)") {
          return { cursor: { provider: "gmail", historyId: cursor.historyId }, messages: [] };
        }
        throw error;
      }
      const history = result.history as Array<{ messagesAdded?: Array<{ message: { id: string } }> }> | undefined;
      for (const entry of history ?? []) {
        for (const addition of entry.messagesAdded ?? []) {
          const id = addition.message.id;
          if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id) || ids.length >= 1000) {
            throw new Error("Gmail history page exceeds its input budget");
          }
          ids.push(id);
        }
      }
      ids = [...new Set(ids)];
      let pageToken: string | undefined;
      if (result.nextPageToken !== undefined) {
        if (typeof result.nextPageToken !== "string" || result.nextPageToken.length > 2000) {
          throw new Error("Invalid Gmail continuation");
        }
        pageToken = result.nextPageToken;
      }
      next = { provider: "gmail", historyId: cursor.historyId, highWaterHistoryId: cursor.highWaterHistoryId ?? historyId(result.historyId), nextPageToken: pageToken };
    }
    const messages: EmailNotice[] = [];
    for (const id of ids.slice(0, MAX_BATCH)) {
      signal.throwIfAborted();
      let result: Record<string, unknown>;
      try {
        result = await request(`/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Authentication-Results&metadataHeaders=Subject&metadataHeaders=Message-ID`);
      } catch (error) {
        // Deleted messages no longer have readable content. Other failures retain the cursor.
        if (error instanceof Error && error.message === "Google request failed (404)") {
          continue;
        }
        throw error;
      }
      const message = result as unknown as GmailMessage;
      const headers = (message.payload?.headers ?? []).slice(0, 1024);
      const subject = headers.find((header) => header.name.toLowerCase() === "subject")?.value.slice(0, 1000);
      messages.push({ id, messageId: headers.find((header) => header.name.toLowerCase() === "message-id")?.value,
        headers, subject: subject ?? "(No subject)", body: message.snippet?.slice(0, 2000) ?? "(No plain-text preview)" });
    }
    next.pendingIds = ids.slice(MAX_BATCH);
    if (!next.nextPageToken && next.pendingIds.length === 0) {
      next = { provider: "gmail", historyId: historyId(next.highWaterHistoryId ?? next.historyId) };
    }
    return { cursor: next, messages };
  };
}

/** Poll IMAP over verified TLS, EXAMINE the mailbox, and download only a bounded message prefix. */
export function createImapReader(trigger: Extract<EmailTrigger, { provider: "imap" }>): EmailReader {
  return async (cursor, signal) => {
    signal.throwIfAborted();
    if (cursor && cursor.provider !== "imap") {
      throw new Error("Email cursor provider mismatch");
    }
    const client = new ImapFlow({ host: trigger.imap.host, port: trigger.imap.port, secure: true,
      auth: { user: trigger.imap.user, pass: trigger.imap.password }, tls: { rejectUnauthorized: true }, logger: false,
      disableAutoIdle: true, connectionTimeout: 30_000, greetingTimeout: 10_000, socketTimeout: 30_000,
      maxLiteralSize: 300_000, maxResponseSize: 1_000_000, maxLineLength: 64_000 });
    // Connection errors also reject the pending command. Never log protocol frames or credentials.
    client.on("error", () => {});
    const abort = () => client.close();
    signal.addEventListener("abort", abort, { once: true });
    try {
      await client.connect();
      signal.throwIfAborted();
      const mailbox = await client.mailboxOpen(trigger.imap.mailbox, { readOnly: true });
      const validity = String(mailbox.uidValidity);
      const highest = mailbox.uidNext - 1;
      if (!/^\d+$/.test(validity) || !Number.isSafeInteger(highest) || highest < 0 || highest > 0xffff_ffff) {
        throw new Error("Invalid IMAP mailbox state");
      }
      if (!cursor || cursor.uidValidity !== validity) {
        return { cursor: { provider: "imap", uidValidity: validity, lastUid: highest }, messages: [], gap: cursor !== null };
      }
      if (cursor.lastUid >= highest) {
        return { cursor, messages: [] };
      }
      const end = Math.min(highest, cursor.lastUid + 1000);
      const found = await client.search({ uid: `${cursor.lastUid + 1}:${end}` }, { uid: true });
      if (!Array.isArray(found)) {
        throw new Error("IMAP UID search failed");
      }
      const ids = found.filter((id) => Number.isSafeInteger(id) && id > cursor.lastUid && id <= end).sort((a, b) => a - b);
      const messages: EmailNotice[] = [];
      for (const uid of ids.slice(0, MAX_BATCH)) {
        signal.throwIfAborted();
        const download = await client.download(uid, undefined, { uid: true, maxBytes: MAX_RAW_BYTES, chunkSize: 32_000 });
        if (!download.content) {
          continue;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of download.content) {
          signal.throwIfAborted();
          const bytes = Buffer.from(chunk);
          size += bytes.length;
          if (size > MAX_RAW_BYTES) {
            download.content.destroy();
            throw new Error("IMAP message exceeds its byte budget");
          }
          chunks.push(bytes);
        }
        try {
          const parsed = await PostalMime.parse(Buffer.concat(chunks), { maxNestingDepth: 10, maxHeadersSize: 32_000, maxRfc822NestingDepth: 0 });
          messages.push({ id: `${validity}:${uid}`, messageId: parsed.messageId,
            headers: parsed.headers.map((header) => ({ name: header.key, value: header.value })),
            subject: parsed.subject?.slice(0, 1000) ?? "(No subject)", body: parsed.text?.slice(0, 20_000) ?? "(No plain-text preview)" });
        } catch {
          // Malformed/oversized MIME is not eligible for authenticated notifications.
        }
      }
      let lastUid = end;
      if (ids.length > MAX_BATCH) {
        lastUid = ids[MAX_BATCH - 1];
      }
      return { cursor: { provider: "imap", uidValidity: validity, lastUid }, messages };
    } finally {
      signal.removeEventListener("abort", abort);
      client.close();
    }
  };
}

/** Choose a read-only provider; no email reader loads tools, models, extensions, or MCP. */
export function createEmailReader(config: Config, trigger: EmailTrigger): EmailReader {
  if (trigger.provider === "gmail") {
    return createGmailReader(config, trigger);
  }
  return createImapReader(trigger);
}
