import * as fs from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ConfigResolver } from "../src/core/agents/agent-config-resolver.js";
import { CodexRunner, paneLooksReady } from "../src/core/agents/codex/codex-runner.js";
import { paneNeedsConfirm } from "../src/core/agents/runner-base.js";
import type { OutputProcessor } from "../src/core/session/output.js";
import type { TmuxBridge } from "../src/core/session/tmux.js";

const FIXTURES = join(import.meta.dirname, "fixtures");
const ready = fs.readFileSync(join(FIXTURES, "codex-ready-pane.txt"), "utf8");
const busy = fs.readFileSync(join(FIXTURES, "codex-busy-pane.txt"), "utf8");

describe("codex pane heuristics", () => {
  it("ready when no 'esc to interrupt' spinner is present", () => {
    expect(paneLooksReady(ready)).toBe(true);
  });

  it("not ready while codex is working", () => {
    expect(paneLooksReady(busy)).toBe(false);
  });

  it("not ready on a booting / not-yet-rendered pane (no composer)", () => {
    // Regression: a negative-only marker (!"esc to interrupt") wrongly reports an
    // empty/booting pane as ready, so the bot could send the first message before
    // codex is listening. The composer `›` must be present.
    expect(paneLooksReady("")).toBe(false);
    expect(paneLooksReady("\n\n  starting up...\n")).toBe(false);
    expect(paneLooksReady("Booting MCP server: codex_apps (1s • esc to interrupt)")).toBe(false);
  });

  it("detects confirm gates (codex trust, claude trust, bypass, generic hint)", () => {
    const codexTrust =
      "Do you trust the contents of this directory?\n  1. Yes, continue\n  Press enter to continue";
    expect(paneNeedsConfirm(codexTrust)).toBe(true);
    // claude's differently-worded trust gate + its bypass-permissions accept screen.
    expect(paneNeedsConfirm("❯ 1. Yes, I trust this folder\n  2. No, exit")).toBe(true);
    expect(paneNeedsConfirm("Bypass Permissions mode\n  2. Yes, I accept")).toBe(true);
    // Structural fallback: the "Enter to confirm" menu hint survives a re-word.
    expect(paneNeedsConfirm("Some new gate wording\n Enter to confirm · Esc to cancel")).toBe(true);
    // A ready composer is NOT a confirm gate.
    expect(paneNeedsConfirm(ready)).toBe(false);
  });
});

describe("CodexRunner.start", () => {
  it("launches the command, clears the trust gate, then waits for the composer", async () => {
    // Frames the pane shows in sequence: booting → trust gate → ready composer.
    const frames = [
      "(base) ~/proj $ codex --yolo", // booting: no composer, no trust
      "Do you trust this directory?\n› 1. Yes, continue\nPress enter to continue", // trust gate
      "› type here\n  gpt-5.5 · /proj", // composer rendered → ready
    ];
    let i = 0;
    const sent: string[] = [];
    const bridge = {
      resolveSessionName: async (s?: string) => s ?? "sess",
      capturePane: async () => frames[Math.min(i++, frames.length - 1)] as string,
      sendKeys: async (t: string) => {
        sent.push(`keys:${t}`);
      },
      sendRawKey: async (k: string) => {
        sent.push(`raw:${k}`);
      },
    } as unknown as TmuxBridge;
    const configResolver = {
      isCodexRunning: async () => false,
    } as unknown as ConfigResolver;
    const runner = new CodexRunner({
      bridge,
      output: {} as unknown as OutputProcessor,
      configResolver,
      codexCommand: "codex --yolo",
      idlePollTicks: 1,
      pollIntervalMs: 1,
      maxWaitReadyMs: 50,
      maxWaitDoneMs: 50,
    });

    await runner.start("sess");

    expect(sent[0]).toBe("keys:codex --yolo"); // launched first
    expect(sent).toContain("raw:Enter"); // trust gate auto-accepted
  });

  it("does not launch when codex is already running", async () => {
    const sent: string[] = [];
    const bridge = {
      resolveSessionName: async (s?: string) => s ?? "sess",
      sendKeys: async (t: string) => {
        sent.push(t);
      },
    } as unknown as TmuxBridge;
    const configResolver = {
      isCodexRunning: async () => true,
    } as unknown as ConfigResolver;
    const runner = new CodexRunner({
      bridge,
      output: {} as unknown as OutputProcessor,
      configResolver,
      codexCommand: "codex --yolo",
      idlePollTicks: 1,
      pollIntervalMs: 1,
      maxWaitReadyMs: 50,
      maxWaitDoneMs: 50,
    });

    await runner.start("sess");

    expect(sent).toEqual([]);
  });
});

