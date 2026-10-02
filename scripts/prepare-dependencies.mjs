import { lstatSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Require an ordinary dependency directory within this installation. */
function dependencyDirectory(root, relativePath) {
  const path = resolve(root, relativePath);
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(path) !== path) {
    throw new Error("Dependency preparation requires canonical directories");
  }
  return path;
}

/** Read package identity without loading dependency code. */
function packageIdentity(directory) {
  const path = resolve(directory, "package.json");
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw new Error("Dependency package metadata must be a regular file");
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Remove the SDK's obsolete bundled copy so minimatch uses the pinned root package. */
export function prepareDependencies(directory) {
  const root = realpathSync(directory);
  dependencyDirectory(root, "node_modules");
  dependencyDirectory(root, "node_modules/@earendil-works");
  const sdk = dependencyDirectory(root, "node_modules/@earendil-works/pi-coding-agent");
  const sdkPackage = packageIdentity(sdk);
  if (sdkPackage.name !== "@earendil-works/pi-coding-agent" || sdkPackage.version !== "0.99.1") {
    throw new Error("Review bundled dependency preparation when changing the pi SDK");
  }
  const replacement = dependencyDirectory(root, "node_modules/brace-expansion");
  const replacementPackage = packageIdentity(replacement);
  if (replacementPackage.name !== "brace-expansion" || replacementPackage.version !== "5.0.12") {
    throw new Error("The pinned brace-expansion replacement is not installed");
  }
  const bundledModules = dependencyDirectory(root, "node_modules/@earendil-works/pi-coding-agent/node_modules");
  const bundledPath = resolve(bundledModules, "brace-expansion");
  let bundledInfo;
  try {
    bundledInfo = lstatSync(bundledPath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  if (bundledInfo) {
    dependencyDirectory(root, "node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion");
    const bundledPackage = packageIdentity(bundledPath);
    if (bundledPackage.name !== "brace-expansion" || bundledPackage.version !== "5.0.9") {
      throw new Error("Unexpected SDK bundled brace-expansion; review before replacing it");
    }
    rmSync(bundledPath, { recursive: true });
  }
  const sdkRequire = createRequire(resolve(sdk, "package.json"));
  const minimatchRequire = createRequire(sdkRequire.resolve("minimatch"));
  const resolvedBrace = minimatchRequire.resolve("brace-expansion");
  if (!resolvedBrace.startsWith(`${replacement}/`)) {
    throw new Error("SDK minimatch does not resolve the pinned brace-expansion package");
  }
  return { sdk: sdkPackage.version, braceExpansion: replacementPackage.version };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(prepareDependencies(fileURLToPath(new URL("../", import.meta.url)))));
}
