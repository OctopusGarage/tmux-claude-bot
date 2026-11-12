import * as fs from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigResolver } from "../src/core/agents/agent-config-resolver.js";
import { CodexRunner, paneLooksReady } from "../src/core/agents/codex/codex-runner.js";
import {
  paneCodexAdditionalSafetyAction,
  paneConfirmAction,
  paneNeedsConfirm,
} from "../src/core/agents/runner-base.js";
import type { OutputProcessor } from "../src/core/session/output.js";
import type { TmuxBridge } from "../src/core/session/tmux.js";

const FIXTURES = join(import.meta.dirname, "fixtures");
const ready = fs.readFileSync(join(FIXTURES, "codex-ready-pane.txt"), "utf8");
const busy = fs.readFileSync(join(FIXTURES, "codex-busy-pane.txt"), "utf8");
const updateMenu = `${fs.readFileSync(join(FIXTURES, "codex-update-pane.txt"), "utf8")}\n\n`;
const updateWithReleaseNotes = fs.readFileSync(
  join(FIXTURES, "codex-update-release-notes-pane.txt"),
  "utf8",
);
const legacyUpdateMenu = updateMenu
  .replace("Update available ·", "Update available!")
  .replace("enter continue · esc skip", "Press enter to continue");
function selectUpdateOption(menu: string, option: number | null): string {
  return menu.replace(/^› /m, "  ").replace(new RegExp(`^  ${option}\\.`, "m"), `› ${option}.`);
}

const postUpdateBoot = "› Previous conversation\nStarting Codex\nLoading resources\nPlease wait";
const completedGoalPane = [
  "◦ Working (2s • esc to interrupt)",
  "",
  "› Find and fix a bug in @filename",
  "",
  "main · Context 14% left · weekly 9% left · Goal achieved (19m)",
].join("\n");
const completedTurnPane = [
  "◦ Working (46s • esc to interrupt)",
  "",
  "• [LOOP_SUPERVISOR_DONE:run-1]",
  "",
  "─ Worked for 9m 03s ─",
  "",
  "› Write tests for @filename",
  "",
  "main · Context 53% left · weekly 6% left",
].join("\n");

