import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGoogleAccountStore, startGoogleLogin } from "./google-auth.js";

let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), "bryti-google-test-")); });
afterEach(() => { vi.unstubAllGlobals(); fs.rmSync(directory, { recursive: true, force: true }); });

/** Exercise the operator-only loopback callback without calling Google. */
function callback(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => { response.resume(); response.on("end", () => resolve(response.statusCode!)); }).on("error", reject);
  });
}

const tokens = { access_token: "test-access", refresh_token: "test-refresh", expires_at: 0, email: "owner@example.test" };
const client = { clientId: "test-client", clientSecret: "test-secret" };

describe("private Google accounts", () => {
  it("isolates users and accounts and writes private credentials", () => {
    const first = createGoogleAccountStore(directory, "user-1", client);
    const second = createGoogleAccountStore(directory, "user-2", client);
    first.saveNew("personal", tokens);
    first.saveNew("work", { ...tokens, email: "work@example.test" });
    expect(first.list()).toEqual(["personal", "work"]);
    expect(second.list()).toEqual([]);
    const file = path.join(directory, "users/user-1/google/personal.json");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(() => first.saveNew("personal", tokens)).toThrow("already exists");
  });

  it("rejects path traversal and symbolic-link account directories", () => {
    expect(() => createGoogleAccountStore(directory, "../other", client)).toThrow();
    const store = createGoogleAccountStore(directory, "user-1", client);
    expect(() => store.saveNew("../other", tokens)).toThrow();
    const target = path.join(directory, "outside");
    fs.mkdirSync(target);
    fs.mkdirSync(path.join(directory, "users/user-2"), { recursive: true });
    fs.symlinkSync(target, path.join(directory, "users/user-2/google"));
    expect(() => createGoogleAccountStore(directory, "user-2", client)).toThrow("symbolic");
  });

  it("refuses directories replaced by symbolic links after account-store creation", () => {
    const store = createGoogleAccountStore(directory, "user-1", client);
    const outside = path.join(directory, "outside");
    fs.mkdirSync(outside, { mode: 0o700 });
    fs.rmSync(path.join(directory, "users/user-1/google"), { recursive: true });
    fs.symlinkSync(outside, path.join(directory, "users/user-1/google"));
    expect(() => store.saveNew("personal", tokens)).toThrow("symbolic");
    expect(() => store.list()).toThrow("symbolic");
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("serializes token refresh and preserves the refresh token", async () => {
    const store = createGoogleAccountStore(directory, "user-1", client);
    store.saveNew("personal", tokens);
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ access_token: "new-access", expires_in: 3600 }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetcher);
    expect(await Promise.all([store.accessToken("personal"), store.accessToken("personal")])).toEqual(["new-access", "new-access"]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fs.readFileSync(path.join(directory, "users/user-1/google/personal.json"), "utf8")).refresh_token).toBe("test-refresh");
  });

  it("does not rewrite credentials or expose response bodies after refresh failure", async () => {
    const store = createGoogleAccountStore(directory, "user-1", client);
    store.saveNew("personal", tokens);
    const file = path.join(directory, "users/user-1/google/personal.json");
    const before = fs.readFileSync(file, "utf8");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("provider response containing secret data", { status: 400 })));
    await expect(store.accessToken("personal")).rejects.toThrow("Google request failed (400)");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("keeps the existing account unchanged when the provider returns an invalid token lifetime", async () => {
    const store = createGoogleAccountStore(directory, "user-1", client);
    store.saveNew("personal", tokens);
    const file = path.join(directory, "users/user-1/google/personal.json");
    const before = fs.readFileSync(file, "utf8");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ access_token: "new-access", expires_in: -1 }))));
    await expect(store.accessToken("personal")).rejects.toThrow("token lifetime");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("refuses credential writes if the account directory changes during token refresh", async () => {
    const store = createGoogleAccountStore(directory, "user-1", client);
    store.saveNew("personal", tokens);
    const googleDirectory = path.join(directory, "users/user-1/google");
    const outside = path.join(directory, "outside");
    fs.mkdirSync(outside, { mode: 0o700 });
    vi.stubGlobal("fetch", vi.fn(async () => {
      fs.renameSync(googleDirectory, path.join(directory, "saved-google"));
      fs.symlinkSync(outside, googleDirectory);
      return new Response(JSON.stringify({ access_token: "new-access", expires_in: 3600 }));
    }));
    await expect(store.accessToken("personal")).rejects.toThrow("symbolic");
    expect(fs.readdirSync(outside)).toEqual([]);
  });
});

