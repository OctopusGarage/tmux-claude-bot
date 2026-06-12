import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stateDir, stateRootFromModule } from "../src/core/state-dir.js";

describe("stateDir", () => {
  // The global test setup pins TCB_STATE_DIR to a temp dir; restore it after we
  // mutate it here so sibling tests keep their isolation.
  const pinned = process.env.TCB_STATE_DIR;
  afterEach(() => {
    if (pinned === undefined) delete process.env.TCB_STATE_DIR;
    else process.env.TCB_STATE_DIR = pinned;
  });

  it("uses the fallback when TCB_STATE_DIR is unset", () => {
    delete process.env.TCB_STATE_DIR;
    expect(stateDir("/fallback")).toBe("/fallback");
  });

  it("honors TCB_STATE_DIR over the fallback", () => {
    process.env.TCB_STATE_DIR = "/override";
    expect(stateDir("/fallback")).toBe("/override");
  });
});

describe("stateRootFromModule", () => {
  it("walks up to the nearest package.json (repo root in source, install dir in a bundle)", () => {
    // From this test file it must resolve to an ancestor that has package.json —
    // never overshoot to $HOME the way a fixed `../..` does once bundled.
    const root = stateRootFromModule(import.meta.url);
    expect(existsSync(join(root, "package.json"))).toBe(true);
  });
});
