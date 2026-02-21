/**
 * Core memory storage, always in context.
 */

import fs from "node:fs";
import path from "node:path";

export interface CoreMemory {
  /** Read the full core memory content. */
  read(): string;

  /** Append content under a section heading. Creates section if it doesn't exist. */
  append(section: string, content: string): { ok: true } | { ok: false; error: string };

  /** Replace text within a section. */
  replace(section: string, oldText: string, newText: string): { ok: true } | { ok: false; error: string };

  /** File path for inspection/debugging. */
  readonly filePath: string;
}

const CORE_MEMORY_MAX_BYTES = 4096;
const CORE_MEMORY_FULL_MESSAGE =
  "Core memory is full (4KB limit). Move less important information to archival memory using memory_archival_insert.";

function readFile(filePath: string): string {
  if (!fs.existsSync(filePath)) {
    return "";
  }

  return fs.readFileSync(filePath, "utf-8");
}

function writeFile(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content, "utf-8");
}

function findSection(lines: string[], section: string): { headingIndex: number; nextHeadingIndex: number } | null {
  const headingLine = `## ${section}`;
  const headingIndex = lines.findIndex((line) => line === headingLine);

  if (headingIndex === -1) {
    return null;
  }

  let nextHeadingIndex = lines.length;
  for (let i = headingIndex + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) {
      nextHeadingIndex = i;
      break;
    }
  }

  return { headingIndex, nextHeadingIndex };
}

function buildContent(lines: string[]): string {
  return lines.join("\n");
}

/**
 * Create a core memory instance backed by a markdown file.
 */
export function createCoreMemory(dataDir: string): CoreMemory {
  const filePath = path.join(dataDir, "core-memory.md");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const legacyPath = path.join(dataDir, "memory.md");
  if (!fs.existsSync(filePath) && fs.existsSync(legacyPath)) {
    fs.copyFileSync(legacyPath, filePath);
    console.log("Migrated memory.md to core-memory.md");
  }

  return {
    filePath,

    read(): string {
      return readFile(filePath);
    },

    append(section: string, content: string): { ok: true } | { ok: false; error: string } {
      if (!content) {
        return { ok: true };
      }

      const existing = readFile(filePath);
      const lines = existing === "" ? [] : existing.split("\n");
      const sectionInfo = findSection(lines, section);
      const contentLines = content.split("\n");

      let updatedLines = [...lines];

      if (!sectionInfo) {
        if (updatedLines.length > 0 && updatedLines[updatedLines.length - 1] !== "") {
          updatedLines.push("");
        }
        updatedLines.push(`## ${section}`);
        updatedLines.push(...contentLines);
      } else {
        updatedLines.splice(sectionInfo.nextHeadingIndex, 0, ...contentLines);
      }

      const updatedContent = buildContent(updatedLines);
      if (Buffer.byteLength(updatedContent, "utf8") > CORE_MEMORY_MAX_BYTES) {
        return { ok: false, error: CORE_MEMORY_FULL_MESSAGE };
      }

      writeFile(filePath, updatedContent);
      return { ok: true };
    },

    replace(section: string, oldText: string, newText: string): { ok: true } | { ok: false; error: string } {
      const existing = readFile(filePath);
      const lines = existing === "" ? [] : existing.split("\n");
      const sectionInfo = findSection(lines, section);

      if (!sectionInfo) {
        return { ok: false, error: `Section '${section}' not found` };
      }

      const sectionLines = lines.slice(sectionInfo.headingIndex + 1, sectionInfo.nextHeadingIndex);
      const sectionContent = sectionLines.join("\n");

      if (!sectionContent.includes(oldText)) {
        return { ok: false, error: `Text not found in section '${section}'` };
      }

      const updatedSectionContent = sectionContent.replace(oldText, newText);
      const updatedSectionLines = updatedSectionContent === "" ? [] : updatedSectionContent.split("\n");

      const updatedLines = [
        ...lines.slice(0, sectionInfo.headingIndex + 1),
        ...updatedSectionLines,
        ...lines.slice(sectionInfo.nextHeadingIndex),
      ];

      const updatedContent = buildContent(updatedLines);
      writeFile(filePath, updatedContent);

      return { ok: true };
    },
  };
}