describe("CodexRunner.startWithResume", () => {
  it("resumes, clears the trust gate, then waits for the composer", async () => {
    // Like start(): booting → trust gate → ready composer. Resuming into a
    // not-yet-trusted dir hits the same gate, which must be auto-accepted.
    const frames = [
      "(base) ~/proj $ codex --yolo resume uuid-9", // booting
      "Do you trust this directory?\n› 1. Yes, continue\nPress enter to continue", // trust gate
      "› type here\n  gpt-5.5 · /proj", // composer rendered → ready
    ];
    let i = 0;
    const sent: string[] = [];
    const bridge = {
      resolveSessionName: async (s?: string) => s ?? "sess",
      capturePane: async () => frames[Math.min(i++, frames.length - 1)] as string,
      sendKeys: async (t: string) => {
        sent.push(`keys:${t}`);
      },
      sendRawKey: async (k: string) => {
        sent.push(`raw:${k}`);
      },
    } as unknown as TmuxBridge;
    const configResolver = {
      isCodexRunning: async () => false,
    } as unknown as ConfigResolver;
    const runner = new CodexRunner({
      bridge,
      output: {} as unknown as OutputProcessor,
      configResolver,
      codexCommand: "codex --yolo",
      idlePollTicks: 1,
      pollIntervalMs: 1,
      maxWaitReadyMs: 50,
      maxWaitDoneMs: 50,
    });

    await runner.startWithResume("sess", "uuid-9");

    expect(sent[0]).toBe("keys:codex --yolo resume uuid-9"); // resume typed first
    expect(sent).toContain("raw:Enter"); // trust gate auto-accepted
  });
});

describe("CodexRunner restart", () => {
  // isCodexRunning yields `running` per call (clamped to the last value), so a
  // restart can model "still running through N Ctrl-C, then gone".
  function makeRunner(running: boolean[], liveSessionId: string | null = null) {
    let i = 0;
    const sent: string[] = [];
    const bridge = {
      resolveSessionName: async (s?: string) => s ?? "sess",
      capturePane: async () => "› ready\n  gpt-5.5 · /proj", // ready for start()/resume waits
      sendKeys: async (t: string) => {
        sent.push(`keys:${t}`);
      },
      sendRawKey: async (k: string) => {
        sent.push(`raw:${k}`);
      },
      // Mirrors the real TmuxBridge.sendExit: Ctrl-C to interrupt, then `/exit`.
      sendExit: async () => {
        sent.push("raw:C-c");
        sent.push("keys:/exit");
      },
    } as unknown as TmuxBridge;
    const configResolver = {
      isCodexRunning: async () => running[Math.min(i++, running.length - 1)],
      resolveLiveTranscript: async () =>
        liveSessionId ? { path: "/x.jsonl", sessionId: liveSessionId } : null,
    } as unknown as ConfigResolver;
    const runner = new CodexRunner({
      bridge,
      output: {} as unknown as OutputProcessor,
      configResolver,
      codexCommand: "codex --yolo",
      idlePollTicks: 1,
      pollIntervalMs: 1,
      maxWaitReadyMs: 50,
      maxWaitDoneMs: 50,
    });
    return { runner, sent };
  }

  it("gracefulRestart sends /exit, then relaunches (codex has /exit, like claude)", async () => {
    const { runner, sent } = makeRunner([false]); // exited → start() relaunches
    await runner.gracefulRestart("sess");
    expect(sent).toContain("keys:/exit");
    expect(sent).toContain("keys:codex --yolo");
  });

  it("gracefulRestart's start() no-ops when codex is still running after /exit", async () => {
    const { runner, sent } = makeRunner([true]); // still running → start() short-circuits
    await runner.gracefulRestart("sess");
    expect(sent).toContain("keys:/exit");
    expect(sent.some((s) => s === "keys:codex --yolo")).toBe(false);
  });

  it("gracefulRestartWithContinue resumes the EXACT live session id when the process exposes it", async () => {
    const { runner, sent } = makeRunner([false], "11111111-2222-3333-4444-555555555555");
    await runner.gracefulRestartWithContinue("sess");
    // Resumes that conversation, NOT `resume --last` (which is just "the newest").
    expect(sent).toContain("keys:codex --yolo resume 11111111-2222-3333-4444-555555555555");
    expect(sent.some((s) => s.includes("resume --last"))).toBe(false);
  });

  it("gracefulRestartWithContinue falls back to resume --last when no live id is available", async () => {
    const { runner, sent } = makeRunner([false]); // no live session id
    await runner.gracefulRestartWithContinue("sess");
    expect(sent).toContain("keys:codex --yolo resume --last");
  });

  it("gracefulRestartWithContinue bails (no resume) if codex is still running", async () => {
    const { runner, sent } = makeRunner([true]); // didn't exit
    await runner.gracefulRestartWithContinue("sess");
    expect(sent.some((s) => s.includes("resume --last"))).toBe(false);
  });

  it("exit sends Ctrl-C then /exit (identical to claude)", async () => {
    const { runner, sent } = makeRunner([true]);
    await runner.exit("sess");
    expect(sent).toEqual(["raw:C-c", "keys:/exit"]);
  });
});
