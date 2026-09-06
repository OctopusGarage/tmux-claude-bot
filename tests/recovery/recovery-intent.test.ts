import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultQueueObserver } from "../../src/core/command/queue-observer.js";
import {
  clearRecoveryIntent,
  hasRecoveryIntent,
  markRecoveryIntent,
} from "../../src/core/recovery/recovery-intent.js";
import { cleanupWorkerSessionRecords } from "../../src/core/recovery/worker-session-cleanup.js";

let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(join(os.tmpdir(), "tcb-recovery-intent-"));
  process.env.TCB_STATE_DIR = stateDir;
});

afterEach(() => {
  delete process.env.TCB_STATE_DIR;
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("recovery intent", () => {
  it("tracks the queue observer lifecycle", () => {
    const message = {
      id: "msg-observed",
      text: "work",
      chatId: 1,
      action: "text",
      resolve: () => {},
      reject: () => {},
    };

    defaultQueueObserver.started("tmux_proj_observed", message);
    expect(hasRecoveryIntent("tmux_proj_observed")).toBe(true);

    defaultQueueObserver.finished("tmux_proj_observed", message);
    expect(hasRecoveryIntent("tmux_proj_observed")).toBe(false);
  });

  it("records an unfinished task per session and clears the matching task", () => {
    markRecoveryIntent("tmux_proj_a", "msg-a", 1000);

    expect(hasRecoveryIntent("tmux_proj_a")).toBe(true);
    expect(clearRecoveryIntent("tmux_proj_a", "other-msg")).toBe(false);
    expect(hasRecoveryIntent("tmux_proj_a")).toBe(true);
    expect(clearRecoveryIntent("tmux_proj_a", "msg-a")).toBe(true);
    expect(hasRecoveryIntent("tmux_proj_a")).toBe(false);
  });

  it("does not let a later task hide an active intent", () => {
    markRecoveryIntent("tmux_proj_a", "msg-a", 1000);
    markRecoveryIntent("tmux_proj_a", "msg-b", 2000);

    expect(clearRecoveryIntent("tmux_proj_a", "msg-a")).toBe(true);
    expect(clearRecoveryIntent("tmux_proj_a", "msg-b")).toBe(false);
  });

  it("clears loop worker intents when worker session records are cleaned up", () => {
    markRecoveryIntent("tmux_proj_loop-worker-api", "msg-a", 1000);

    cleanupWorkerSessionRecords("tmux_proj_loop-worker-api");

    expect(hasRecoveryIntent("tmux_proj_loop-worker-api")).toBe(false);
  });

  it("treats a corrupt state file as empty and preserves the original bytes", () => {
    const file = join(stateDir, "recovery_intents.json");
    fs.writeFileSync(file, "not-json", "utf8");

    expect(hasRecoveryIntent("tmux_proj_corrupt")).toBe(false);
    expect(fs.readFileSync(`${file}.corrupt`, "utf8")).toBe("not-json");
  });
});
