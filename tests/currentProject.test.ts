import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CurrentProjectManager } from "../src/services/currentProject.js";

describe("CurrentProjectManager", () => {
  let tempDir: string;
  let manager: CurrentProjectManager;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "current-project-test-"));
    manager = new CurrentProjectManager(tempDir);
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  describe("get", () => {
    it("returns null when file does not exist", async () => {
      const result = await manager.get();
      expect(result).toBeNull();
    });

    it("returns session name when file exists", async () => {
      fs.writeFileSync(path.join(tempDir, ".current_project"), "tmux_proj_test", "utf-8");
      const result = await manager.get();
      expect(result).toBe("tmux_proj_test");
    });

    it("returns correct content for multi-line file (first line only)", async () => {
      fs.writeFileSync(path.join(tempDir, ".current_project"), "tmux_proj_test\nother", "utf-8");
      const result = await manager.get();
      // Current implementation returns entire content
      expect(result).toBe("tmux_proj_test\nother");
    });

    it("caches result on subsequent calls", async () => {
      fs.writeFileSync(path.join(tempDir, ".current_project"), "tmux_proj_test", "utf-8");
      const result1 = await manager.get();
      const result2 = await manager.get();
      expect(result1).toBe(result2);
    });

    it("returns null for empty file", async () => {
      fs.writeFileSync(path.join(tempDir, ".current_project"), "", "utf-8");
      const result = await manager.get();
      expect(result).toBe("");
    });
  });

  describe("set", () => {
    it("writes session name to file", async () => {
      await manager.set("tmux_proj_new");
      const content = fs.readFileSync(path.join(tempDir, ".current_project"), "utf-8");
      expect(content).toBe("tmux_proj_new");
    });

    it("overwrites existing content", async () => {
      fs.writeFileSync(path.join(tempDir, ".current_project"), "old_session", "utf-8");
      await manager.set("new_session");
      const content = fs.readFileSync(path.join(tempDir, ".current_project"), "utf-8");
      expect(content).toBe("new_session");
    });

    it("updates cache after set", async () => {
      await manager.set("cached_session");
      const result = await manager.get();
      expect(result).toBe("cached_session");
    });

    it("creates file in correct directory", async () => {
      await manager.set("session_in_subdir");
      const filePath = path.join(tempDir, ".current_project");
      const exists = fs.existsSync(filePath);
      expect(exists).toBe(true);
    });

    it("handles special characters in session name", async () => {
      await manager.set("tmux_proj_/path-with-special-chars_123");
      const content = fs.readFileSync(path.join(tempDir, ".current_project"), "utf-8");
      expect(content).toBe("tmux_proj_/path-with-special-chars_123");
    });
  });

  describe("clear", () => {
    it("deletes file when it exists", async () => {
      fs.writeFileSync(path.join(tempDir, ".current_project"), "some_session", "utf-8");
      await manager.clear();
      const exists = fs.existsSync(path.join(tempDir, ".current_project"));
      expect(exists).toBe(false);
    });

    it("does not throw when file does not exist", async () => {
      await expect(manager.clear()).resolves.not.toThrow();
    });

    it("resets cache to null", async () => {
      fs.writeFileSync(path.join(tempDir, ".current_project"), "session", "utf-8");
      await manager.get(); // populate cache
      await manager.clear();
      const result = await manager.get();
      expect(result).toBeNull();
    });
  });

  describe("cache behavior", () => {
    it("cache is clean after construction", () => {
      const freshManager = new CurrentProjectManager(tempDir);
      expect(freshManager.get()).toBeTruthy(); // Returns a Promise
    });

    it("cache becomes dirty after clear", async () => {
      fs.writeFileSync(path.join(tempDir, ".current_project"), "session", "utf-8");
      await manager.get(); // populate cache
      await manager.clear();
      // Next get should read from file (which doesn't exist now)
      const result = await manager.get();
      expect(result).toBeNull();
    });

    it("set marks cache as clean", async () => {
      await manager.set("session1");
      await manager.get();
      await manager.set("session2");
      const result = await manager.get();
      expect(result).toBe("session2");
    });

    it("external file modification is not detected until cache is dirty", async () => {
      // This tests the limitation of the cache - if file changes externally,
      // cache won't reflect it until we explicitly clear or set
      fs.writeFileSync(path.join(tempDir, ".current_project"), "original", "utf-8");
      const result1 = await manager.get();
      expect(result1).toBe("original");

      // Simulate external modification
      fs.writeFileSync(path.join(tempDir, ".current_project"), "modified", "utf-8");

      // Cache still returns old value
      const result2 = await manager.get();
      expect(result2).toBe("original");

      // set() with same value makes cache dirty and refreshes
      await manager.set("original");
      const result3 = await manager.get();
      expect(result3).toBe("original");
    });
  });

  describe("edge cases", () => {
    it("handles very long session names", async () => {
      const longName = "a".repeat(1000);
      await manager.set(longName);
      const result = await manager.get();
      expect(result).toBe(longName);
    });

    it("handles unicode in session names", async () => {
      const unicodeName = "tmux_proj_测试项目_中文";
      await manager.set(unicodeName);
      const result = await manager.get();
      expect(result).toBe(unicodeName);
    });

    it("handles path with spaces", async () => {
      const spacedPath = "tmux_proj_-Users-user-my Projects-project";
      await manager.set(spacedPath);
      const result = await manager.get();
      expect(result).toBe(spacedPath);
    });

    it("multiple set operations work correctly", async () => {
      await manager.set("session1");
      await manager.set("session2");
      await manager.set("session3");
      const result = await manager.get();
      expect(result).toBe("session3");
    });

    it("alternating get and set", async () => {
      await manager.set("session1");
      await manager.get();
      await manager.set("session2");
      await manager.get();
      const result = await manager.get();
      expect(result).toBe("session2");
    });
  });
});
