import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CardActionEvent } from "@larksuiteoapi/node-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeCardActionHandler } from "../../../src/adapters/lark/card-actions.js";
import { OpportunityStore } from "../../../src/core/opportunities/store.js";
import { bindGroup, getBinding, unbindGroup } from "../../../src/core/projects/group-bindings.js";
import { appendRecentProject } from "../../../src/core/projects/recentProjects.js";
import { sessionNameFromPath } from "../../../src/core/projects/sessionPathMap.js";
import { storeInputList } from "../../../src/core/read/recent-inputs.js";
import { sessionShortId } from "../../../src/shared/utils/hash.js";
import { fakeChannel, fakeDeps } from "./_fakes.js";

vi.mock("../../../src/core/platform/clipboard.js", () => ({
  copyToClipboard: vi.fn(async () => true),
}));

// Keep the real VOICE_LANGS/resolveWhisperLanguage; stub the .env writer and the
// host-mutating install so `voiceinstall` is exercisable without a real install.
const installVoiceMock = vi.fn(
  async (): Promise<{ status: string; bin?: string; message?: string }> => ({
    status: "ok",
    bin: "/x/mlx_whisper",
  }),
);
vi.mock("../../../src/core/read/voice-support.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/core/read/voice-support.js")>()),
  persistEnvVar: vi.fn(),
  checkVoiceSupport: vi.fn(() => ({ ready: false, reason: "not-installed" })),
  isVoicePlatformSupported: vi.fn(() => true),
  installVoice: () => installVoiceMock(),
}));

function evt(value: unknown, over: Partial<CardActionEvent> = {}): CardActionEvent {
  return {
    messageId: "msg-1",
    chatId: "chat-1",
    operator: { openId: "ou_me" },
    action: { value, tag: "button" },
    ...over,
  } as CardActionEvent;
}

function initGitProject(projectDir: string): void {
  execFileSync("git", ["init"], { cwd: projectDir, stdio: "ignore" });
}

