import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isGlobalKeepAlive, setGlobalKeepAlive } from "../../src/core/autopilot/global-flag.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tcb-global-"));
  process.env.TCB_STATE_DIR = dir; // persistEnvVar writes the state-dir .env here
  delete process.env.AUTOPILOT_GLOBAL_KEEPALIVE;
});
afterEach(() => {
  delete process.env.TCB_STATE_DIR;
  delete process.env.AUTOPILOT_GLOBAL_KEEPALIVE;
  rmSync(dir, { recursive: true, force: true });
});

describe("global-flag", () => {
  it("defaults off; set on/off round-trips via process.env", () => {
    expect(isGlobalKeepAlive()).toBe(false);
    setGlobalKeepAlive(true);
    expect(isGlobalKeepAlive()).toBe(true);
    expect(process.env.AUTOPILOT_GLOBAL_KEEPALIVE).toBe("1");
    setGlobalKeepAlive(false);
    expect(isGlobalKeepAlive()).toBe(false);
  });

  it("reads '1' or 'true' as on", () => {
    process.env.AUTOPILOT_GLOBAL_KEEPALIVE = "true";
    expect(isGlobalKeepAlive()).toBe(true);
  });
});
