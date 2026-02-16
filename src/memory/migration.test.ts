/**
 * Tests for memory migration.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createSearchableMemoryManager, needsMigration } from "./searchable-memory.js";
import path from "node:path";
import fs from "node:fs";

describe("Memory Migration", () => {
  const testDir = path.join(process.cwd(), ".test-data", "migration");
  const userId = "test-user";

  beforeEach(() => {
    // Clean up test directory
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up after tests
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  describe("createSearchableMemoryManager", () => {
    it("creates memory manager with empty memory", async () => {
      const manager = await createSearchableMemoryManager(testDir, userId);

      const content = await manager.read();
      expect(content).toBe("");

      manager.store.close();
    });

    it("loads existing memory.md content", async () => {
      // Create memory.md before creating manager
      const memoryPath = path.join(testDir, "memory.md");
      fs.writeFileSync(memoryPath, "# Test\nTest content", "utf-8");

      const manager = await createSearchableMemoryManager(testDir, userId);

      const content = await manager.read();
      expect(content).toContain("Test content");

      manager.store.close();
    });

    it("migrates existing memory.md to SQLite", async () => {
      // Create memory.md with content
      const memoryPath = path.join(testDir, "memory.md");
      const content = "# Preferences\nLikes coffee";
      fs.writeFileSync(memoryPath, content, "utf-8");

      const manager = await createSearchableMemoryManager(testDir, userId);

      // Should be searchable
      const results = await manager.search("coffee");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].content).toContain("coffee");

      manager.store.close();
    });

    it("handles update to memory.md", async () => {
      const memoryPath = path.join(testDir, "memory.md");
      fs.writeFileSync(memoryPath, "Initial content", "utf-8");

      const manager = await createSearchableMemoryManager(testDir, userId);

      // Update memory
      await manager.update("Updated content");

      const newContent = await manager.read();
      expect(newContent).toBe("Updated content");

      manager.store.close();
    });

    it("records facts for search", async () => {
      const manager = await createSearchableMemoryManager(testDir, userId);

      await manager.recordFact("Meeting with Alice on Friday");

      const results = await manager.search("Alice");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].content).toContain("Alice");

      manager.store.close();
    });
  });

  describe("needsMigration", () => {
    it("returns true when no database exists", () => {
      const result = needsMigration(testDir, "new-user");
      expect(result).toBe(true);
    });

    it("returns false when database exists", async () => {
      // First create a database
      const manager = await createSearchableMemoryManager(testDir, userId);
      manager.store.close();

      // Now check - should be false
      const result = needsMigration(testDir, userId);
      expect(result).toBe(false);
    });
  });
});
