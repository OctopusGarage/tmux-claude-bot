import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LEGACY_STATE_NAMES } from "../src/core/infra/state-migration.js";
import { appStateDir, appStateFile, stateDir } from "../src/shared/state-dir.js";

// The global test setup pins TCB_STATE_DIR to a temp dir; restore it after each
// test that mutates it so sibling tests keep their isolation.
const pinned = process.env.TCB_STATE_DIR;
let tempDirs: string[] = [];
afterEach(() => {
  if (pinned === undefined) delete process.env.TCB_STATE_DIR;
  else process.env.TCB_STATE_DIR = pinned;
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("stateDir (primitive)", () => {
  it("uses the fallback when TCB_STATE_DIR is unset", () => {
    delete process.env.TCB_STATE_DIR;
    expect(stateDir("/fallback")).toBe("/fallback");
  });

  it("honors TCB_STATE_DIR over the fallback", () => {
    process.env.TCB_STATE_DIR = "/override";
    expect(stateDir("/fallback")).toBe("/override");
  });
});

describe("appStateDir / appStateFile (single source of truth)", () => {
  it("uses TCB_STATE_DIR when set", () => {
    process.env.TCB_STATE_DIR = "/override";
    expect(appStateDir()).toBe("/override");
    expect(appStateFile("session_path_map.json")).toBe("/override/session_path_map.json");
  });

  it("normalizes a legacy app-home TCB_STATE_DIR to the nested state dir", () => {
    const appHome = mkdtempSync(join(tmpdir(), "tcb-app-home-"));
    tempDirs.push(appHome);
    mkdirSync(join(appHome, "logs"), { recursive: true });
    mkdirSync(join(appHome, "state", "loop-runs"), { recursive: true });
    process.env.TCB_STATE_DIR = appHome;

    expect(appStateDir()).toBe(join(appHome, "state"));
    expect(appStateFile("loop-runs")).toBe(join(appHome, "state", "loop-runs"));
  });

  it("falls back to the ~/.tmux-claude-bot/state subdir (never the install root, cwd or $HOME)", () => {
    delete process.env.TCB_STATE_DIR;
    // The `state/` subdir keeps state out of the code install dir, which the
    // deploy re-mirrors with `rsync --delete` (it used to wipe group_bindings.json).
    expect(appStateDir()).toBe(join(homedir(), ".tmux-claude-bot", "state"));
  });
});

describe("deploy durability guard", () => {
  // Every state file the bot writes MUST survive the deploy. The deploy mirrors
  // the install dir with `rsync --delete`; a state file not excluded gets wiped.
  // This asserts install.sh excludes the whole state dir (`/state`) AND every
  // legacy root-level name (transition safety until the boot migration relocates
  // them) — so a NEW state file can't silently regress into the deploy-wipe.
  const installSh = readFileSync(join(__dirname, "..", "install.sh"), "utf8");

  it("excludes the /state subdir from rsync --delete", () => {
    expect(installSh).toContain("--exclude='/state'");
  });

  it("excludes every legacy root-level state artifact from rsync --delete", () => {
    for (const name of LEGACY_STATE_NAMES) {
      expect(installSh, `install.sh must --exclude '${name}' (deploy would wipe it)`).toContain(
        `--exclude='${name}'`,
      );
    }
  });
});
