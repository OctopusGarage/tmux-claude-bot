import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TmuxBridge } from "../../src/core/session/tmux.js";

// These drive a REAL tmux server + shell, so each test does up-to-10s polls. The
// default 5s vitest timeout would kill a poll mid-flight under heavy suite load
// (the cause of the intermittent failure); give them room.
vi.setConfig({ testTimeout: 30_000 });

/**
 * LIVE integration tests for the tmux command layer — they drive a REAL tmux
 * server running a plain shell (NO claude/codex) through the bot's actual
 * TmuxBridge, and assert the round trip: keys go in, output/pane state comes back.
 *
 * Deterministic on purpose: a shell has no model calls, MCP boot, or transient
 * "ready" states, so unlike driving a real agent these never race. They prove the
 * foundation every agent relies on — "send a command through tmux and read the
 * result" — actually works against real tmux.
 *
 * Auto-skips when tmux isn't on PATH (e.g. CI), so `npm test` stays green there;
 * run locally where tmux exists.
 */

function hasTmux(): boolean {
  try {
    execFileSync("which", ["tmux"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const sessions = new Set<string>();
let counter = 0;
function newSession(): string {
  // Unique per test; a plain detached shell in /tmp.
  const name = `tcb_it_${counter++}_${process.hrtime.bigint().toString().slice(-9)}`;
  execFileSync("tmux", ["new-session", "-d", "-s", name, "-c", "/tmp", "-x", "200", "-y", "50"]);
  sessions.add(name);
  return name;
}
function bridgeFor(session: string): TmuxBridge {
  return new TmuxBridge({ getSessionName: async () => session });
}

describe.skipIf(!hasTmux())("live tmux command layer (real tmux + shell)", () => {
  afterEach(() => {
    for (const s of sessions) {
      try {
        execFileSync("tmux", ["kill-session", "-t", s], { stdio: "ignore" });
      } catch {
        /* already gone */
      }
    }
    sessions.clear();
  });

  it("sendKeys runs a command and capturePane reads its output (the core round trip)", async () => {
    const s = newSession();
    const bridge = bridgeFor(s);
    await bridge.sendKeys("echo TCB_MARKER_8421", s);
    await expect
      .poll(() => bridge.capturePane(s), { timeout: 10_000, interval: 200 })
      .toContain("TCB_MARKER_8421");
  });

  it("sendRawKey C-c interrupts a running foreground command", async () => {
    const s = newSession();
    const bridge = bridgeFor(s);
    // `cat` with no args blocks reading stdin → it's the foreground command.
    await bridge.sendKeys("cat", s);
    await expect
      .poll(() => bridge.paneCurrentCommand(s), { timeout: 10_000, interval: 200 })
      .toBe("cat");
    // Ctrl-C must drop us back to the shell.
    await bridge.sendRawKey("C-c", s);
    await expect
      .poll(() => bridge.paneCurrentCommand(s), { timeout: 10_000, interval: 200 })
      .not.toBe("cat");
    // And the shell is still usable afterwards.
    await bridge.sendKeys("echo BACK_TCB", s);
    await expect
      .poll(() => bridge.capturePane(s), { timeout: 10_000, interval: 200 })
      .toContain("BACK_TCB");
  });

  it("sendExit (Ctrl-C + /exit) interrupts the foreground program and leaves the pane alive", async () => {
    const s = newSession();
    const bridge = bridgeFor(s);
    await bridge.sendKeys("cat", s);
    await expect
      .poll(() => bridge.paneCurrentCommand(s), { timeout: 10_000, interval: 200 })
      .toBe("cat");
    // sendExit is what the bot's `exit` action sends. Against a shell the `/exit`
    // is just a bad command (harmless); the Ctrl-C is the observable part — it
    // interrupts `cat`. (For a real agent the `/exit` quits it.)
    await bridge.sendExit(s);
    await expect
      .poll(() => bridge.paneCurrentCommand(s), { timeout: 10_000, interval: 200 })
      .not.toBe("cat");
    expect(await bridge.isPaneAlive(s)).toBe(true);
  });

  it("isPaneAlive reflects the session's existence", async () => {
    const s = newSession();
    const bridge = bridgeFor(s);
    expect(await bridge.isPaneAlive(s)).toBe(true);
    execFileSync("tmux", ["kill-session", "-t", s], { stdio: "ignore" });
    sessions.delete(s);
    expect(await bridge.isPaneAlive(s)).toBe(false);
  });

  it("paneCurrentPath reports the pane's working directory", async () => {
    const s = newSession();
    const bridge = bridgeFor(s);
    // The session started in /tmp (macOS may resolve it to /private/tmp).
    await expect
      .poll(() => bridge.paneCurrentPath(s), { timeout: 10_000, interval: 200 })
      .toMatch(/\/tmp$/);
  });

  it("createSession is idempotent — returns false when the session already exists", async () => {
    const s = newSession();
    const bridge = bridgeFor(s);
    expect(await bridge.createSession(s)).toBe(false); // already exists
  });
});