describe("operator Google sign-in", () => {
  it("validates callback state and exchanges a PKCE-bound code", async () => {
    const store = createGoogleAccountStore(directory, "user-1", client);
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes("/token")) {
        expect(new URLSearchParams(init.body as URLSearchParams).get("code_verifier")?.length).toBeGreaterThanOrEqual(43);
        return new Response(JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }));
      }
      return new Response(JSON.stringify({ emailAddress: "owner@example.test" }));
    });
    vi.stubGlobal("fetch", fetcher);
    const flow = await startGoogleLogin(store, "personal", client, { port: 0, email: "owner@example.test" });
    try {
      const auth = new URL(flow.authUrl);
      expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
      expect(auth.searchParams.get("login_hint")).toBe("owner@example.test");
      expect(await callback(`${flow.redirectUri}?code=test-code&state=wrong`)).toBe(400);
      expect(fetcher).not.toHaveBeenCalled();
      expect(await callback(`${flow.redirectUri}?code=test-code&state=${auth.searchParams.get("state")}`)).toBe(200);
      await flow.wait;
      expect(store.list()).toEqual(["personal"]);
    } finally {
      await flow.close();
    }
  });

  it("never overwrites an already connected account", async () => {
    const store = createGoogleAccountStore(directory, "user-1", client);
    store.saveNew("personal", tokens);
    await expect(startGoogleLogin(store, "personal", client, { port: 0 })).rejects.toThrow("already exists");
  });

  it("handles declined authorization without accepting a code or waiting for the timeout", async () => {
    const store = createGoogleAccountStore(directory, "user-1", client);
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const flow = await startGoogleLogin(store, "personal", client, { port: 0, timeoutMs: 1000 });
    try {
      const state = new URL(flow.authUrl).searchParams.get("state");
      expect(await callback(`${flow.redirectUri}?error=access_denied&state=${state}`)).toBe(400);
      await expect(flow.wait).rejects.toThrow("declined");
      expect(fetcher).not.toHaveBeenCalled();
      expect(store.list()).toEqual([]);
    } finally {
      await flow.close();
    }
  });

  it("refuses an account that does not match the operator's selected email", async () => {
    const store = createGoogleAccountStore(directory, "user-1", client);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/token")) {
        return new Response(JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }));
      }
      return new Response(JSON.stringify({ emailAddress: "other@example.test" }));
    }));
    const flow = await startGoogleLogin(store, "personal", client, { port: 0, email: "owner@example.test" });
    try {
      const state = new URL(flow.authUrl).searchParams.get("state");
      expect(await callback(`${flow.redirectUri}?code=test-code&state=${state}`)).toBe(400);
      await expect(flow.wait).rejects.toThrow("sign-in failed");
      expect(store.list()).toEqual([]);
    } finally {
      await flow.close();
    }
  });

  it("does not persist credentials after cancellation even if the transport completes late", async () => {
    const store = createGoogleAccountStore(directory, "user-1", client);
    const save = vi.spyOn(store, "saveNew");
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    let finish!: (response: Response) => void;
    const tokenReply = new Promise<Response>((resolve) => { finish = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/token")) {
        started();
        return tokenReply;
      }
      return new Response(JSON.stringify({ emailAddress: "owner@example.test" }));
    }));
    const flow = await startGoogleLogin(store, "personal", client, { port: 0, timeoutMs: 1000 });
    try {
      const state = new URL(flow.authUrl).searchParams.get("state");
      const request = callback(`${flow.redirectUri}?code=test-code&state=${state}`).catch(() => 0);
      await ready;
      const closing = flow.close();
      finish(new Response(JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_in: 3600 })));
      await closing;
      await request;
      await expect(flow.wait).rejects.toThrow("cancelled");
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(save).not.toHaveBeenCalled();
      expect(store.list()).toEqual([]);
    } finally {
      await flow.close();
    }
  });
});
