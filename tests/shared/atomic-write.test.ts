import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFileAtomic, writeFileAtomicSync } from "../../src/shared/utils/atomic-write.js";

describe("atomic-write", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "atomic-write-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe("writeFileAtomicSync", () => {
    it("writes a new file", () => {
      const file = nodePath.join(dir, "a.json");
      writeFileAtomicSync(file, '{"k":1}');
      expect(fs.readFileSync(file, "utf-8")).toBe('{"k":1}');
    });

    it("replaces an existing file", () => {
      const file = nodePath.join(dir, "a.json");
      fs.writeFileSync(file, "old");
      writeFileAtomicSync(file, "new");
      expect(fs.readFileSync(file, "utf-8")).toBe("new");
    });

    it("creates missing parent directories", () => {
      const file = nodePath.join(dir, "x", "y", "a.txt");
      writeFileAtomicSync(file, "deep");
      expect(fs.readFileSync(file, "utf-8")).toBe("deep");
    });

    it("leaves no temp file behind on failure", () => {
      // Target is an existing directory → rename fails after the temp write.
      const target = nodePath.join(dir, "iam-a-dir");
      fs.mkdirSync(target);
      expect(() => writeFileAtomicSync(target, "x")).toThrow();
      const leftovers = fs.readdirSync(dir).filter((f) => f.includes(".tmp-"));
      expect(leftovers).toEqual([]);
    });
  });

  describe("writeFileAtomic (async)", () => {
    it("writes a new file", async () => {
      const file = nodePath.join(dir, "b.txt");
      await writeFileAtomic(file, "hello");
      expect(fs.readFileSync(file, "utf-8")).toBe("hello");
    });

    it("replaces an existing file", async () => {
      const file = nodePath.join(dir, "b.txt");
      fs.writeFileSync(file, "old");
      await writeFileAtomic(file, "new");
      expect(fs.readFileSync(file, "utf-8")).toBe("new");
    });

    it("creates missing parent directories", async () => {
      const file = nodePath.join(dir, "p", "q", "b.txt");
      await writeFileAtomic(file, "deep");
      expect(fs.readFileSync(file, "utf-8")).toBe("deep");
    });

    it("leaves no temp file behind on failure", async () => {
      const target = nodePath.join(dir, "iam-a-dir");
      fs.mkdirSync(target);
      await expect(writeFileAtomic(target, "x")).rejects.toThrow();
      const leftovers = fs.readdirSync(dir).filter((f) => f.includes(".tmp-"));
      expect(leftovers).toEqual([]);
    });
  });
});
