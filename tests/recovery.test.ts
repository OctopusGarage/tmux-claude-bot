import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAgentKind } from "../src/core/agents/agentKindMap.js";
import { recordLiveSessionId } from "../src/core/agents/live-session-id.js";
import { markSessionRunning } from "../src/core/agents/runningSessions.js";
import { setStartCommand } from "../src/core/agents/startCommandMap.js";
import { setPathForSession } from "../src/core/projects/sessionPathMap.js";
import { recoverProjects } from "../src/core/recovery/recover.js";
import { fakeDeps } from "./adapters/lark/_fakes.js";

let dir: string;
let realDir: string; // a working dir that actually exists on disk
beforeEach(() => {
  dir = fs.mkdtempSync(join(os.tmpdir(), "tcb-recover-state-"));
  process.env.TCB_STATE_DIR = dir;
  realDir = fs.mkdtempSync(join(os.tmpdir(), "tcb-recover-proj-"));
});
afterEach(() => {
  delete process.env.TCB_STATE_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(realDir, { recursive: true, force: true });
});

/** A deps with the bridge/agent calls recovery drives, all spy-able. */
function recoverDeps(over: { paneAlive?: boolean; agentRunning?: boolean } = {}) {
  return fakeDeps({
    bridge: {
      isPaneAlive: vi.fn(async () => over.paneAlive ?? false),
      createSession: vi.fn(async () => true),
    },
    agent: {
      checkIfRunning: vi.fn(async () => over.agentRunning ?? false),
      start: vi.fn(async () => {}),
      startWithResume: vi.fn(async () => {}),
    },
  });
}

