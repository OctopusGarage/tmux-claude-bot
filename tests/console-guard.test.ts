import * as fs from "node:fs";
import { describe, expect, it } from "vitest";

const OPERATIONAL = ["src/index.ts", "src/adapters/telegram/start.ts"];

describe("operational code logs via the logger, not console.*", () => {
  for (const file of OPERATIONAL) {
    it(`${file} has no console.* calls`, () => {
      const src = fs.readFileSync(file, "utf8");
      const hits = src.match(/console\.(log|error|warn|info|debug)\b/g) ?? [];
      expect(hits).toEqual([]);
    });
  }
});
