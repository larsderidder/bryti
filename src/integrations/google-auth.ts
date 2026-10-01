import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { lock } from "proper-lockfile";
import { writeJsonAtomic } from "../durable-file.js";
import { readResponseBuffer } from "../util/response-body.js";

export interface GoogleClient { clientId: string; clientSecret: string }
export interface GoogleTokens { access_token: string; refresh_token: string; expires_at: number; email: string }
export interface GoogleAccountStore {
  list(): string[];
  saveNew(account: string, tokens: GoogleTokens): void;
  accessToken(account: string, signal?: AbortSignal): Promise<string>;
}

/** Keep user IDs and account aliases to one filesystem component. */
function identifier(value: string): string {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(value)) {
    throw new Error("Invalid Google user ID or account alias");
  }
  return value;
}

/** Fetch bounded Google JSON without putting credentials or provider error bodies in errors. */
export async function googleJson(url: string, init: RequestInit = {}, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const combined = AbortSignal.any([AbortSignal.timeout(30_000), signal ?? new AbortController().signal]);
  try {
    const endpoint = new URL(url);
    if (endpoint.protocol !== "https:" || !["www.googleapis.com", "oauth2.googleapis.com"].includes(endpoint.hostname)
      || endpoint.username || endpoint.password || endpoint.port || endpoint.hash) {
      throw new Error("Invalid Google endpoint");
    }
    const response = await fetch(url, { ...init, signal: combined, redirect: "error" });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Google request failed (${response.status})`);
    }
    const bytes = await readResponseBuffer(response, 1_000_000);
    if (bytes.length === 0) {
      return {};
    }
    const result = JSON.parse(bytes.toString("utf8")) as unknown;
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new Error("Invalid Google response");
    }
    return result as Record<string, unknown>;
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof Error && /^Google request failed \(\d+\)$/.test(error.message)) {
      throw error;
    }
    throw new Error("Google request failed or returned invalid data");
  }
}

/** Validate token response fields before persisting or using them. */
function tokenRecord(value: unknown): GoogleTokens {
  const candidate = value as Partial<GoogleTokens> | null;
  if (!candidate || typeof candidate.access_token !== "string" || !candidate.access_token || candidate.access_token.length > 16_384
    || typeof candidate.refresh_token !== "string" || !candidate.refresh_token || candidate.refresh_token.length > 16_384
    || typeof candidate.expires_at !== "number" || !Number.isFinite(candidate.expires_at)
    || typeof candidate.email !== "string" || candidate.email.length > 320) {
    throw new Error("Invalid Google credentials");
  }
  return candidate as GoogleTokens;
}

/** Accept only finite, positive token lifetimes from the OAuth provider. */
function expiresAt(result: Record<string, unknown>): number {
  if (typeof result.expires_in !== "number" || !Number.isFinite(result.expires_in) || result.expires_in <= 0 || result.expires_in > 604_800) {
    throw new Error("Invalid Google token lifetime");
  }
  return Date.now() + result.expires_in * 1000;
}

/** Store account credentials privately; lock refreshes across chat sessions and operator processes. */
export function createGoogleAccountStore(dataDir: string, userId: string, client: GoogleClient): GoogleAccountStore {
  identifier(userId);
  let directory = path.resolve(dataDir);
  const directories: string[] = [];
  for (const component of ["users", userId, "google"]) {
    directory = path.join(directory, component);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("Google account directories cannot be symbolic links");
    }
    directories.push(directory);
  }
  if ((fs.statSync(directory).mode & 0o077) !== 0) {
    throw new Error("Google account directory must be private (0700)");
  }
  /** Refuse replaced account directories as well as symlinked credential files. */
  const assertDirectories = () => {
    for (const current of directories) {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error("Google account directories cannot be symbolic links");
      }
    }
    if ((fs.statSync(directory).mode & 0o077) !== 0) {
      throw new Error("Google account directory must be private (0700)");
    }
  };
  const fileFor = (account: string) => {
    assertDirectories();
    return path.join(directory, `${identifier(account)}.json`);
  };
  const read = (file: string): GoogleTokens => {
    assertDirectories();
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 65_536 || (stat.mode & 0o077) !== 0) {
        throw new Error("Google credential file must be a private regular file");
      }
      try {
        return tokenRecord(JSON.parse(fs.readFileSync(fd, "utf8")));
      } catch {
        throw new Error("Invalid Google credentials");
      }
    } finally {
      fs.closeSync(fd);
    }
  };
  return {
    list() {
      assertDirectories();
      return fs.readdirSync(directory).filter((name) => /^[a-zA-Z0-9_-]+\.json$/.test(name)).map((name) => name.slice(0, -5)).sort();
    },
    saveNew(account, tokens) {
      const file = fileFor(account);
      const temporary = path.join(directory, `${crypto.randomUUID()}.new`);
      try {
        writeJsonAtomic(temporary, tokenRecord(tokens));
        try {
          fs.linkSync(temporary, file);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            throw new Error("Google account already exists; use a new alias to sign in again");
          }
          throw error;
        }
        const fd = fs.openSync(directory, "r");
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      } finally {
        fs.rmSync(temporary, { force: true });
      }
    },
    async accessToken(account, signal) {
      signal?.throwIfAborted();
      const file = fileFor(account);
      if (!fs.existsSync(file)) {
        throw new Error("Google account is not connected; use the operator CLI");
      }
      const release = await lock(file, { realpath: false, stale: 60_000, retries: { retries: 20, minTimeout: 50, maxTimeout: 250 } });
      try {
        signal?.throwIfAborted();
        const tokens = read(file);
        if (tokens.expires_at > Date.now() + 60_000) {
          return tokens.access_token;
        }
        const result = await googleJson("https://oauth2.googleapis.com/token", {
          method: "POST",
          body: new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, refresh_token: tokens.refresh_token, grant_type: "refresh_token" }),
        }, signal);
        const updated = tokenRecord({ ...tokens, access_token: result.access_token, refresh_token: result.refresh_token ?? tokens.refresh_token, expires_at: expiresAt(result) });
        signal?.throwIfAborted();
        assertDirectories();
        writeJsonAtomic(file, updated);
        return updated.access_token;
      } finally {
        await release();
      }
    },
  };
}

/** Start operator-only loopback OAuth with random state, PKCE, and a bounded callback lifetime. */
export async function startGoogleLogin(store: GoogleAccountStore, account: string, client: GoogleClient, options: { port?: number; email?: string; timeoutMs?: number } = {}) {
  identifier(account);
  if (store.list().includes(account)) {
    throw new Error("Google account already exists; use a new alias to sign in again");
  }
  const state = crypto.randomBytes(32).toString("base64url");
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const controller = new AbortController();
  let resolveWait!: () => void;
  let rejectWait!: (error: Error) => void;
  let settled = false;
  let accepted = false;
  let redirectUri = "";
  const wait = new Promise<void>((resolve, reject) => { resolveWait = resolve; rejectWait = reject; });
  // The CLI prints the URL before awaiting; attach a handler for failures during that interval.
  void wait.catch(() => {});
  const server = http.createServer(async (request, response) => {
    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://127.0.0.1");
    } catch {
      response.writeHead(400).end("Invalid OAuth callback");
      return;
    }
    const received = url.searchParams.get("state") ?? "";
    const validState = Buffer.byteLength(received) === Buffer.byteLength(state)
      && crypto.timingSafeEqual(Buffer.from(received), Buffer.from(state));
    const code = url.searchParams.get("code");
    if (request.method !== "GET" || url.pathname !== "/oauth/google" || !validState || accepted || url.searchParams.getAll("state").length !== 1) {
      response.writeHead(400).end("Invalid OAuth callback");
      return;
    }
    if (url.searchParams.has("error")) {
      accepted = true;
      settled = true;
      clearTimeout(timer);
      response.writeHead(400).end("Google authorization declined");
      rejectWait(new Error("Google authorization declined"));
      server.close();
      return;
    }
    if (url.searchParams.getAll("code").length !== 1 || !code || code.length > 4096) {
      response.writeHead(400).end("Invalid OAuth callback");
      return;
    }
    accepted = true;
    try {
      const result = await googleJson("https://oauth2.googleapis.com/token", {
        method: "POST", body: new URLSearchParams({ code, client_id: client.clientId, client_secret: client.clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code", code_verifier: verifier }),
      }, controller.signal);
      if (typeof result.access_token !== "string") {
        throw new Error("Missing access token");
      }
      const profile = await googleJson("https://www.googleapis.com/gmail/v1/users/me/profile", { headers: { Authorization: `Bearer ${result.access_token}` } }, controller.signal);
      if (typeof profile.emailAddress !== "string" || (options.email && profile.emailAddress.toLowerCase() !== options.email.toLowerCase())) {
        throw new Error("Google returned a different account");
      }
      controller.signal.throwIfAborted();
      store.saveNew(account, tokenRecord({ access_token: result.access_token, refresh_token: result.refresh_token, expires_at: expiresAt(result), email: profile.emailAddress }));
      settled = true;
      clearTimeout(timer);
      response.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" }).end("Google account connected. You may close this window.");
      resolveWait();
      server.close();
    } catch {
      settled = true;
      clearTimeout(timer);
      response.writeHead(400, { "content-type": "text/plain", "cache-control": "no-store" }).end("Google sign-in failed. Return to the operator terminal.");
      rejectWait(new Error("Google sign-in failed; existing credentials were not changed"));
      server.close();
    }
  });
  server.requestTimeout = 10_000;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.port ?? 19847, "127.0.0.1", resolve); });
  const address = server.address() as { port: number };
  redirectUri = `http://127.0.0.1:${address.port}/oauth/google`;
  const timer = setTimeout(() => {
    settled = true;
    controller.abort();
    server.closeAllConnections();
    server.close();
    rejectWait(new Error("Google sign-in timed out"));
  }, options.timeoutMs ?? 300_000);
  const params = new URLSearchParams({ client_id: client.clientId, redirect_uri: redirectUri, response_type: "code", access_type: "offline", prompt: "consent", state, code_challenge: challenge, code_challenge_method: "S256",
    scope: "https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/webmasters" });
  if (options.email) {
    params.set("login_hint", options.email);
  }
  return {
    authUrl: `https://accounts.google.com/o/oauth2/v2/auth?${params}`, redirectUri, wait,
    async close() {
      clearTimeout(timer);
      controller.abort();
      if (!settled) {
        settled = true;
        rejectWait(new Error("Google sign-in cancelled"));
      }
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
