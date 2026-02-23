/**
 * Skill installation tool. Fetches a skill from a URL or local path
 * and installs it into data/skills/.
 *
 * Supports:
 * - Raw URL to a SKILL.md file → saves as skills/<name>/SKILL.md
 * - GitHub/GitLab directory URL → fetches SKILL.md (and referenced files)
 * - Local absolute path → copies the directory
 */

import fs from "node:fs";
import path from "node:path";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { toolError, toolSuccess } from "./result.js";
import { isPrivateHostname } from "../util/ssrf.js";

const skillInstallSchema = Type.Object({
  name: Type.String({
    description: "Short name for the skill (used as directory name, e.g. 'scribe', 'linkedin')",
  }),
  source: Type.String({
    description:
      "URL to a SKILL.md file, a GitHub directory URL, or an absolute local path to a skill directory",
  }),
});

/**
 * Try to fetch a raw URL. Returns the body text or null.
 */
async function fetchText(url: string, timeoutMs = 15_000): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

/**
 * Convert a GitHub directory URL to the raw URL for SKILL.md.
 * Handles: github.com/<owner>/<repo>/tree/<branch>/<path>
 */
function githubRawUrl(url: string): string | null {
  const match = url.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:tree|blob)\/([^/]+)\/(.+)/,
  );
  if (!match) return null;
  const [, owner, repo, branch, filePath] = match;
  // If URL points to a directory, append SKILL.md
  const target = filePath.endsWith(".md") ? filePath : `${filePath}/SKILL.md`;
  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${target}`;
}

/**
 * Convert a GitLab directory URL to the raw URL for SKILL.md.
 * Handles: gitlab.com/<owner>/<repo>/-/tree/<branch>/<path>
 */
function gitlabRawUrl(url: string): string | null {
  const match = url.match(
    /^https?:\/\/gitlab\.com\/([^/]+)\/([^/]+)\/-\/(?:tree|blob)\/([^/]+)\/(.+)/,
  );
  if (!match) return null;
  const [, owner, repo, branch, filePath] = match;
  const target = filePath.endsWith(".md") ? filePath : `${filePath}/SKILL.md`;
  return `https://gitlab.com/${owner}/${repo}/-/raw/${branch}/${target}`;
}

export function createSkillInstallTool(dataDir: string): AgentTool<typeof skillInstallSchema> {
  const skillsDir = path.join(dataDir, "skills");

  return {
    name: "skill_install",
    label: "skill_install",
    description:
      "Install a skill from a URL or local path. Skills are instruction sets that teach you " +
      "how to handle specific tasks. After installing, call system_restart to load the skill. " +
      "Accepts: a direct URL to a SKILL.md file, a GitHub/GitLab directory URL containing " +
      "a SKILL.md, or an absolute local filesystem path to a skill directory.",
    parameters: skillInstallSchema,

    async execute(
      _toolCallId: string,
      { name, source }: { name: string; source: string },
    ): Promise<AgentToolResult<unknown>> {
      // Validate skill name (directory-safe)
      if (!/^[a-z0-9_-]+$/.test(name)) {
        return toolError(
          "Skill name must be lowercase alphanumeric with hyphens or underscores only.",
        );
      }

      const targetDir = path.join(skillsDir, name);

      // --- Local path ---
      if (source.startsWith("/")) {
        if (!fs.existsSync(source)) {
          return toolError(`Path not found: ${source}`);
        }

        const stat = fs.statSync(source);
        if (stat.isDirectory()) {
          // Check for SKILL.md
          const skillMd = path.join(source, "SKILL.md");
          if (!fs.existsSync(skillMd)) {
            return toolError(`No SKILL.md found in ${source}`);
          }
          // Copy the entire directory
          fs.cpSync(source, targetDir, { recursive: true });
          return toolSuccess({
            installed: name,
            path: targetDir,
            files: fs.readdirSync(targetDir),
            message: `Skill "${name}" installed. Call system_restart to load it.`,
          });
        } else if (stat.isFile()) {
          // Single file, treat as SKILL.md
          fs.mkdirSync(targetDir, { recursive: true });
          fs.copyFileSync(source, path.join(targetDir, "SKILL.md"));
          return toolSuccess({
            installed: name,
            path: targetDir,
            files: ["SKILL.md"],
            message: `Skill "${name}" installed from file. Call system_restart to load it.`,
          });
        }
        return toolError(`Source is neither a file nor a directory: ${source}`);
      }

      // --- URL ---
      if (!source.startsWith("http://") && !source.startsWith("https://")) {
        return toolError(
          "Source must be an absolute local path (starting with /) or a URL (starting with http).",
        );
      }

      // SSRF protection: reject private/internal URLs
      if (isPrivateHostname(source)) {
        return toolError("Cannot fetch from private or internal URLs.");
      }

      // Try GitHub/GitLab directory URL conversion
      let rawUrl = githubRawUrl(source) ?? gitlabRawUrl(source);

      // If it's a direct URL (not GitHub/GitLab tree), use as-is
      if (!rawUrl) {
        rawUrl = source;
      }

      const content = await fetchText(rawUrl);
      if (!content) {
        return toolError(
          `Could not fetch skill from ${rawUrl}. Check the URL is accessible and points to a SKILL.md file.`,
        );
      }

      // Basic validation: should look like a skill file
      if (!content.includes("SKILL") && !content.includes("skill") && !content.includes("---")) {
        return toolError(
          "Fetched content doesn't look like a SKILL.md file (no frontmatter or skill markers found).",
        );
      }

      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(path.join(targetDir, "SKILL.md"), content, "utf-8");

      return toolSuccess({
        installed: name,
        path: targetDir,
        files: ["SKILL.md"],
        message: `Skill "${name}" installed from URL. Call system_restart to load it.`,
      });
    },
  };
}
