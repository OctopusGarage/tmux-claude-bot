import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { reconcileGroupBinding } from "../../../src/core/projects/group-binding-ops.js";
import { bindGroup, unbindGroup } from "../../../src/core/projects/group-bindings.js";
import { createProjectSession } from "../../../src/core/projects/project-ops.js";
import { fakeDeps } from "./_fakes.js";

/**
 * Concurrency stress for the session-create race (the TOCTOU that crashed
 * handlers with "duplicate session"). Many messages can hit the same scope at
 * once — each may try to (re)create the same tmux session. The contract:
 *
 *   createSession is race-safe (only one caller "creates", the rest get false),
 *   and the new pane is started directly in the project dir via `new-session -c`.
 *   No `cd` is ever typed, so a session that already has Claude running can never
 *   get a stray `cd` landing in its prompt.
 *
 * We model a race-safe bridge (with a real interleave window) and assert nothing
 * is ever typed and nothing throws, no matter how many callers race.
 */
describe("session create under concurrency", () => {
  /** A bridge whose createSession mimics the race-safe tmux contract: a yield
   *  between the existence check and the insert lets concurrent callers race,
   *  and exactly one wins (returns true); the rest get false. */
  function raceSafeBridge() {
    const live = new Set<string>();
    const createSession = vi.fn(async (name: string) => {
      if (live.has(name)) return false;
      await Promise.resolve(); // interleave point — all racers pass the check here
      if (live.has(name)) return false;
      live.add(name);
      return true;
    });
    const sendKeys = vi.fn(async () => {});
    const hasSession = vi.fn(async (name: string) => live.has(name));
    return { live, bridge: { createSession, sendKeys, hasSession }, createSession, sendKeys };
  }

  it("createProjectSession: 12 concurrent calls create once and never type a cd", async () => {
    const { bridge, createSession, sendKeys, live } = raceSafeBridge();
    const deps = fakeDeps({ bridge, config: { sessionWarmupMs: 0 } });

    await Promise.all(
      Array.from({ length: 12 }, () => createProjectSession(deps, "scope", "sess", "/tmp/x")),
    );

    expect(createSession).toHaveBeenCalledTimes(12); // every caller attempted
    expect(createSession).toHaveBeenCalledWith("sess", "/tmp/x"); // pane starts in the dir (-c)
    expect(sendKeys).not.toHaveBeenCalled(); // nothing typed — no stray cd
    expect(live.has("sess")).toBe(true);
  });

  it("reconcileGroupBinding: concurrent messages on a dead session recreate it once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tcb-conc-"));
    const sessionName = "sess-recon";
    bindGroup("oc_conc", { workspacePath: dir, sessionName, label: "x" });
    try {
      const { bridge, sendKeys, live } = raceSafeBridge();
      const deps = fakeDeps({
        bridge,
        config: { sessionWarmupMs: 0 },
        currentProject: { get: vi.fn(async () => null) }, // pointer drifted/cleared
      });

      const results = await Promise.all(
        Array.from({ length: 10 }, () => reconcileGroupBinding(deps, "lark", "oc_conc")),
      );

      // No throw, the session is alive, and nothing was ever typed into a pane.
      expect(results.every((r) => r.status === "restored")).toBe(true);
      expect(live.has(sessionName)).toBe(true);
      expect(sendKeys).not.toHaveBeenCalled();
    } finally {
      unbindGroup("oc_conc");
    }
  });
});