describe("recoverProjects", () => {
  it("recreates a gone claude session and resumes the exact recorded id", async () => {
    setPathForSession("tmux_proj_a", realDir);
    markSessionRunning("tmux_proj_a");
    setAgentKind("tmux_proj_a", "claude");
    setStartCommand("tmux_proj_a", "claude --dangerously-skip-permissions");
    recordLiveSessionId("tmux_proj_a", "uuid-123");
    const deps = recoverDeps({ paneAlive: false });

    const res = await recoverProjects(deps, { staggerMs: 0 });

    expect(deps.bridge.createSession).toHaveBeenCalledWith("tmux_proj_a", realDir);
    expect(deps.agent.startWithResume).toHaveBeenCalledWith(
      "tmux_proj_a",
      "uuid-123",
      "claude --dangerously-skip-permissions",
    );
    expect(deps.agent.start).not.toHaveBeenCalled();
    expect(res.launched.map((i) => i.session)).toEqual(["tmux_proj_a"]);
  });

  it("starts fresh (no resume) when no session id was recorded", async () => {
    setPathForSession("tmux_proj_b", realDir);
    markSessionRunning("tmux_proj_b");
    setAgentKind("tmux_proj_b", "codex");
    setStartCommand("tmux_proj_b", "codex");
    const deps = recoverDeps({ paneAlive: false });

    await recoverProjects(deps, { staggerMs: 0 });

    expect(deps.bridge.createSession).toHaveBeenCalledWith("tmux_proj_b", realDir);
    expect(deps.agent.start).toHaveBeenCalledWith("tmux_proj_b", "codex");
    expect(deps.agent.startWithResume).not.toHaveBeenCalled();
  });

  it("uses the codex session's last recorded model when recovering with an exact id", async () => {
    const codexHome = fs.mkdtempSync(join(os.tmpdir(), "tcb-recover-codex-home-"));
    const rolloutDir = join(codexHome, "sessions", "2026", "07", "05");
    fs.mkdirSync(rolloutDir, { recursive: true });
    fs.writeFileSync(
      join(rolloutDir, "rollout-2026-07-05T00-00-00-uuid-codex.jsonl"),
      [
        JSON.stringify({
          type: "session_meta",
          payload: { id: "uuid-codex", cwd: realDir },
        }),
        JSON.stringify({
          type: "turn_context",
          payload: { cwd: realDir, model: "gpt-5.4-mini" },
        }),
      ].join("\n"),
    );
    setPathForSession("tmux_proj_codex", realDir);
    markSessionRunning("tmux_proj_codex");
    setAgentKind("tmux_proj_codex", "codex");
    setStartCommand("tmux_proj_codex", `CODEX_HOME=${codexHome} codex --model gpt-5.5`);
    recordLiveSessionId("tmux_proj_codex", "uuid-codex");
    const deps = recoverDeps({ paneAlive: false });

    await recoverProjects(deps, { staggerMs: 0 });

    expect(deps.agent.startWithResume).toHaveBeenCalledWith(
      "tmux_proj_codex",
      "uuid-codex",
      `CODEX_HOME=${codexHome} codex --model gpt-5.4-mini`,
    );

    fs.rmSync(codexHome, { recursive: true, force: true });
  });

  it("leaves an alive session whose agent is running untouched (idempotent)", async () => {
    setPathForSession("tmux_proj_c", realDir);
    markSessionRunning("tmux_proj_c");
    setStartCommand("tmux_proj_c", "claude");
    recordLiveSessionId("tmux_proj_c", "uuid-c");
    const deps = recoverDeps({ paneAlive: true, agentRunning: true });

    const res = await recoverProjects(deps, { staggerMs: 0 });

    expect(deps.bridge.createSession).not.toHaveBeenCalled();
    expect(deps.agent.start).not.toHaveBeenCalled();
    expect(deps.agent.startWithResume).not.toHaveBeenCalled();
    expect(res.alreadyAlive.map((i) => i.session)).toEqual(["tmux_proj_c"]);
  });

  it("relaunches in place when the session is alive but the agent exited", async () => {
    setPathForSession("tmux_proj_d", realDir);
    markSessionRunning("tmux_proj_d");
    setStartCommand("tmux_proj_d", "claude");
    recordLiveSessionId("tmux_proj_d", "uuid-d");
    const deps = recoverDeps({ paneAlive: true, agentRunning: false });

    await recoverProjects(deps, { staggerMs: 0 });

    expect(deps.bridge.createSession).not.toHaveBeenCalled(); // session already there
    expect(deps.agent.startWithResume).toHaveBeenCalledWith("tmux_proj_d", "uuid-d", "claude");
  });

  it("skips a project whose working dir no longer exists", async () => {
    setPathForSession("tmux_proj_e", join(realDir, "gone-subdir"));
    markSessionRunning("tmux_proj_e");
    setStartCommand("tmux_proj_e", "claude");
    const deps = recoverDeps({ paneAlive: false });

    const res = await recoverProjects(deps, { staggerMs: 0 });

    expect(deps.bridge.createSession).not.toHaveBeenCalled();
    expect(deps.agent.start).not.toHaveBeenCalled();
    expect(res.skippedMissingDir.map((i) => i.session)).toEqual(["tmux_proj_e"]);
  });

  it("ignores a recorded project that wasn't running before the reboot (not in roster)", async () => {
    // Path + command + id recorded, but the agent had been exited (not marked
    // running) → recovery must not resurrect it. This is the core scoping rule.
    setPathForSession("tmux_proj_z", realDir);
    setStartCommand("tmux_proj_z", "claude");
    recordLiveSessionId("tmux_proj_z", "uuid-z");
    const deps = recoverDeps({ paneAlive: false });

    const res = await recoverProjects(deps, { staggerMs: 0 });

    expect(deps.bridge.createSession).not.toHaveBeenCalled();
    expect(deps.agent.start).not.toHaveBeenCalled();
    expect(res.launched).toHaveLength(0);
    expect(res.shellOnly).toHaveLength(0);
  });

  it("recreates a shell-only session (in roster but no start command recorded)", async () => {
    setPathForSession("tmux_proj_f", realDir);
    markSessionRunning("tmux_proj_f"); // was running, but no command recorded (e.g. legacy resume)
    const deps = recoverDeps({ paneAlive: false });

    const res = await recoverProjects(deps, { staggerMs: 0 });

    expect(deps.bridge.createSession).toHaveBeenCalledWith("tmux_proj_f", realDir);
    expect(deps.agent.start).not.toHaveBeenCalled();
    expect(res.shellOnly.map((i) => i.session)).toEqual(["tmux_proj_f"]);
  });

  it("dryRun returns the plan without touching tmux or the agent", async () => {
    setPathForSession("tmux_proj_g", realDir);
    markSessionRunning("tmux_proj_g");
    setStartCommand("tmux_proj_g", "claude");
    recordLiveSessionId("tmux_proj_g", "uuid-g");
    const deps = recoverDeps({ paneAlive: false });

    const res = await recoverProjects(deps, { dryRun: true });

    expect(deps.bridge.createSession).not.toHaveBeenCalled();
    expect(deps.agent.start).not.toHaveBeenCalled();
    expect(deps.agent.startWithResume).not.toHaveBeenCalled();
    expect(res.launched.map((i) => i.session)).toEqual(["tmux_proj_g"]);
  });

  it("refuses a second concurrent recovery (in-process guard, no double-launch)", async () => {
    setPathForSession("tmux_proj_g1", realDir);
    markSessionRunning("tmux_proj_g1");
    setStartCommand("tmux_proj_g1", "claude"); // no id → uses start()
    const deps = recoverDeps({ paneAlive: false });
    // Block the first run's launch so it stays in-flight while we call again.
    let release = (): void => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    (deps.agent.start as ReturnType<typeof vi.fn>).mockReturnValueOnce(gate);

    const first = recoverProjects(deps, { staggerMs: 0 });
    await new Promise((r) => setTimeout(r, 0)); // let `first` reach the blocked launch
    const second = await recoverProjects(deps, { staggerMs: 0 });

    expect(second.busy).toBe(true);
    expect(second.launched).toHaveLength(0);
    expect(deps.agent.start).toHaveBeenCalledTimes(1); // the guard prevented a 2nd launch

    release();
    await first;
    // Guard releases after the first completes — a later run is allowed again.
    const third = await recoverProjects(deps, { staggerMs: 0 });
    expect(third.busy).toBeUndefined();
  });

  it("records a per-project failure and continues with the rest", async () => {
    setPathForSession("tmux_proj_h1", realDir);
    markSessionRunning("tmux_proj_h1");
    setStartCommand("tmux_proj_h1", "claude");
    setPathForSession("tmux_proj_h2", realDir);
    markSessionRunning("tmux_proj_h2");
    setStartCommand("tmux_proj_h2", "claude");
    const deps = recoverDeps({ paneAlive: false });
    // First launch throws, second succeeds.
    (deps.agent.start as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined);

    const res = await recoverProjects(deps, { staggerMs: 0 });

    expect(res.failed).toHaveLength(1);
    expect(res.failed[0]?.item.session).toBe("tmux_proj_h1");
    expect(res.launched.map((i) => i.session)).toEqual(["tmux_proj_h2"]);
  });

  it("never recovers the operator session, even when marked running with a path", async () => {
    // Operator is marked running (as would happen if startOperator ran before a
    // restart) and has a recorded path — generic recovery must leave it alone.
    setPathForSession("tmux_proj_home", realDir);
    markSessionRunning("tmux_proj_home");
    setStartCommand("tmux_proj_home", "claude --dangerously-skip-permissions");
    // A real user project alongside it — to confirm the operator filter doesn't
    // drop everything.
    setPathForSession("tmux_proj_real", realDir);
    markSessionRunning("tmux_proj_real");
    setStartCommand("tmux_proj_real", "claude");
    const deps = recoverDeps({ paneAlive: false });

    const res = await recoverProjects(deps, { staggerMs: 0 });

    const sessionNames = res.launched.map((i) => i.session);
    expect(sessionNames).not.toContain("tmux_proj_home");
    expect(sessionNames).toContain("tmux_proj_real");
    // No createSession/start calls for the operator
    expect(deps.bridge.createSession).not.toHaveBeenCalledWith("tmux_proj_home", expect.anything());
    expect(deps.agent.start).not.toHaveBeenCalledWith("tmux_proj_home", expect.anything());
  });
});
