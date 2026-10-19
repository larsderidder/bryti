import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cmdWebE2EEInvite, cmdWork } from "./cli.js";
import { invitesPath } from "./web-e2ee/invite-store.js";
import { createWorkStore } from "./work/store.js";
import { createProjectionStore } from "./projection/store.js";
import { scheduledWorkId } from "./projection/occurrence.js";

describe("CLI web-e2ee invite", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync("/tmp/bryti-cli-web-e2ee-");
    fs.writeFileSync(
      path.join(tempDir, "config.yml"),
      [
        'agent:',
        '  model: "test/local"',
        'telegram:',
        '  token: ""',
        '  allowed_users: []',
        'whatsapp:',
        '  enabled: false',
        '  allowed_users: []',
        'web_e2ee:',
        '  enabled: true',
        '  public_origin: "https://chat.example.test"',
        '  pairing:',
        '    invite_ttl_minutes: 15',
        'models:',
        '  providers:',
        '    - name: "test"',
        '      base_url: "http://127.0.0.1:1234"',
        '      api: "openai"',
        '      api_key: "test-key"',
        '      models: []',
      ].join("\n"),
      "utf-8",
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("prints one plaintext invite code and persists hash-only state", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const created = await cmdWebE2EEInvite(tempDir);
    const output = log.mock.calls.flat().join("\n");
    const rawInvites = fs.readFileSync(invitesPath(tempDir), "utf-8");

    expect(created.code).toMatch(/^[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}$/);
    expect(output).toContain(created.code);
    expect(output.indexOf(created.code)).toBe(output.lastIndexOf(created.code));
    expect(output).toContain(created.expiresAt);
    expect(fs.existsSync(invitesPath(tempDir))).toBe(true);
    expect(rawInvites).not.toContain(created.code);
    expect(rawInvites).toContain("sha256:");
  });
});

describe("CLI work recovery", () => {
  it("lists a paused occurrence and records a scoped operator review without replay", () => {
    const dir = fs.mkdtempSync("/tmp/bryti-cli-work-");
    const work = createWorkStore(dir);
    const projections = createProjectionStore("u", dir);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const id = projections.add({ summary: "Calendar", resolution: "exact", resolved_when: "2026-10-13 06:45", recurrence: "45 8 * * *" });
      const workId = scheduledWorkId("u", projections.getById(id)!);
      work.accept({ userId: "u", channelId: "chat", platform: "telegram", text: "Check calendar", workId, raw: { type: "projection_exact_check" } });
      work.claim([workId]);
      work.finish([workId], "interrupted");
      projections.markDeliveryWork(id, workId);
      cmdWork(dir, "u", "list");
      expect(JSON.parse(log.mock.calls.at(-1)![0])).toMatchObject({ schedules: [{ runtime: { state: "paused", execution: "interrupted" } }] });
      expect(() => cmdWork(dir, "other", "reconcile", workId, "Inspected")).toThrow(/user/i);
      expect(() => cmdWork(dir, "u", "reconcile", workId)).toThrow(/evidence/i);
      cmdWork(dir, "u", "reconcile", workId, "Read-only checks stopped; no unfinished external actions");
      cmdWork(dir, "u", "inspect", workId);
      expect(JSON.parse(log.mock.calls.at(-1)![0])).toMatchObject({ reconciled: true, execution: "interrupted" });
      expect(projections.getById(id)?.delivery_work_id).toBe(workId);
      expect(work.queued()).toEqual([]);
    } finally {
      log.mockRestore();
      work.close();
      projections.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
