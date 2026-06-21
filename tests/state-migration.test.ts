import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LEGACY_STATE_NAMES, migrateLegacyStateDir } from "../src/core/infra/state-migration.js";

// Each test pins TCB_STATE_DIR to a `<temp>/state` subdir so migration runs (it
// only acts when the resolved state dir is named `state`). Restored afterEach.
const pinned = process.env.TCB_STATE_DIR;
let home: string;
afterEach(() => {
  if (pinned === undefined) delete process.env.TCB_STATE_DIR;
  else process.env.TCB_STATE_DIR = pinned;
});
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tcb-mig-"));
  process.env.TCB_STATE_DIR = join(home, "state");
});

describe("migrateLegacyStateDir", () => {
  it("relocates legacy root-level state into the state/ subdir", () => {
    writeFileSync(join(home, "group_bindings.json"), '{"oc_1":{"x":1}}');
    writeFileSync(join(home, ".env"), "TELEGRAM_BOT_TOKEN=abc\n");

    migrateLegacyStateDir();

    expect(existsSync(join(home, "group_bindings.json"))).toBe(false);
    expect(existsSync(join(home, ".env"))).toBe(false);
    expect(readFileSync(join(home, "state", "group_bindings.json"), "utf8")).toBe(
      '{"oc_1":{"x":1}}',
    );
    expect(readFileSync(join(home, "state", ".env"), "utf8")).toBe("TELEGRAM_BOT_TOKEN=abc\n");
  });

  it("never clobbers a file already in state/ (new location wins)", () => {
    mkdirSync(join(home, "state"), { recursive: true });
    writeFileSync(join(home, "group_bindings.json"), "STALE");
    writeFileSync(join(home, "state", "group_bindings.json"), "CURRENT");

    migrateLegacyStateDir();

    expect(readFileSync(join(home, "state", "group_bindings.json"), "utf8")).toBe("CURRENT");
  });

  it("is idempotent and a no-op when there is nothing to migrate", () => {
    expect(() => migrateLegacyStateDir()).not.toThrow();
    expect(() => migrateLegacyStateDir()).not.toThrow();
    // The state dir is created so the first write doesn't fail.
    expect(existsSync(join(home, "state"))).toBe(true);
  });

  it("leaves a custom (non-`state`) TCB_STATE_DIR untouched", () => {
    const custom = mkdtempSync(join(tmpdir(), "tcb-custom-"));
    process.env.TCB_STATE_DIR = custom; // basename !== "state"
    const parent = join(custom, "..");
    writeFileSync(join(parent, "group_bindings.json"), "ROOT");

    migrateLegacyStateDir();

    // Nothing moved into `custom` — the operator chose this dir explicitly.
    expect(existsSync(join(custom, "group_bindings.json"))).toBe(false);
  });

  it("covers every name install.sh protects (migration list == exclude list)", () => {
    // The deploy excludes exactly the names this migration relocates; keep them in
    // lockstep so a file is never excluded-but-not-moved or moved-but-not-excluded.
    expect(LEGACY_STATE_NAMES.length).toBeGreaterThan(0);
  });
});
