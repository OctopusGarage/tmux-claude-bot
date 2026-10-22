import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  detectUncleanRestart,
  detectUncleanRestartIdentity,
  markCleanShutdown,
} from "../../src/core/infra/lifecycle.js";

describe("lifecycle crash detection", () => {
  let dir: string;
  let prev: string | undefined;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tcb-lifecycle-"));
    prev = process.env.TCB_STATE_DIR;
    process.env.TCB_STATE_DIR = dir;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.TCB_STATE_DIR;
    else process.env.TCB_STATE_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("first run is clean (no marker yet)", () => {
    expect(detectUncleanRestart()).toBe(false);
  });

  it("flags a restart when the previous run left the marker (crash / SIGKILL)", () => {
    detectUncleanRestart(); // run 1 writes the marker and never clears it
    expect(detectUncleanRestart()).toBe(true); // run 2 sees the stale marker
  });

  it("returns the previous run identity for one restart notification", () => {
    expect(detectUncleanRestartIdentity()).toBeNull();
    expect(detectUncleanRestartIdentity()).toMatch(/^\d+ /);
  });

  it("a clean shutdown clears the flag", () => {
    detectUncleanRestart();
    markCleanShutdown();
    expect(detectUncleanRestart()).toBe(false);
  });
});
