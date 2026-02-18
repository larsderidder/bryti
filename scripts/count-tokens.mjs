#!/usr/bin/env node
/**
 * Count LLM tokens in pibot source files and generate repo-tokens/badge.svg.
 *
 * Uses Python tiktoken (cl100k_base, same tokenizer family as Claude/GPT-4)
 * for an accurate count. Run this script whenever the codebase changes
 * significantly to keep the badge current.
 *
 * Usage: node scripts/count-tokens.mjs
 */

import { execSync } from "node:child_process";
import { readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "../..");
const SRC = join(ROOT, "src");
const OUT = join(ROOT, "repo-tokens", "badge.svg");

// ---------------------------------------------------------------------------
// Collect source files (non-test .ts)
// ---------------------------------------------------------------------------

function walk(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      files.push(...walk(full));
    } else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) {
      files.push(full);
    }
  }
  return files;
}

const files = walk(SRC).sort();
console.log(`Counting tokens in ${files.length} source files...`);

// ---------------------------------------------------------------------------
// Count via Python tiktoken
// ---------------------------------------------------------------------------

const pythonScript = `
import tiktoken, sys, json
enc = tiktoken.get_encoding('cl100k_base')
files = ${JSON.stringify(files)}
total = 0
for f in files:
    text = open(f, encoding='utf-8').read()
    total += len(enc.encode(text))
print(total)
`.trim();

let tokenCount;
try {
  const result = execSync(`python3 -c "${pythonScript.replace(/"/g, '\\"')}"`, {
    encoding: "utf-8",
  }).trim();
  tokenCount = parseInt(result, 10);
  if (isNaN(tokenCount)) throw new Error(`Bad output: ${result}`);
} catch (err) {
  console.warn("tiktoken unavailable, falling back to char/4 estimate:", err.message);
  // Fallback: sum file sizes and divide by 4
  const totalChars = files.reduce((sum, f) => {
    try { return sum + statSync(f).size; } catch { return sum; }
  }, 0);
  tokenCount = Math.round(totalChars / 4);
}

// ---------------------------------------------------------------------------
// Format and report
// ---------------------------------------------------------------------------

const k = (n) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

// Reference: Claude's largest context window (200k tokens)
const CONTEXT_WINDOW = 200_000;
const pct = ((tokenCount / CONTEXT_WINDOW) * 100).toFixed(1);

const label = "codebase size";
const value = `${k(tokenCount)} tokens · ${pct}% of 200k ctx`;

console.log(`Token count: ${tokenCount.toLocaleString()} (${pct}% of 200k context window)`);
console.log(`Badge value: ${value}`);

// ---------------------------------------------------------------------------
// Generate SVG (shields.io flat style)
// ---------------------------------------------------------------------------

// Approximate text widths at 11px Verdana (6.5px per char, plus padding)
const charWidth = 6.5;
const pad = 10;
const labelW = Math.round(label.length * charWidth + pad * 2);
const valueW = Math.round(value.length * charWidth + pad * 2);
const totalW = labelW + valueW;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="20">
  <title>${label}: ${value}</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <rect rx="3" width="${totalW}" height="20" fill="#555"/>
  <rect rx="3" x="${labelW}" width="${valueW}" height="20" fill="#007ec6"/>
  <rect x="${labelW}" width="4" height="20" fill="#007ec6"/>
  <rect rx="3" width="${totalW}" height="20" fill="url(#s)"/>
  <g fill="#fff" text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="11">
    <text x="${labelW / 2}" y="15" fill="#010101" fill-opacity=".3">${label}</text>
    <text x="${labelW / 2}" y="14">${label}</text>
    <text x="${labelW + valueW / 2}" y="15" fill="#010101" fill-opacity=".3">${value}</text>
    <text x="${labelW + valueW / 2}" y="14">${value}</text>
  </g>
</svg>`;

mkdirSync(join(ROOT, "repo-tokens"), { recursive: true });
writeFileSync(OUT, svg, "utf-8");
console.log(`Badge written to ${relative(ROOT, OUT)}`);
