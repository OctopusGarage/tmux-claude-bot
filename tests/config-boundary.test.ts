import { describe, expect, it } from "vitest";
import { envSchema, loadConfig } from "../src/shared/config.js";

/**
 * Schema-introspecting boundary test: a blank `KEY=` line crashed startup once
 * (a numeric field used `.default()` instead of tolerating ""). Rather than list
 * the numeric fields by hand, iterate EVERY key the schema knows about and assert
 * that leaving it blank never throws. This auto-covers fields added later: a new
 * numeric var wired with a plain `.default()` will fail this the moment it lands.
 */
const KEYS = Object.keys(envSchema.shape);

describe("no env var crashes startup when left blank", () => {
  for (const key of KEYS) {
    it(`${key}= (blank) loads without throwing`, () => {
      expect(() => loadConfig({ TELEGRAM_BOT_TOKEN: "t", [key]: "" })).not.toThrow();
    });
  }

  it("covers a non-trivial number of keys (guards an empty introspection)", () => {
    expect(KEYS.length).toBeGreaterThan(10);
  });
});