describe("codex pane heuristics", () => {
  it("ready when no 'esc to interrupt' spinner is present", () => {
    expect(paneLooksReady(ready)).toBe(true);
  });

  it("not ready while codex is working", () => {
    expect(paneLooksReady(busy)).toBe(false);
  });

  it("is ready when a completed goal footer supersedes a stale working marker", () => {
    expect(paneLooksReady(completedGoalPane)).toBe(true);
  });

  it("is ready when the current Codex completion banner supersedes a stale working marker", () => {
    expect(paneLooksReady(completedTurnPane)).toBe(true);
  });

  it("does not mistake ordinary worked-for prose for a Codex completion banner", () => {
    expect(
      paneLooksReady(
        "› Summarize the history\n- Worked for 2h on the migration\n• Working (1s • esc to interrupt)\n- Worked for 3h",
      ),
    ).toBe(false);
  });

  it("is not ready when a new working marker follows an earlier completed goal", () => {
    expect(
      paneLooksReady(
        `${completedGoalPane}\n› Start another task\n• Working (1s • esc to interrupt)`,
      ),
    ).toBe(false);
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

  it("chooses Yes on the Claude bypass gate instead of confirming the default No", () => {
    const bypass =
      "WARNING: Claude Code running in Bypass Permissions mode\n\n  ❯ 1. No, exit\n    2. Yes, I accept\n\n  Enter to confirm · Esc to cancel";
    expect(paneConfirmAction(bypass)).toEqual({ sendRawKeys: ["Down", "Enter"] });
  });

  it("skips the Codex update prompt instead of confirming the default update action", () => {
    const updatePrompt = [
      "  Update available! 0.150.1 -> 0.151.0",
      "› 1. Update now (runs `npm install -g @openai/codex`)",
      "  2. Skip",
      "  3. Skip until next version",
      "Press enter to continue",
    ].join("\n");

    expect(paneNeedsConfirm(updatePrompt)).toBe(true);
    expect(paneConfirmAction(updatePrompt)).toEqual({ sendRawKeys: ["Down", "Enter"] });
  });

  it("does not treat a stale Codex update prompt above a shell prompt as active", () => {
    const staleUpdatePrompt = [
      "  Update available! 0.150.1 -> 0.151.0",
      "› 1. Update now (runs `npm install -g @openai/codex`)",
      "  2. Skip",
      "  3. Skip until next version",
      "Press enter to continue",
      "(base) user@host:~/repo|main ⇒",
    ].join("\n");

    expect(paneNeedsConfirm(staleUpdatePrompt)).toBe(false);
  });

  it.each([1, 2, 3])("uses only Escape for current update selection %i", (option) => {
    const pane = selectUpdateOption(updateMenu, option);
    expect(paneNeedsConfirm(pane)).toBe(true);
    expect(paneConfirmAction(pane)).toEqual({ sendRawKey: "Escape" });
    expect(paneLooksReady(pane)).toBe(false);
  });

  it.each([1, 2, 3])("uses Escape for release-notes update selection %i", (option) => {
    const pane = selectUpdateOption(updateWithReleaseNotes, option);
    expect(paneNeedsConfirm(pane)).toBe(true);
    expect(paneConfirmAction(pane)).toEqual({ sendRawKey: "Escape" });
    expect(paneLooksReady(pane)).toBe(false);
  });

  it.each([
    updateWithReleaseNotes.replace("https://github.com/openai/codex/releases/latest", "unknown"),
    updateWithReleaseNotes.replace("  Release notes:", "  Unknown metadata:"),
    updateWithReleaseNotes
      .replace("  Release notes:", "  Unknown metadata:")
      .replace("enter continue · esc skip", "Choose an option"),
    updateWithReleaseNotes.replace(
      "› 1.",
      "  Release notes: https://github.com/openai/codex/releases/latest\n› 1.",
    ),
  ])("blocks an expanded update menu with unrecognized metadata", (pane) => {
    expect(paneNeedsConfirm(pane)).toBe(true);
    expect(paneConfirmAction(pane)).toBe("wait");
  });

  it.each(["user@host:~/repo $", "› ", "› Update available · investigate this text"])(
    "ignores historical release-notes update text above current input: %s",
    (input) => {
      expect(paneConfirmAction(`${updateWithReleaseNotes}\n${input}`)).toBe("wait");
      expect(paneNeedsConfirm(`${updateWithReleaseNotes}\n${input}`)).toBe(false);
    },
  );

  it.each([
    [1, { sendRawKeys: ["Down", "Enter"] }],
    [2, { sendRawKey: "Enter" }],
    [3, { sendRawKeys: ["Up", "Enter"] }],
  ])("selects temporary Skip safely from legacy option %i", (option, action) => {
    expect(paneConfirmAction(selectUpdateOption(legacyUpdateMenu, option as number))).toEqual(
      action,
    );
  });

  it.each([
    selectUpdateOption(legacyUpdateMenu, null),
    legacyUpdateMenu.replace("›", "?"),
    legacyUpdateMenu.replace("›", "??"),
    legacyUpdateMenu.replace("›", "selected"),
    legacyUpdateMenu.replace("  3. Skip until next version\n", ""),
    updateMenu.replace("enter continue · esc skip", "Press enter to continue or cancel"),
  ])("does not blindly confirm an uncertain update menu", (pane) => {
    expect(paneConfirmAction(pane)).toBe("wait");
    expect(paneLooksReady(pane)).toBe(false);
  });

  it.each(["user@host:~/repo $", "› ", "› Update available · investigate this text"])(
    "does not act on a stale menu above current input: %s",
    (input) => {
      expect(paneConfirmAction(`${updateMenu}\n${input}`)).toBe("wait");
      expect(paneNeedsConfirm(`${updateMenu}\n${input}`)).toBe(false);
    },
  );

  it.each([updateMenu, legacyUpdateMenu, updateWithReleaseNotes])(
    "does not act on update text typed into the composer",
    (menu) => expect(paneConfirmAction(menu.replace("  Update", "› Update"))).toBe("wait"),
  );

  it.each([postUpdateBoot, "› 2. Skip", `${updateMenu}\nuser@host:~/repo $`])(
    "does not use a historical chevron or numbered selector as a composer",
    (pane) => expect(paneLooksReady(pane)).toBe(false),
  );

  it("does not treat stale confirm text above a shell prompt as an active gate", () => {
    const stale =
      "WARNING: Claude Code running in Bypass Permissions mode\n\n  ❯ 1. No, exit\n    2. Yes, I accept\n\n  Enter to confirm · Esc to cancel\n(base) user@host:~/repo|main ⇒";
    expect(paneNeedsConfirm(stale)).toBe(false);
  });

  it("keeps waiting on codex additional safety checks instead of treating them as confirm gates", () => {
    const safetyMenu = [
      "Additional safety checks",
      "This request requires additional safety checks, which can take extra time.",
      "› 1. Retry with a faster model",
      "  2. Keep waiting",
      "  3. Learn more",
      "",
      "Press enter to confirm or esc to go back",
    ].join("\n");

    expect(paneNeedsConfirm(safetyMenu)).toBe(false);
    expect(paneCodexAdditionalSafetyAction(safetyMenu)).toEqual({
      sendRawKeys: ["Down", "Enter"],
    });
  });
});

describe("CodexRunner update readiness", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function makeRunner(frames: string[]) {
    let index = 0;
    const capturePane = vi.fn(async () => frames[Math.min(index++, frames.length - 1)] ?? "");
    const sendRawKey = vi.fn(async (_key: string) => {});
    const runner = new CodexRunner({
      bridge: {
        resolveSessionName: async () => "sess",
        capturePane,
        sendRawKey,
      } as unknown as TmuxBridge,
      output: {} as OutputProcessor,
      configResolver: { isCodexRunning: async () => true } as unknown as ConfigResolver,
      codexCommand: "codex --yolo",
      idlePollTicks: 2,
      pollIntervalMs: 10,
      maxWaitReadyMs: 100,
      maxWaitDoneMs: 100,
    });
    return { runner, capturePane, sendRawKey };
  }

  it("waits past a stable post-skip boot pane for a fresh composer", async () => {
    const frames = [updateMenu, ...Array<string>(4).fill(postUpdateBoot), ready];
    const { runner, capturePane, sendRawKey } = makeRunner(frames);
    const wait = runner.waitUntilReady("sess");
    await Promise.all([wait, vi.runAllTimersAsync()]);
    expect(capturePane).toHaveBeenCalledTimes(frames.length);
    expect(sendRawKey.mock.calls.map(([key]) => key)).toEqual(["Escape"]);
  });

  it("does not accept a stable release-notes update menu as startup readiness", async () => {
    const frames = [...Array<string>(4).fill(updateWithReleaseNotes), postUpdateBoot, ready];
    const { runner, capturePane, sendRawKey } = makeRunner(frames);
    const wait = runner.waitUntilReady("sess");
    await Promise.all([wait, vi.runAllTimersAsync()]);
    expect(capturePane).toHaveBeenCalledTimes(frames.length);
    expect(sendRawKey.mock.calls.map(([key]) => key)).toEqual(Array<string>(4).fill("Escape"));
  });

  it.each([
    ["persistent menu", [updateMenu]],
    ["persistent release-notes menu", [updateWithReleaseNotes]],
    [
      "unknown release-notes metadata",
      [updateWithReleaseNotes.replace("  Release notes:", "  Unknown metadata:")],
    ],
    ["post-skip boot", [updateMenu, postUpdateBoot]],
    ["post-skip boot without a chevron", [updateMenu, "Starting Codex\nLoading\nPlease wait"]],
    ["unknown legacy selection", [selectUpdateOption(legacyUpdateMenu, null)]],
    ["unknown footer", [updateMenu.replace("enter continue · esc skip", "Choose an option")]],
  ])("times out on %s within the existing readiness budget", async (_name, frames) => {
    const { runner, capturePane, sendRawKey } = makeRunner(frames);
    const wait = expect(runner.waitUntilReady("sess")).rejects.toThrow(
      "Codex did not become ready in time",
    );
    await Promise.all([wait, vi.runAllTimersAsync()]);
    expect(capturePane).toHaveBeenCalledTimes(10);
    expect(sendRawKey.mock.calls.every(([key]) => key === "Escape")).toBe(true);
  });

  it.each([updateMenu, updateWithReleaseNotes])(
    "does not skip an update menu while waiting for normal input",
    async (menu) => {
      const { runner, sendRawKey } = makeRunner([menu]);
      const wait = expect(runner.waitUntilInputReady("sess")).rejects.toThrow(
        "Codex did not become ready in time",
      );
      await Promise.all([wait, vi.runAllTimersAsync()]);
      expect(sendRawKey).not.toHaveBeenCalled();
    },
  );
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

    expect(sent[0]).toBe("raw:C-u"); // clear stale shell input before launch
    expect(sent[1]).toBe("keys:codex --yolo"); // then launch
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

  it("serializes concurrent starts for the same session so the launch command is typed once", async () => {
    let running = false;
    const sent: string[] = [];
    const bridge = {
      resolveSessionName: async (s?: string) => s ?? "sess",
      capturePane: async () => "› type here\n  gpt-5.5 · /proj",
      sendKeys: async (t: string) => {
        sent.push(`keys:${t}`);
        if (t === "codex --yolo") running = true;
      },
      sendRawKey: async (k: string) => {
        sent.push(`raw:${k}`);
      },
    } as unknown as TmuxBridge;
    const configResolver = {
      isCodexRunning: async () => running,
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

    await Promise.all([runner.start("sess"), runner.start("sess")]);

    expect(sent.filter((entry) => entry === "raw:C-u")).toHaveLength(1);
    expect(sent.filter((entry) => entry === "keys:codex --yolo")).toHaveLength(1);
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

    expect(sent[0]).toBe("raw:C-u"); // clear stale shell input before resume
    expect(sent[1]).toBe("keys:codex --yolo resume uuid-9"); // then resume
    expect(sent).toContain("raw:Enter"); // trust gate auto-accepted
  });
});

describe("CodexRunner.waitUntilDone", () => {
  it("reports done immediately after the current Codex completion banner", async () => {
    const bridge = {
      resolveSessionName: async (s?: string) => s ?? "sess",
      capturePane: async () => completedTurnPane,
    } as unknown as TmuxBridge;
    const configResolver = {
      isCodexRunning: async () => true,
    } as unknown as ConfigResolver;
    const runner = new CodexRunner({
      bridge,
      output: { process: (s: string) => s } as OutputProcessor,
      configResolver,
      codexCommand: "codex --yolo",
      idlePollTicks: 1,
      pollIntervalMs: 1,
      maxWaitReadyMs: 5,
      maxWaitDoneMs: 5,
    });

    await expect(runner.waitUntilDone("sess")).resolves.toMatchObject({ done: true });
  });

  it("does not report done while the stable pane still has the active-turn marker", async () => {
    const bridge = {
      resolveSessionName: async (s?: string) => s ?? "sess",
      capturePane: async () => busy,
    } as unknown as TmuxBridge;
    const configResolver = {
      isCodexRunning: async () => true,
    } as unknown as ConfigResolver;
    const runner = new CodexRunner({
      bridge,
      output: { process: (s: string) => s } as OutputProcessor,
      configResolver,
      codexCommand: "codex --yolo",
      idlePollTicks: 1,
      pollIntervalMs: 1,
      maxWaitReadyMs: 50,
      maxWaitDoneMs: 5,
    });

    const result = await runner.waitUntilDone("sess");

    expect(result.done).toBe(false);
    expect(result.output).toContain("esc to interrupt");
  });

  it("does not report done while codex is waiting at the additional safety check menu", async () => {
    const sent: string[] = [];
    const safetyMenu = [
      "Additional safety checks",
      "This request requires additional safety checks, which can take extra time.",
      "› 1. Retry with a faster model",
      "  2. Keep waiting",
      "  3. Learn more",
      "",
      "Press enter to confirm or esc to go back",
    ].join("\n");
    const bridge = {
      resolveSessionName: async (s?: string) => s ?? "sess",
      capturePane: async () => safetyMenu,
      sendRawKey: async (key: string) => {
        sent.push(key);
      },
    } as unknown as TmuxBridge;
    const configResolver = {
      isCodexRunning: async () => true,
    } as unknown as ConfigResolver;
    const runner = new CodexRunner({
      bridge,
      output: { process: (s: string) => s } as OutputProcessor,
      configResolver,
      codexCommand: "codex --yolo",
      idlePollTicks: 1,
      pollIntervalMs: 1,
      maxWaitReadyMs: 50,
      maxWaitDoneMs: 5,
    });

    const result = await runner.waitUntilDone("sess");

    expect(result.done).toBe(false);
    expect(result.output).toContain("Additional safety checks");
    expect(sent).toContain("Down");
    expect(sent).toContain("Enter");
  });
});

describe("CodexRunner.waitUntilInputReady", () => {
  it("accepts input after a completed goal even when the old working line remains visible", async () => {
    const bridge = {
      resolveSessionName: async (s?: string) => s ?? "sess",
      capturePane: async () => completedGoalPane,
    } as unknown as TmuxBridge;
    const configResolver = {
      isCodexRunning: async () => true,
    } as unknown as ConfigResolver;
    const runner = new CodexRunner({
      bridge,
      output: { process: (s: string) => s } as OutputProcessor,
      configResolver,
      codexCommand: "codex --yolo",
      idlePollTicks: 1,
      pollIntervalMs: 1,
      maxWaitReadyMs: 5,
      maxWaitDoneMs: 5,
    });

    await expect(runner.waitUntilInputReady("sess")).resolves.toBeUndefined();
  });

  it("does not auto-confirm a gate while waiting to send normal text", async () => {
    const sent: string[] = [];
    const bridge = {
      resolveSessionName: async (s?: string) => s ?? "sess",
      capturePane: async () =>
        "Do you trust this directory?\n› 1. Yes, continue\nPress enter to continue",
      sendRawKey: async (k: string) => {
        sent.push(k);
      },
    } as unknown as TmuxBridge;
    const configResolver = {
      isCodexRunning: async () => true,
    } as unknown as ConfigResolver;
    const runner = new CodexRunner({
      bridge,
      output: { process: (s: string) => s } as OutputProcessor,
      configResolver,
      codexCommand: "codex --yolo",
      idlePollTicks: 1,
      pollIntervalMs: 1,
      maxWaitReadyMs: 5,
      maxWaitDoneMs: 5,
    });

    await expect(runner.waitUntilInputReady("sess")).rejects.toThrow(
      "Codex did not become ready in time",
    );
    expect(sent).toEqual([]);
  });
});

describe("CodexRunner restart", () => {
  // isCodexRunning yields `running` per call (clamped to the last value), so a
  // restart can model "still running through N Ctrl-C, then gone".
  function makeRunner(
    running: boolean[],
    liveSessionId: string | null = null,
    storedSessionId: string | null = null,
  ) {
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
      lastLiveSessionId: () => storedSessionId,
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
    const { runner, sent } = makeRunner([false]); // no live session id, no stored id
    await runner.gracefulRestartWithContinue("sess");
    expect(sent).toContain("keys:codex --yolo resume --last");
  });

  it("gracefulRestartWithContinue resumes the last-observed live id when the live id can't be read (Free Projects disambiguation)", async () => {
    // Live id unreadable (codex idle, not holding the rollout open), but a prior
    // observation recorded the exact id — resume THAT, not `resume --last` (which
    // could pick a co-located free-project session sharing the same cwd).
    const stored = "99999999-aaaa-bbbb-cccc-dddddddddddd";
    const { runner, sent } = makeRunner([false], null, stored);
    await runner.gracefulRestartWithContinue("sess");
    expect(sent).toContain(`keys:codex --yolo resume ${stored}`);
    expect(sent.some((s) => s.includes("resume --last"))).toBe(false);
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

describe("Codex fresh launch eligibility", () => {
  it.each(["codex", "codex --yolo", "codex --no-alt-screen --yolo"])(
    "recognizes direct interactive launch %s",
    (command) => {
      expect(CodexRunner.prototype.isFreshStartCommand(command)).toBe(true);
    },
  );
  it.each([
    "codex resume --last",
    "codex fork",
    "codex exec task",
    "codex-custom",
    "sh -c codex",
    "codex; echo x",
  ])("does not grant unknown or resumed launch %s", (command) => {
    expect(CodexRunner.prototype.isFreshStartCommand(command)).toBe(false);
  });
});
