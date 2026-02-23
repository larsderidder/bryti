/**
 * Startup update check: notifies the operator when a newer version of
 * @bryti/agent is available on npm.
 *
 * Fire-and-forget. Never blocks startup. Failures are silently swallowed.
 * Results are cached for 24h in data/.update-check so we don't hit the
 * registry on every restart.
 *
 * Set BRYTI_NO_UPDATE_CHECK=1 to disable (CI, Docker, etc.).
 */

import fs from "node:fs";
import path from "node:path";

const REGISTRY_URL = "https://registry.npmjs.org/@bryti/agent/latest";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface CacheEntry {
  checkedAt: number;
  latestVersion: string;
}

function readCache(dataDir: string): CacheEntry | null {
  try {
    const raw = fs.readFileSync(path.join(dataDir, ".update-check"), "utf-8");
    return JSON.parse(raw) as CacheEntry;
  } catch {
    return null;
  }
}

function writeCache(dataDir: string, entry: CacheEntry): void {
  try {
    fs.writeFileSync(
      path.join(dataDir, ".update-check"),
      JSON.stringify(entry),
      "utf-8",
    );
  } catch {
    // Non-fatal.
  }
}

/**
 * Compare two semver strings. Returns true if `latest` is strictly newer
 * than `current`. Only handles simple X.Y.Z — no pre-release tags.
 */
function isNewer(current: string, latest: string): boolean {
  const parse = (v: string) => v.replace(/^v/, "").split(".").map(Number);
  const [ca, cb, cc] = parse(current);
  const [la, lb, lc] = parse(latest);
  if (la !== ca) return la > ca;
  if (lb !== cb) return lb > cb;
  return lc > cc;
}

/**
 * Fetch the latest version from npm, respecting the 24h cache.
 * Returns null if the check cannot be completed.
 */
async function fetchLatestVersion(dataDir: string): Promise<string | null> {
  const cached = readCache(dataDir);
  if (cached && Date.now() - cached.checkedAt < CACHE_TTL_MS) {
    return cached.latestVersion;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);

  try {
    const res = await fetch(REGISTRY_URL, { signal: controller.signal });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    const latestVersion = data.version;
    if (!latestVersion) return null;
    writeCache(dataDir, { checkedAt: Date.now(), latestVersion });
    return latestVersion;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Check for a newer version and log a notice if one is available.
 * Fire-and-forget: call without awaiting.
 */
export async function checkForUpdate(
  currentVersion: string,
  dataDir: string,
): Promise<void> {
  if (process.env.BRYTI_NO_UPDATE_CHECK === "1") {
    return;
  }

  try {
    const latest = await fetchLatestVersion(dataDir);
    if (latest && isNewer(currentVersion, latest)) {
      console.log(
        `bryti v${latest} available (current: v${currentVersion}). ` +
        `Run \`npm update -g @bryti/agent\` to upgrade.`,
      );
    }
  } catch {
    // Never surface update check errors to the operator.
  }
}
