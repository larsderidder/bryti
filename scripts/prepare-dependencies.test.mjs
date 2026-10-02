import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { prepareDependencies } from "./prepare-dependencies.mjs";

/** Build dependency metadata fixtures without importing or downloading packages. */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "bryti-dependencies-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sdk = join(root, "node_modules/@earendil-works/pi-coding-agent");
  const replacement = join(root, "node_modules/brace-expansion");
  const bundled = join(sdk, "node_modules/brace-expansion");
  const minimatch = join(sdk, "node_modules/minimatch");
  for (const [directory, name, version] of [
    [sdk, "@earendil-works/pi-coding-agent", "0.99.1"],
    [replacement, "brace-expansion", "5.0.12"],
    [bundled, "brace-expansion", "5.0.9"],
    [minimatch, "minimatch", "10.2.6"],
  ]) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "package.json"), JSON.stringify({ name, version, main: "index.js" }));
    writeFileSync(join(directory, "index.js"), "throw new Error('Dependency code must not execute');\n");
  }
  const lock = join(root, "package-lock.json");
  writeFileSync(lock, "locked graph\n");
  return { root, sdk, replacement, bundled, lock };
}

test("removes only the obsolete bundled copy and preserves the lock", (t) => {
  const paths = fixture(t);
  assert.deepEqual(prepareDependencies(paths.root), { sdk: "0.99.1", braceExpansion: "5.0.12" });
  assert.equal(existsSync(paths.bundled), false);
  assert.equal(existsSync(paths.replacement), true);
  assert.equal(readFileSync(paths.lock, "utf8"), "locked graph\n");
  assert.deepEqual(prepareDependencies(paths.root), { sdk: "0.99.1", braceExpansion: "5.0.12" });
});

test("missing replacement never deletes the bundled package", (t) => {
  const paths = fixture(t);
  rmSync(paths.replacement, { recursive: true });
  assert.throws(() => prepareDependencies(paths.root), /ENOENT/);
  assert.equal(existsSync(paths.bundled), true);
});

test("unexpected replacement version fails before deletion", (t) => {
  const paths = fixture(t);
  writeFileSync(join(paths.replacement, "package.json"), JSON.stringify({ name: "brace-expansion", version: "5.0.9" }));
  assert.throws(() => prepareDependencies(paths.root), /pinned brace-expansion/);
  assert.equal(existsSync(paths.bundled), true);
});

test("unexpected bundled package is retained for review", (t) => {
  const paths = fixture(t);
  writeFileSync(join(paths.bundled, "package.json"), JSON.stringify({ name: "other-package", version: "5.0.9" }));
  assert.throws(() => prepareDependencies(paths.root), /Unexpected SDK bundled/);
  assert.equal(existsSync(paths.bundled), true);
});

test("changed SDK version needs a fresh review", (t) => {
  const paths = fixture(t);
  writeFileSync(join(paths.sdk, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.0.0" }));
  assert.throws(() => prepareDependencies(paths.root), /changing the pi SDK/);
  assert.equal(existsSync(paths.bundled), true);
});

test("symlinked dependency directories are never followed or removed", (t) => {
  const paths = fixture(t);
  rmSync(paths.bundled, { recursive: true });
  symlinkSync(paths.replacement, paths.bundled);
  assert.throws(() => prepareDependencies(paths.root), /canonical directories/);
  assert.equal(existsSync(join(paths.replacement, "index.js")), true);
});
