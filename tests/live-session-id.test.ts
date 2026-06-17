import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(join(os.tmpdir(), "tcb-live-id-"));
  process.env.TCB_STATE_DIR = dir;
});
afterEach(() => {
  delete process.env.TCB_STATE_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("live-session-id store", () => {
  it("returns null for an unknown session", async () => {
    const { getLastLiveSessionId } = await import("../src/core/agents/live-session-id.js");
    expect(getLastLiveSessionId("nope")).toBeNull();
  });

  it("records and reads back the last observed live session id", async () => {
    const { recordLiveSessionId, getLastLiveSessionId } = await import(
      "../src/core/agents/live-session-id.js"
    );
    recordLiveSessionId("tmux_proj_free_2", "id-aaa");
    expect(getLastLiveSessionId("tmux_proj_free_2")).toBe("id-aaa");
  });

  it("self-heals to a new id when the observed session changes (desktop switch)", async () => {
    const { recordLiveSessionId, getLastLiveSessionId } = await import(
      "../src/core/agents/live-session-id.js"
    );
    recordLiveSessionId("s", "id-old");
    recordLiveSessionId("s", "id-new"); // a later observation sees a different session
    expect(getLastLiveSessionId("s")).toBe("id-new");
  });

  it("clears a session's record (e.g. a reused free slot must not read a stale id)", async () => {
    const { recordLiveSessionId, getLastLiveSessionId, clearLiveSessionId } = await import(
      "../src/core/agents/live-session-id.js"
    );
    recordLiveSessionId("s", "id-x");
    clearLiveSessionId("s");
    expect(getLastLiveSessionId("s")).toBeNull();
  });
});