describe("makeCardActionHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("voicelangmenu → sends the voice-install card when voice is missing", async () => {
    const channel = fakeChannel();
    const handle = makeCardActionHandler(channel, fakeDeps());
    await handle(evt({ cmd: "voicelangmenu" }));
    expect(JSON.stringify(channel.cards())).toContain("voiceinstall");
  });

  it("prompttranslate → sends the translation picker as a regular card", async () => {
    const channel = fakeChannel();
    const handle = makeCardActionHandler(channel, fakeDeps());
    await handle(evt({ cmd: "prompttranslate" }));
    expect(JSON.stringify(channel.cards())).toContain("翻译模式");
  });

  it("prompttranslate off → re-sends the translation picker card", async () => {
    const channel = fakeChannel();
    const handle = makeCardActionHandler(channel, fakeDeps());
    await handle(evt({ cmd: "prompttranslate", arg: "off" }));
    expect(JSON.stringify(channel.cards())).toContain("翻译模式");
  });

  it("qcancel → cancels that queued message by (session, id)", async () => {
    const cancelQueued = vi.fn(() => true);
    const channel = fakeChannel();
    const deps = fakeDeps({ queue: { cancelQueued } });
    await makeCardActionHandler(channel, deps)(evt({ cmd: "qcancel", s: "proj-1", id: "m-7" }));
    expect(cancelQueued).toHaveBeenCalledWith("proj-1", "m-7", expect.any(String));
    // On success the queue's reject closure posts the confirmation, so the handler
    // itself sends nothing extra.
    expect(channel.texts()).toHaveLength(0);
  });

  it("qcancel → reports 'already gone' when cancelQueued returns false (no false confirm)", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps({ queue: { cancelQueued: vi.fn(() => false) } });
    await makeCardActionHandler(channel, deps)(evt({ cmd: "qcancel", s: "proj-1", id: "gone" }));
    // Must NOT falsely confirm a cancellation; say the item is no longer queued.
    expect(channel.texts().some((t) => t.includes("不在队列"))).toBe(true);
    expect(channel.texts().some((t) => t.includes("已取消"))).toBe(false);
  });

  it("dangerous control button asks for confirmation before enqueueing", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps();

    await makeCardActionHandler(channel, deps)(evt({ cmd: "exit" }));

    expect(deps.queue.enqueued).toHaveLength(0);
    expect(JSON.stringify(channel.cards())).toContain("确认");
    expect(JSON.stringify(channel.cards())).toContain('"cmd":"confirm"');
    expect(JSON.stringify(channel.cards())).toContain('"action":"exit"');
  });

  it("confirmed dangerous control button enqueues the original action", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps();

    await makeCardActionHandler(channel, deps)(evt({ cmd: "confirm", action: "exit" }));

    expect(deps.queue.enqueued).toHaveLength(1);
    expect(deps.queue.enqueued[0]).toMatchObject({ sessionName: "proj-1", action: "exit" });
  });

  it("voiceinstall → runs the core install and replies the result (Feishu parity with Telegram)", async () => {
    installVoiceMock.mockResolvedValueOnce({ status: "ok", bin: "/x/mlx_whisper" });
    const channel = fakeChannel();
    await makeCardActionHandler(channel, fakeDeps())(evt({ cmd: "voiceinstall" }));
    expect(installVoiceMock).toHaveBeenCalled();
    // acks "installing…" then reports success
    expect(channel.texts().some((t) => t.includes("正在安装"))).toBe(true);
    expect(channel.texts().some((t) => t.includes("已就绪"))).toBe(true);
  });

  it("voiceinstall → surfaces a failure result", async () => {
    installVoiceMock.mockResolvedValueOnce({ status: "failed", message: "boom" });
    const channel = fakeChannel();
    await makeCardActionHandler(channel, fakeDeps())(evt({ cmd: "voiceinstall" }));
    expect(channel.texts().some((t) => t.includes("boom"))).toBe(true);
  });

  it("voicelang → sets WHISPER_LANGUAGE and falls back to install when voice is missing", async () => {
    const prev = process.env.LARK_WHISPER_LANGUAGE;
    try {
      const channel = fakeChannel();
      const handle = makeCardActionHandler(channel, fakeDeps());

      await handle(evt({ cmd: "voicelang", lang: "yue" }));

      expect(process.env.LARK_WHISPER_LANGUAGE).toBe("yue");
      expect(JSON.stringify(channel.cards())).toContain("voiceinstall");
    } finally {
      if (prev === undefined) delete process.env.LARK_WHISPER_LANGUAGE;
      else process.env.LARK_WHISPER_LANGUAGE = prev;
    }
  });

  it("voicelang with an unsupported code → no-op (not in VOICE_LANGS)", async () => {
    const channel = fakeChannel();
    await makeCardActionHandler(channel, fakeDeps())(evt({ cmd: "voicelang", lang: "klingon" }));
    expect(channel.sent).toHaveLength(0);
  });

  it("drops cardAction from a non-allowlisted operator", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps();
    const handler = makeCardActionHandler(channel, deps);

    await handler(evt({ cmd: "help" }, { operator: { openId: "ou_stranger" } }));

    expect(channel.sent).toHaveLength(0);
  });

  it("a card with no cmd is inert", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps();
    const handler = makeCardActionHandler(channel, deps);

    await handler(evt({}));

    expect(channel.sent).toHaveLength(0);
  });

  it("'noop' is inert", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps();
    const handler = makeCardActionHandler(channel, deps);

    await handler(evt({ cmd: "noop" }));

    expect(channel.sent).toHaveLength(0);
    expect(deps.queue.enqueued).toHaveLength(0);
  });

  it("'help' sends the help card", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps();
    const handler = makeCardActionHandler(channel, deps);

    await handler(evt({ cmd: "help" }));

    expect(channel.cards()).toHaveLength(1);
  });

  // peek/listalive/recent render cards; current/queuestatus render text. history
  // renders a card only when the session has a path mapping (otherwise a "缺少路径"
  // text hint) — covered separately in views.test.ts, so it's excluded here.
  it.each([
    ["peek", "card"],
    ["listalive", "card"],
    ["recent", "card"],
    ["current", "text"],
    ["queuestatus", "text"],
  ])("'%s' routes to its view fn (%s output)", async (cmd, kind) => {
    const channel = fakeChannel();
    const deps = fakeDeps();
    const handler = makeCardActionHandler(channel, deps);

    await handler(evt({ cmd }));

    if (kind === "card") {
      expect(channel.cards().length).toBeGreaterThanOrEqual(1);
    } else {
      expect(channel.texts().length).toBeGreaterThanOrEqual(1);
    }
  });

  it("'history' routes to sendHistory (replies the path-mapping hint here)", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps();
    const handler = makeCardActionHandler(channel, deps);

    await handler(evt({ cmd: "history" }));

    expect(channel.texts().some((t) => t.includes("缺少项目路径映射"))).toBe(true);
  });

  it("oppdiscuss opens the project and queues a discussion prompt, not implementation", async () => {
    const oldStateDir = process.env.TCB_STATE_DIR;
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-lark-opp-action-"));
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-lark-opp-project-"));
    process.env.TCB_STATE_DIR = stateDir;
    try {
      initGitProject(projectDir);
      const [suggestion] = new OpportunityStore().upsertDiscoveryReport({
        report: {
          projectId: "api",
          projectName: "api",
          generatedAt: "2026-07-29T09:00:00.000Z",
          coverage: "partial",
          checkedSignals: ["docs"],
          skippedSignals: [],
          suggestions: [
            {
              title: "Add explain command",
              category: "developer-experience",
              confidence: "high",
              problem: "Users need manual log inspection.",
              whyNow: "Opportunity discovery found repeated support friction.",
              value: "Faster support.",
              evidence: ["support logs mention missing context"],
              recommendedApproach: "Discuss a read-only explain command.",
              alternatives: ["Keep raw logs only"],
              acceptanceCriteria: ["Owner confirms scope before implementation"],
              risks: ["Scope can grow"],
              nonGoals: ["Do not implement during discussion"],
              estimatedComplexity: "small",
              delegateRequirement: "Add the explain command after owner approval.",
            },
          ],
        },
        projectPath: projectDir,
        runId: "run-1",
        cooldownDays: 14,
        now: Date.parse("2026-07-29T09:00:00Z"),
      });
      if (suggestion === undefined) throw new Error("expected suggestion");
      const channel = fakeChannel();
      const deps = fakeDeps({
        config: {
          cdAllowedDirs: [projectDir],
          loopEngineering: {
            configFile: "",
            tickMs: 60_000,
            supervisor: {
              enabled: true,
              dir: stateDir,
              agent: "codex",
              poolSize: 1,
              resetBeforeWorkOrder: "compact",
            },
          },
        },
        bridge: {
          hasSession: vi.fn(async () => true),
          isPaneAlive: vi.fn(async () => true),
        },
      });

      await makeCardActionHandler(channel, deps)(evt({ cmd: "oppdiscuss", id: suggestion.id }));

      expect(deps.queue.enqueued).toHaveLength(1);
      expect(deps.queue.enqueued[0]?.action).toBe("text");
      expect(deps.queue.enqueued[0]?.text).toContain("Do not implement yet.");
      expect(JSON.stringify(channel.cards())).not.toContain("oppdelegate");
      expect(new OpportunityStore().get(suggestion.id)).toMatchObject({ status: "discussing" });
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
      if (oldStateDir === undefined) {
        delete process.env.TCB_STATE_DIR;
      } else {
        process.env.TCB_STATE_DIR = oldStateDir;
      }
    }
  });

  it("oppdiscuss blocks when the target project agent is busy", async () => {
    const oldStateDir = process.env.TCB_STATE_DIR;
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-lark-opp-busy-"));
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-lark-opp-busy-project-"));
    process.env.TCB_STATE_DIR = stateDir;
    try {
      const [suggestion] = new OpportunityStore().upsertDiscoveryReport({
        report: {
          projectId: "api",
          projectName: "api",
          generatedAt: "2026-07-29T09:00:00.000Z",
          coverage: "partial",
          checkedSignals: ["docs"],
          skippedSignals: [],
          suggestions: [
            {
              title: "Add explain command",
              category: "developer-experience",
              confidence: "high",
              problem: "Users need manual log inspection.",
              whyNow: "Opportunity discovery found repeated support friction.",
              value: "Faster support.",
              evidence: ["support logs mention missing context"],
              recommendedApproach: "Discuss a read-only explain command.",
              alternatives: ["Keep raw logs only"],
              acceptanceCriteria: ["Owner confirms scope before implementation"],
              risks: ["Scope can grow"],
              nonGoals: ["Do not implement during discussion"],
              estimatedComplexity: "small",
              delegateRequirement: "Add the explain command after owner approval.",
            },
          ],
        },
        projectPath: projectDir,
        runId: "run-1",
        cooldownDays: 14,
        now: Date.parse("2026-07-29T09:00:00Z"),
      });
      if (suggestion === undefined) throw new Error("expected suggestion");
      const channel = fakeChannel();
      const deps = fakeDeps({
        config: { cdAllowedDirs: [projectDir] },
        bridge: { hasSession: vi.fn(async () => true) },
        queue: { isSessionProcessing: vi.fn(() => true) },
      });

      await makeCardActionHandler(channel, deps)(evt({ cmd: "oppdiscuss", id: suggestion.id }));

      expect(channel.texts().join("\n")).toContain("项目 agent 当前正在处理任务");
      expect(deps.queue.enqueued).toHaveLength(0);
      expect(new OpportunityStore().get(suggestion.id)).toMatchObject({ status: "proposed" });
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
      if (oldStateDir === undefined) {
        delete process.env.TCB_STATE_DIR;
      } else {
        process.env.TCB_STATE_DIR = oldStateDir;
      }
    }
  });

  it("oppdiscuss blocks when the target worktree is dirty", async () => {
    const oldStateDir = process.env.TCB_STATE_DIR;
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-lark-opp-dirty-"));
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-lark-opp-dirty-project-"));
    process.env.TCB_STATE_DIR = stateDir;
    try {
      initGitProject(projectDir);
      writeFileSync(join(projectDir, "dirty.ts"), "export const dirty = true;\n");
      const [suggestion] = new OpportunityStore().upsertDiscoveryReport({
        report: {
          projectId: "api",
          projectName: "api",
          generatedAt: "2026-07-29T09:00:00.000Z",
          coverage: "partial",
          checkedSignals: ["docs"],
          skippedSignals: [],
          suggestions: [
            {
              title: "Add explain command",
              category: "developer-experience",
              confidence: "high",
              problem: "Users need manual log inspection.",
              whyNow: "Opportunity discovery found repeated support friction.",
              value: "Faster support.",
              evidence: ["support logs mention missing context"],
              recommendedApproach: "Discuss a read-only explain command.",
              alternatives: ["Keep raw logs only"],
              acceptanceCriteria: ["Owner confirms scope before implementation"],
              risks: ["Scope can grow"],
              nonGoals: ["Do not implement during discussion"],
              estimatedComplexity: "small",
              delegateRequirement: "Add the explain command after owner approval.",
            },
          ],
        },
        projectPath: projectDir,
        runId: "run-1",
        cooldownDays: 14,
        now: Date.parse("2026-07-29T09:00:00Z"),
      });
      if (suggestion === undefined) throw new Error("expected suggestion");
      const channel = fakeChannel();
      const deps = fakeDeps({
        config: { cdAllowedDirs: [projectDir] },
        bridge: { hasSession: vi.fn(async () => true) },
      });

      await makeCardActionHandler(channel, deps)(evt({ cmd: "oppdiscuss", id: suggestion.id }));

      const text = channel.texts().join("\n");
      expect(text).toContain("项目工作区不干净");
      expect(text).toContain("?? dirty.ts");
      expect(deps.queue.enqueued).toHaveLength(0);
      expect(new OpportunityStore().get(suggestion.id)).toMatchObject({ status: "proposed" });
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
      if (oldStateDir === undefined) {
        delete process.env.TCB_STATE_DIR;
      } else {
        process.env.TCB_STATE_DIR = oldStateDir;
      }
    }
  });

  it("oppdiscussall queues one combined discussion prompt for the batch", async () => {
    const oldStateDir = process.env.TCB_STATE_DIR;
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-lark-opp-batch-action-"));
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-lark-opp-batch-project-"));
    process.env.TCB_STATE_DIR = stateDir;
    try {
      initGitProject(projectDir);
      const suggestions = new OpportunityStore().upsertDiscoveryReport({
        report: {
          projectId: "api",
          projectName: "api",
          generatedAt: "2026-07-29T09:00:00.000Z",
          coverage: "partial",
          checkedSignals: ["docs"],
          skippedSignals: [],
          suggestions: [
            {
              title: "Add explain command",
              category: "developer-experience",
              confidence: "high",
              problem: "Users need manual log inspection.",
              whyNow: "Opportunity discovery found repeated support friction.",
              value: "Faster support.",
              evidence: ["support logs mention missing context"],
              recommendedApproach: "Discuss a read-only explain command.",
              alternatives: ["Keep raw logs only"],
              acceptanceCriteria: ["Owner confirms scope before implementation"],
              risks: ["Scope can grow"],
              nonGoals: ["Do not implement during discussion"],
              estimatedComplexity: "small",
              delegateRequirement: "Add the explain command after owner approval.",
            },
            {
              title: "Add regression coverage",
              category: "testing",
              confidence: "high",
              problem: "A workflow has no regression coverage.",
              whyNow: "Opportunity discovery found a fragile path.",
              value: "Safer maintenance.",
              evidence: ["tests miss the path"],
              recommendedApproach: "Discuss focused regression coverage.",
              alternatives: ["Manual QA only"],
              acceptanceCriteria: ["Owner confirms scope before implementation"],
              risks: ["Coverage can become shallow"],
              nonGoals: ["Do not add unrelated tests"],
              estimatedComplexity: "small",
              delegateRequirement: "Add regression coverage after owner approval.",
            },
          ],
        },
        projectPath: projectDir,
        runId: "run-1",
        cooldownDays: 14,
        now: Date.parse("2026-07-29T09:00:00Z"),
      });
      const ids = suggestions.map((suggestion) => suggestion.id);
      const channel = fakeChannel();
      const deps = fakeDeps({
        config: { cdAllowedDirs: [projectDir] },
        bridge: { hasSession: vi.fn(async () => true) },
      });

      await makeCardActionHandler(channel, deps)(evt({ cmd: "oppdiscussall", ids }));

      expect(deps.queue.enqueued).toHaveLength(1);
      expect(deps.queue.enqueued[0]?.action).toBe("text");
      expect(deps.queue.enqueued[0]?.text).toContain("as one combined scope");
      expect(deps.queue.enqueued[0]?.text).toContain(suggestions[0]?.id);
      expect(deps.queue.enqueued[0]?.text).toContain(suggestions[1]?.id);
      expect(JSON.stringify(channel.cards())).not.toContain("oppdelegate");
      expect(new OpportunityStore().get(ids[0] ?? "")).toMatchObject({ status: "discussing" });
      expect(new OpportunityStore().get(ids[1] ?? "")).toMatchObject({ status: "discussing" });
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
      if (oldStateDir === undefined) {
        delete process.env.TCB_STATE_DIR;
      } else {
        process.env.TCB_STATE_DIR = oldStateDir;
      }
    }
  });

  it("'switch' with a matching sid switches to that project", async () => {
    const session = "tmux_proj_alpha";
    const sid = sessionShortId(session);
    const channel = fakeChannel();
    const deps = fakeDeps({
      bridge: { listProjectSessions: vi.fn(async () => [session]) },
    });
    const handler = makeCardActionHandler(channel, deps);

    await handler(evt({ cmd: "switch", sid }));

    expect(deps.currentProject.set).toHaveBeenCalledWith("lark:chat-1", session);
    expect(channel.texts().some((t) => t.includes("已切换"))).toBe(true);
  });

  it("'remove' with a matching sid removes that project", async () => {
    const session = "tmux_proj_beta";
    const sid = sessionShortId(session);
    const channel = fakeChannel();
    const deps = fakeDeps({
      session: "other",
      bridge: { listProjectSessions: vi.fn(async () => [session]) },
      agent: { checkIfRunning: vi.fn(async () => false) },
    });
    const handler = makeCardActionHandler(channel, deps);

    await handler(evt({ cmd: "remove", sid }));

    expect(deps.bridge.killSession).toHaveBeenCalledWith(session);
    expect(channel.texts().some((t) => t.includes("已移除"))).toBe(true);
  });

  it("'remove' in a bound group is refused with a hint — manage projects in private chat", async () => {
    bindGroup("oc_grp_bound", { workspacePath: "/p/g", sessionName: "tmux_proj_g", label: "g" });
    const session = "tmux_proj_beta";
    const channel = fakeChannel();
    channel.setChatType("group");
    const deps = fakeDeps({
      bridge: { listProjectSessions: vi.fn(async () => [session]) },
      agent: { checkIfRunning: vi.fn(async () => false) },
    });
    const handler = makeCardActionHandler(channel, deps);

    await handler(evt({ cmd: "remove", sid: sessionShortId(session) }, { chatId: "oc_grp_bound" }));

    expect(deps.bridge.killSession).not.toHaveBeenCalled();
    expect(channel.texts().some((t) => t.includes("不能删除项目"))).toBe(true);
    unbindGroup("oc_grp_bound");
  });

  it("a card action in an unbound (lost-binding) group is ignored — buttons do nothing", async () => {
    const session = "tmux_proj_beta";
    const channel = fakeChannel();
    // No binding for this group, and it's a real group chat. Mirrors how text
    // is ignored in unbound groups — stale buttons must not act either.
    channel.setChatType("group");
    const deps = fakeDeps({
      bridge: { listProjectSessions: vi.fn(async () => [session]) },
      agent: { checkIfRunning: vi.fn(async () => false) },
    });
    const handler = makeCardActionHandler(channel, deps);

    await handler(evt({ cmd: "remove", sid: sessionShortId(session) }, { chatId: "oc_grp_rm" }));

    expect(deps.bridge.killSession).not.toHaveBeenCalled();
    expect(channel.sent).toHaveLength(0); // silent, like an ignored text message
  });

  it("a card action is ignored when the chat type can't be resolved (fail safe)", async () => {
    const session = "tmux_proj_beta";
    const channel = fakeChannel();
    channel.getChatInfo = vi.fn(async () => {
      throw new Error("network");
    });
    const deps = fakeDeps({
      bridge: { listProjectSessions: vi.fn(async () => [session]) },
      agent: { checkIfRunning: vi.fn(async () => false) },
    });
    const handler = makeCardActionHandler(channel, deps);

    await handler(evt({ cmd: "remove", sid: sessionShortId(session) }, { chatId: "oc_unknown" }));

    expect(deps.bridge.killSession).not.toHaveBeenCalled();
    expect(channel.sent).toHaveLength(0);
  });

  it("'switch' in a bound group is pinned — refuses and does not change project", async () => {
    bindGroup("oc_pinned", { workspacePath: "/p/pin", sessionName: "tmux_proj_pin", label: "pin" });
    const session = "tmux_proj_alpha";
    const channel = fakeChannel();
    const deps = fakeDeps({ bridge: { listProjectSessions: vi.fn(async () => [session]) } });
    const handler = makeCardActionHandler(channel, deps);

    await handler(evt({ cmd: "switch", sid: sessionShortId(session) }, { chatId: "oc_pinned" }));

    expect(deps.currentProject.set).not.toHaveBeenCalled();
    expect(channel.texts().some((t) => t.includes("已固定绑定"))).toBe(true);
    unbindGroup("oc_pinned"); // bindings are a module singleton over the shared temp dir
  });

  it("'addrecent' in a bound group is pinned — refuses, no project change", async () => {
    bindGroup("oc_pinned2", {
      workspacePath: "/p/pin",
      sessionName: "tmux_proj_pin",
      label: "pin",
    });
    const channel = fakeChannel();
    const deps = fakeDeps();
    const handler = makeCardActionHandler(channel, deps);

    await handler(evt({ cmd: "addrecent", sid: "whatever" }, { chatId: "oc_pinned2" }));

    expect(deps.currentProject.set).not.toHaveBeenCalled();
    expect(channel.texts().some((t) => t.includes("已固定绑定"))).toBe(true);
    unbindGroup("oc_pinned2");
  });

  it("'switch' with an unmatched sid does nothing observable", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps({
      bridge: { listProjectSessions: vi.fn(async () => ["tmux_proj_x"]) },
    });
    const handler = makeCardActionHandler(channel, deps);

    await handler(evt({ cmd: "switch", sid: "zzzzzz" }));

    expect(deps.currentProject.set).not.toHaveBeenCalled();
    expect(channel.sent).toHaveLength(0);
  });

  it("'addrecent' with a sid routes to addRecentBySid", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps();
    const handler = makeCardActionHandler(channel, deps);

    // No recent lines match → replies the "未找到短 id" message; that's enough to
    // prove the addrecent branch was taken.
    await handler(evt({ cmd: "addrecent", sid: "nomatch" }));

    expect(channel.texts().some((t) => t.includes("未找到短 id"))).toBe(true);
  });

  it("an IMMEDIATE cmd runs immediately (no enqueue, plain text)", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps({ bridge: { hasSession: vi.fn(async () => true) } });
    const handler = makeCardActionHandler(channel, deps);

    await handler(evt({ cmd: "status" }));

    expect(deps.queue.enqueued).toHaveLength(0);
    expect(channel.texts().some((t) => t.includes("运行中"))).toBe(true);
  });

  it("a confirmed QUEUED cmd is enqueued", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps();
    const handler = makeCardActionHandler(channel, deps);

    await handler(evt({ cmd: "confirm", action: "restart" }));

    expect(deps.queue.enqueued).toHaveLength(1);
    expect(deps.queue.enqueued[0]?.action).toBe("restart");
  });

  it("an unknown cmd is inert", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps();
    const handler = makeCardActionHandler(channel, deps);

    await handler(evt({ cmd: "totally-unknown" }));

    expect(channel.sent).toHaveLength(0);
    expect(deps.queue.enqueued).toHaveLength(0);
  });

  it("uilangmenu → sends the UI-language picker as a regular card", async () => {
    const channel = fakeChannel();
    const handle = makeCardActionHandler(channel, fakeDeps());
    await handle(evt({ cmd: "uilangmenu" }));
    expect(channel.cards()).toHaveLength(1);
  });

  it("uilang with a valid lang → sets UI language and re-sends the picker", async () => {
    const prev = process.env.LARK_UI_LANG;
    try {
      const channel = fakeChannel();
      const handle = makeCardActionHandler(channel, fakeDeps());

      await handle(evt({ cmd: "uilang", lang: "en" }));

      expect(process.env.LARK_UI_LANG).toBe("en");
      expect(channel.cards()).toHaveLength(1);
    } finally {
      if (prev === undefined) delete process.env.LARK_UI_LANG;
      else process.env.LARK_UI_LANG = prev;
    }
  });

  it("uilang with an unrecognised lang → no-op (isUiLang returns false)", async () => {
    const channel = fakeChannel();
    const handle = makeCardActionHandler(channel, fakeDeps());
    await handle(evt({ cmd: "uilang", lang: "klingon" }));
    expect(channel.sent).toHaveLength(0);
  });

  // --- project-group buttons ---
  describe("project-group buttons", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "tcb-ca-grp-"));
      process.env.TCB_STATE_DIR = dir;
    });
    afterEach(() => {
      delete process.env.TCB_STATE_DIR;
      rmSync(dir, { recursive: true, force: true });
    });

    it("groupmenu in a non-bound chat → sends the new-group picker", async () => {
      const channel = fakeChannel();
      await makeCardActionHandler(channel, fakeDeps())(evt({ cmd: "groupmenu" }));
      expect(JSON.stringify(channel.cards())).toContain("新建项目群");
    });

    it("groupmenu in a bound group → sends the bound-group management card", async () => {
      bindGroup("chat-1", { workspacePath: dir, sessionName: "s", label: "projZ" });
      const channel = fakeChannel();
      await makeCardActionHandler(channel, fakeDeps())(evt({ cmd: "groupmenu" }));
      expect(JSON.stringify(channel.cards())).toContain("projZ");
    });

    it("rebind → sends the bind picker", async () => {
      const channel = fakeChannel();
      await makeCardActionHandler(channel, fakeDeps())(evt({ cmd: "rebind" }));
      expect(JSON.stringify(channel.cards())).toContain("绑定本群");
    });

    it("unbind → removes the binding and confirms", async () => {
      bindGroup("chat-1", { workspacePath: dir, sessionName: "s", label: "projZ" });
      const channel = fakeChannel();
      await makeCardActionHandler(channel, fakeDeps())(evt({ cmd: "unbind" }));
      expect(getBinding("chat-1")).toBeNull();
      expect(channel.texts().some((t) => t.includes("已解除"))).toBe(true);
    });

    it("restore → re-anchors and confirms", async () => {
      bindGroup("chat-1", { workspacePath: dir, sessionName: "s", label: "projZ" });
      const channel = fakeChannel();
      const deps = fakeDeps({
        bridge: { hasSession: vi.fn(async () => true) },
        currentProject: { get: vi.fn(async () => "s") },
      });
      await makeCardActionHandler(channel, deps)(evt({ cmd: "restore" }));
      expect(channel.texts().some((t) => t.includes("已恢复"))).toBe(true);
    });

    it("bindhere in a bound group → rebinds the current group to that recent project", async () => {
      // bindhere is reached only from a bound group's rebind picker, so the
      // chat is already a project group; bindhere re-anchors it elsewhere.
      bindGroup("chat-1", { workspacePath: "/old", sessionName: "s-old", label: "old" });
      const deps = fakeDeps();
      await appendRecentProject(dir, deps.config.projectSessionPrefix);
      const sid = sessionShortId(sessionNameFromPath(dir, deps.config.projectSessionPrefix));
      const channel = fakeChannel();
      await makeCardActionHandler(channel, deps)(evt({ cmd: "bindhere", sid }));
      expect(getBinding("chat-1")?.workspacePath).toBe(dir);
    });

    it("bindhere in a private chat → refused (group only), no binding written", async () => {
      const deps = fakeDeps();
      await appendRecentProject(dir, deps.config.projectSessionPrefix);
      const sid = sessionShortId(sessionNameFromPath(dir, deps.config.projectSessionPrefix));
      const channel = fakeChannel(); // default chat type p2p, chat-1 not bound
      await makeCardActionHandler(channel, deps)(evt({ cmd: "bindhere", sid }));
      expect(getBinding("chat-1")).toBeNull();
      expect(channel.texts().some((t) => t.includes("群"))).toBe(true);
    });
  });

  // --- multi-command start picker ---
  describe("start picker", () => {
    const multi = {
      config: {
        startCommands: [
          { label: "A", command: "echo" },
          { label: "B", command: "bash" },
        ],
      },
      // not running → /start offers the picker rather than "already running"
      agent: { checkIfRunning: vi.fn(async () => false) },
    };

    it("start with >1 command → sends the picker instead of starting", async () => {
      const channel = fakeChannel();
      const deps = fakeDeps(multi);
      await makeCardActionHandler(channel, deps)(evt({ cmd: "start" }));
      expect(JSON.stringify(channel.cards())).toContain("选择启动方式");
      expect(deps.agent.start).not.toHaveBeenCalled();
    });

    it("start → rejects with 'already running' (no picker) when an agent is live", async () => {
      const channel = fakeChannel();
      const deps = fakeDeps({
        ...multi,
        agent: { checkIfRunning: vi.fn(async () => true) }, // already running
      });
      await makeCardActionHandler(channel, deps)(evt({ cmd: "start" }));
      expect(JSON.stringify(channel.cards())).not.toContain("选择启动方式"); // no picker
      expect(deps.agent.start).not.toHaveBeenCalled();
    });

    it("startpick → starts the chosen command and confirms", async () => {
      const channel = fakeChannel();
      const deps = fakeDeps(multi);
      await makeCardActionHandler(channel, deps)(evt({ cmd: "startpick", idx: 1 }));
      // performStart pins a claude conversation id, so the launched command is
      // "bash --session-id <uuid>"; assert the chosen flavor (bash), not equality.
      expect(deps.agent.start).toHaveBeenCalledWith("proj-1", expect.stringContaining("bash"));
      expect(channel.texts().some((t) => t.includes("B"))).toBe(true);
    });

    it("startpick → reports preflight failures instead of going silent", async () => {
      const channel = fakeChannel();
      const missingBinary = join(tmpdir(), "__tcb_missing_codex_for_lark_preflight__");
      const deps = fakeDeps({
        config: {
          startCommands: [
            {
              label: "Codex YOLO",
              command: `${missingBinary} --yolo`,
              agent: "codex",
            },
          ],
        },
        agent: { checkIfRunning: vi.fn(async () => false) },
      });

      await makeCardActionHandler(channel, deps)(evt({ cmd: "startpick", idx: 0 }));

      expect(deps.agent.start).not.toHaveBeenCalled();
      expect(channel.texts()).toHaveLength(1);
      expect(channel.texts().some((t) => t.includes(missingBinary))).toBe(true);
    });
  });

  describe("directory browser", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "tcb-lk-browse-"));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it("addproject (help-card button) opens the browser", async () => {
      const channel = fakeChannel();
      const deps = fakeDeps({ config: { cdAllowedDirs: [dir] } });
      await makeCardActionHandler(channel, deps)(evt({ cmd: "addproject" }));
      expect(JSON.stringify(channel.cards())).toContain("browsecancel");
    });

    it("a navigation tap renders a browser card (with the cancel button)", async () => {
      const channel = fakeChannel();
      const deps = fakeDeps({ config: { cdAllowedDirs: [dir] } });
      await makeCardActionHandler(channel, deps)(evt({ cmd: "browseroot", idx: 0 }));
      // Regular interactive card, so it lands in cards().
      expect(JSON.stringify(channel.cards())).toContain("browsecancel");
    });

    it("browsecreate at the current dir creates the project session", async () => {
      const channel = fakeChannel();
      const deps = fakeDeps({
        config: { cdAllowedDirs: [dir] },
        bridge: { hasSession: vi.fn(async () => false) },
      });
      const handle = makeCardActionHandler(channel, deps);
      await handle(evt({ cmd: "browseroot", idx: 0 })); // cwd ← the only root (dir)
      await handle(evt({ cmd: "browsecreate" }));
      expect(deps.bridge.createSession).toHaveBeenCalledWith(expect.any(String), dir);
    });

    it("browsecancel forgets the state and acknowledges", async () => {
      const channel = fakeChannel();
      const deps = fakeDeps({ config: { cdAllowedDirs: [dir] } });
      await makeCardActionHandler(channel, deps)(evt({ cmd: "browsecancel" }));
      expect(channel.texts().some((t) => t.includes("已取消"))).toBe(true);
    });

    it("browsenewfolder prompts for a name once a dir is in view", async () => {
      const channel = fakeChannel();
      const deps = fakeDeps({ config: { cdAllowedDirs: [dir] } });
      const handle = makeCardActionHandler(channel, deps);
      await handle(evt({ cmd: "browseroot", idx: 0 })); // arm cwd = dir
      await handle(evt({ cmd: "browsenewfolder" }));
      // The prompt echoes the breadcrumb (~ or the dir path).
      expect(channel.texts().length).toBeGreaterThan(0);
    });
  });

  // --- inputredo (re-run a /inputs entry as an editable draft) ---
  describe("inputredo", () => {
    it("taps a stored input → hands the verbatim prompt back as a raw {text} draft", async () => {
      const token = storeInputList("proj-1", ["first prompt", "second prompt"]);
      const channel = fakeChannel();
      await makeCardActionHandler(channel, fakeDeps())(evt({ cmd: "inputredo", token, idx: 1 }));
      // Raw `{ text }` send (skips the markdown/tildeify pass) — lands in `sent`,
      // NOT texts() (which only collects `{ markdown }`).
      expect(channel.sent).toHaveLength(1);
      expect(channel.sent[0]?.input).toEqual({ text: "second prompt" });
    });

    it("an expired/unknown token → replies the 'list expired' hint", async () => {
      const channel = fakeChannel();
      await makeCardActionHandler(
        channel,
        fakeDeps(),
      )(evt({ cmd: "inputredo", token: "nope", idx: 0 }));
      expect(channel.texts().some((t) => t.includes("列表已过期"))).toBe(true);
    });

    it("a non-numeric idx → no-op (malformed value guard)", async () => {
      const token = storeInputList("proj-1", ["p"]);
      const channel = fakeChannel();
      await makeCardActionHandler(
        channel,
        fakeDeps(),
      )(evt({ cmd: "inputredo", token } as unknown as Record<string, unknown>));
      expect(channel.sent).toHaveLength(0);
    });
  });

  // --- restart picker ---
  describe("restart picker", () => {
    const multi = {
      config: {
        startCommands: [
          { label: "A", command: "echo" },
          { label: "B", command: "bash" },
        ],
      },
      agent: { checkIfRunning: vi.fn(async () => true) }, // running → restart picker offered
    };

    it("restart with >1 command → sends the picker (mode=restart) instead of restarting", async () => {
      const channel = fakeChannel();
      const deps = fakeDeps(multi);
      await makeCardActionHandler(channel, deps)(evt({ cmd: "confirm", action: "restart" }));
      expect(JSON.stringify(channel.cards())).toContain("选择启动方式");
      // It is the picker, not the queued-action path.
      expect(deps.queue.enqueued).toHaveLength(0);
    });

    it("restartpick → restarts with the chosen command and confirms", async () => {
      const channel = fakeChannel();
      const gracefulRestartWithContinue = vi.fn(async () => {});
      const deps = fakeDeps({
        ...multi,
        agent: { ...multi.agent, gracefulRestartWithContinue },
      });
      await makeCardActionHandler(channel, deps)(evt({ cmd: "restartpick", idx: 0 }));
      // performRestart drives the graceful restart; the chosen flavor (A=echo) is
      // confirmed in the reply.
      expect(gracefulRestartWithContinue).toHaveBeenCalledWith(
        "proj-1",
        expect.stringContaining("echo"),
      );
      expect(channel.texts().some((t) => t.includes("A"))).toBe(true);
    });

    it("restartpick with an out-of-range idx → no-op (no pick)", async () => {
      const channel = fakeChannel();
      const deps = fakeDeps(multi);
      await makeCardActionHandler(channel, deps)(evt({ cmd: "restartpick", idx: 9 }));
      expect(channel.sent).toHaveLength(0);
    });
  });

  // --- adopt (unmanaged agent takeover) ---
  describe("adopt", () => {
    it("adoptcancel → acknowledges the cancellation", async () => {
      const channel = fakeChannel();
      await makeCardActionHandler(channel, fakeDeps())(evt({ cmd: "adoptcancel" }));
      expect(channel.texts().some((t) => t.includes("已取消接管"))).toBe(true);
    });

    it("adoptattach with a matching sid → replies the attach hint", async () => {
      const session = "tmux_proj_at";
      const channel = fakeChannel();
      const deps = fakeDeps({ bridge: { listProjectSessions: vi.fn(async () => [session]) } });
      await makeCardActionHandler(
        channel,
        deps,
      )(evt({ cmd: "adoptattach", sid: sessionShortId(session) }));
      expect(channel.texts().some((t) => t.includes("tmux attach"))).toBe(true);
      const { copyToClipboard } = await import("../../../src/core/platform/clipboard.js");
      expect(copyToClipboard).not.toHaveBeenCalled();
    });

    it("adoptattach with an unmatched sid → 'session gone'", async () => {
      const channel = fakeChannel();
      const deps = fakeDeps({ bridge: { listProjectSessions: vi.fn(async () => []) } });
      await makeCardActionHandler(channel, deps)(evt({ cmd: "adoptattach", sid: "zzz" }));
      expect(channel.texts().some((t) => t.includes("会话不存在"))).toBe(true);
    });

    it("adoptattach with no sid → inert", async () => {
      const channel = fakeChannel();
      await makeCardActionHandler(channel, fakeDeps())(evt({ cmd: "adoptattach" }));
      expect(channel.sent).toHaveLength(0);
    });

    it("adopt (show-confirm) with no pid → inert (malformed value guard)", async () => {
      const channel = fakeChannel();
      await makeCardActionHandler(channel, fakeDeps())(evt({ cmd: "adopt" }));
      expect(channel.sent).toHaveLength(0);
    });

    it("adoptgo (exec) with no pid → inert (malformed value guard)", async () => {
      const channel = fakeChannel();
      await makeCardActionHandler(channel, fakeDeps())(evt({ cmd: "adoptgo" }));
      expect(channel.sent).toHaveLength(0);
    });
  });

  // --- recover (reboot recovery) ---
  describe("recover", () => {
    it("recovercancel → acknowledges the cancellation", async () => {
      const channel = fakeChannel();
      await makeCardActionHandler(channel, fakeDeps())(evt({ cmd: "recovercancel" }));
      expect(channel.texts().some((t) => t.includes("已取消恢复"))).toBe(true);
    });
  });

  // --- p2p-only gates (host-probing handlers are no-ops in a group chat) ---
  describe("p2p-only gates (group → silent no-op)", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "tcb-ca-p2p-"));
      process.env.TCB_STATE_DIR = dir;
      bindGroup("oc_grp_p2p", { workspacePath: dir, sessionName: "s", label: "g" });
    });
    afterEach(() => {
      unbindGroup("oc_grp_p2p");
      delete process.env.TCB_STATE_DIR;
      rmSync(dir, { recursive: true, force: true });
    });

    // Each command is gated to p2p in CARD_HANDLERS; in a (bound) group it must do
    // nothing — no card, no text, no host probe.
    it.each([
      "dashboard",
      "statusinstall",
      "statusoverwrite",
      "statuswrap",
      "statussnippet",
      "statusskip",
      "adoptlist",
      "recover",
    ])("'%s' in a group is a silent no-op", async (cmd) => {
      const channel = fakeChannel();
      channel.setChatType("group");
      await makeCardActionHandler(channel, fakeDeps())(evt({ cmd }, { chatId: "oc_grp_p2p" }));
      expect(channel.sent).toHaveLength(0);
    });

    it("adopt (show-confirm) in a group is a silent no-op even with a pid", async () => {
      const channel = fakeChannel();
      channel.setChatType("group");
      await makeCardActionHandler(
        channel,
        fakeDeps(),
      )(evt({ cmd: "adopt", pid: 123 }, { chatId: "oc_grp_p2p" }));
      expect(channel.sent).toHaveLength(0);
    });

    it("recovergo in a group is a silent no-op", async () => {
      const channel = fakeChannel();
      channel.setChatType("group");
      await makeCardActionHandler(
        channel,
        fakeDeps(),
      )(evt({ cmd: "recovergo" }, { chatId: "oc_grp_p2p" }));
      expect(channel.sent).toHaveLength(0);
    });
  });

  // --- unbindgroup (p2p escape hatch: clear a binding by chat id) ---
  describe("unbindgroup", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "tcb-ca-ubg-"));
      process.env.TCB_STATE_DIR = dir;
    });
    afterEach(() => {
      delete process.env.TCB_STATE_DIR;
      rmSync(dir, { recursive: true, force: true });
    });

    it("clears the named binding, confirms, and refreshes the group menu (p2p)", async () => {
      bindGroup("oc_target", { workspacePath: dir, sessionName: "s", label: "tgt" });
      const channel = fakeChannel(); // default p2p, chat-1 unbound
      await makeCardActionHandler(
        channel,
        fakeDeps(),
      )(evt({ cmd: "unbindgroup", chatId: "oc_target" }));
      expect(getBinding("oc_target")).toBeNull();
      expect(channel.texts().some((t) => t.includes("已解除"))).toBe(true);
      // sendGroupMenu refresh follows the confirmation.
      expect(channel.cards().length).toBeGreaterThanOrEqual(1);
    });

    it("reports 'not bound' when the target chat id has no binding (p2p)", async () => {
      const channel = fakeChannel();
      await makeCardActionHandler(
        channel,
        fakeDeps(),
      )(evt({ cmd: "unbindgroup", chatId: "oc_never_bound" }));
      expect(channel.texts().some((t) => t.includes("尚未绑定"))).toBe(true);
    });

    it("is a no-op in a group chat (p2p only)", async () => {
      bindGroup("oc_caller_grp", { workspacePath: dir, sessionName: "s", label: "g" });
      bindGroup("oc_victim", { workspacePath: dir, sessionName: "s2", label: "v" });
      const channel = fakeChannel();
      channel.setChatType("group");
      await makeCardActionHandler(
        channel,
        fakeDeps(),
      )(evt({ cmd: "unbindgroup", chatId: "oc_victim" }, { chatId: "oc_caller_grp" }));
      // The victim binding survives — the group caller can't reach this handler.
      expect(getBinding("oc_victim")).not.toBeNull();
      expect(channel.sent).toHaveLength(0);
      unbindGroup("oc_caller_grp");
      unbindGroup("oc_victim");
    });
  });

  // --- free-group picker + makegroup/makefreegroup p2p gate ---
  describe("group create buttons", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "tcb-ca-mk-"));
      process.env.TCB_STATE_DIR = dir;
    });
    afterEach(() => {
      delete process.env.TCB_STATE_DIR;
      rmSync(dir, { recursive: true, force: true });
    });

    it("freegroupmenu → sends the free-parallel-group picker card (p2p)", async () => {
      const channel = fakeChannel();
      await makeCardActionHandler(channel, fakeDeps())(evt({ cmd: "freegroupmenu" }));
      expect(JSON.stringify(channel.cards())).toContain("新建并行项目群");
    });

    it("makegroup in a bound group → refused (createGroup is p2p-only), no group created", async () => {
      bindGroup("oc_mk_grp", { workspacePath: dir, sessionName: "s", label: "g" });
      const channel = fakeChannel();
      channel.setChatType("group");
      await makeCardActionHandler(
        channel,
        fakeDeps(),
      )(evt({ cmd: "makegroup", sid: "whatever" }, { chatId: "oc_mk_grp" }));
      expect(channel.texts().some((t) => t.includes("仅在与机器人的私聊中"))).toBe(true);
      unbindGroup("oc_mk_grp");
    });

    it("makefreegroup in a bound group → refused (p2p-only)", async () => {
      bindGroup("oc_mkf_grp", { workspacePath: dir, sessionName: "s", label: "g" });
      const channel = fakeChannel();
      channel.setChatType("group");
      await makeCardActionHandler(
        channel,
        fakeDeps(),
      )(evt({ cmd: "makefreegroup", sid: "whatever" }, { chatId: "oc_mkf_grp" }));
      expect(channel.texts().some((t) => t.includes("仅在与机器人的私聊中"))).toBe(true);
      unbindGroup("oc_mkf_grp");
    });

    it("makegroup with no sid → inert", async () => {
      const channel = fakeChannel();
      await makeCardActionHandler(channel, fakeDeps())(evt({ cmd: "makegroup" }));
      expect(channel.sent).toHaveLength(0);
    });
  });

  describe("prompt card handlers (pget/pfilter/ppage) — disabled guard", () => {
    // Confirm that a stale prompt card tapped when PROMPT_MCP_COMMAND is unset
    // replies promptsDisabled and does NOT propagate any error.
    it.each(["pget", "pfilter", "ppage"] as const)(
      "'%s' replies promptsDisabled when the prompt library is not enabled",
      async (cmd) => {
        const channel = fakeChannel();
        const deps = fakeDeps({
          config: { promptMcp: { command: "", args: [] } },
        });
        await makeCardActionHandler(
          channel,
          deps,
        )(evt({ cmd, sid: "some-sid", tagSid: "tag-sid" }));
        expect(channel.texts().some((t) => t.includes("未启用"))).toBe(true);
        expect(channel.texts()).toHaveLength(1); // exactly one reply, nothing else
      },
    );
  });
});
