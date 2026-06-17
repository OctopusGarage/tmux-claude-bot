import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/shared/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  createConfigResolver,
  type ProcRow,
  type ResolverProbe,
} from "../../src/core/agents/agent-config-resolver.js";
import { resolveAgentKind, setAgentKind } from "../../src/core/agents/agentKindMap.js";
import {
  getLatestAssistantReply,
  getRecentConversations,
  projectPathToHistoryDir,
} from "../../src/core/agents/claude/claude-history.js";
import {
  getLatestCodexReply,
  parseCodexRounds,
} from "../../src/core/agents/codex/codex-history.js";
import type { AgentRunner } from "../../src/core/agents/runner.js";
import { AgentRunnerDispatcher } from "../../src/core/agents/runner-dispatcher.js";
import { formatTranscriptTime } from "../../src/core/read/transcript.js";
import type { TmuxBridge } from "../../src/core/session/tmux.js";

/**
 * Integration tests for the claude<->codex seams, where the two agents' different
 * shapes (process detection, config home, transcript format, resume id) hide
 * asymmetry bugs. They wire the REAL resolver + dispatcher + transcript parsers
 * together against a scriptable fake process world, and assert end-to-end
 * invariants rather than per-function behavior. Each test uses a unique session
 * name so the persisted agent-kind store (temp dir, per tests/setup.ts) never
 * cross-contaminates.
 */

const UUID_A = "11111111-2222-3333-4444-555555555555";
const UUID_B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

/** A mutable fake of the OS/tmux world the resolver introspects. Tests flip
 * `panePid`, `rows`, `openFiles`, `env`, and `clock` to script lifecycle
 * transitions (agent switch, pid death, pane gone) and assert the resolver
 * follows reality. */
function makeWorld() {
  const w = {
    panePid: 100 as number | null,
    rows: [] as ProcRow[],
    openFiles: new Map<number, string[]>(),
    env: new Map<number, string>(),
    clock: 1_000_000,
    listOpenFilesCalls: 0,
    snapshotCalls: 0,
  };
  const probe: ResolverProbe = {
    panePid: async () => w.panePid,
    snapshot: async () => {
      w.snapshotCalls++;
      return w.rows;
    },
    readProcEnv: async (pid) => w.env.get(pid) ?? "",
    listOpenFiles: async (pid) => {
      w.listOpenFilesCalls++;
      return w.openFiles.get(pid) ?? [];
    },
    isAlive: async (pid) => w.rows.some((r) => r.pid === pid),
    now: () => w.clock,
  };
  const resolver = createConfigResolver(probe, {
    defaultRoot: "/home/.claude",
    claudeBin: "claude",
    ttlMs: 5_000,
  });
  return { w, resolver };
}

type World = ReturnType<typeof makeWorld>["w"];

/** Pane tree: shell(100) -> the agent process. */
function withClaude(w: World, opts: { configDir?: string } = {}) {
  w.panePid = 100;
  w.rows = [
    { pid: 100, ppid: 1, command: "-zsh" },
    { pid: 200, ppid: 100, command: "claude --dangerously-skip-permissions" },
  ];
  w.env.set(
    200,
    opts.configDir ? `claude CLAUDE_CONFIG_DIR=${opts.configDir} PWD=/p` : "claude PWD=/p",
  );
}
function withCodex(w: World, opts: { codexHome?: string } = {}) {
  w.panePid = 100;
  w.rows = [
    { pid: 100, ppid: 1, command: "-zsh" },
    { pid: 300, ppid: 100, command: "codex --yolo" },
  ];
  w.env.set(300, opts.codexHome ? `codex CODEX_HOME=${opts.codexHome} PWD=/p` : "codex PWD=/p");
}
function withNoAgent(w: World) {
  w.panePid = 100;
  w.rows = [{ pid: 100, ppid: 1, command: "-zsh" }];
}

describe("seam: live process detection wins over the persisted launch-intent", () => {
  it("a session recorded as claude but running codex resolves (and routes) to codex", async () => {
    const { w, resolver } = makeWorld();
    const session = "tmux_proj_switch_1";
    setAgentKind(session, "claude"); // persisted launch-intent
    withCodex(w); // but codex is what's actually alive

    expect(await resolveAgentKind(resolver, session)).toBe("codex");

    // ...and the dispatcher routes the call to the codex backend, not claude.
    const calls: string[] = [];
    const rec = (name: string): AgentRunner =>
      ({
        checkIfRunning: async () => {
          calls.push(`${name}.checkIfRunning`);
          return true;
        },
      }) as unknown as AgentRunner;
    const bridge = { resolveSessionName: async (s?: string) => s ?? session } as TmuxBridge;
    const dispatcher = new AgentRunnerDispatcher({
      bridge,
      claude: rec("claude"),
      codex: rec("codex"),
      configResolver: resolver,
    });
    await dispatcher.checkIfRunning(session);
    expect(calls).toEqual(["codex.checkIfRunning"]);
  });

  it("falls back to the persisted kind only when NO process is live", async () => {
    const { w, resolver } = makeWorld();
    const session = "tmux_proj_switch_2";
    setAgentKind(session, "codex");
    withNoAgent(w);
    expect(await resolveAgentKind(resolver, session)).toBe("codex"); // persisted
  });
});

describe("seam: resolver follows lifecycle transitions", () => {
  it("claude -> codex switch in the same pane is reflected after the TTL", async () => {
    const { w, resolver } = makeWorld();
    const s = "sess-trans";
    withClaude(w, { configDir: "/home/.claude-stella" });
    expect(await resolver.isClaudeRunning(s)).toBe(true);
    expect(await resolver.isCodexRunning(s)).toBe(false);
    expect(await resolver.resolveConfigRoot(s)).toBe("/home/.claude-stella");
    expect(await resolver.detectAgentKind?.(s)).toBe("claude");

    // User swaps the agent on the desktop: claude pid gone, codex now alive.
    withCodex(w, { codexHome: "/home/.codex-team" });
    w.clock += 6_000; // past ttlMs so the cheap path re-detects

    expect(await resolver.detectAgentKind?.(s)).toBe("codex");
    expect(await resolver.isClaudeRunning(s)).toBe(false);
    expect(await resolver.resolveCodexHome?.(s)).toBe("/home/.codex-team");
    // resolveConfigRoot is claude-specific: with codex live it must NOT report
    // codex's home as a claude config root — it returns the claude default.
    expect(await resolver.resolveConfigRoot(s)).toBe("/home/.claude");
  });

  it("agent exit -> everything reports not-running / null", async () => {
    const { w, resolver } = makeWorld();
    const s = "sess-exit";
    withClaude(w);
    expect(await resolver.detectAgentKind?.(s)).toBe("claude");
    withNoAgent(w);
    w.clock += 6_000;
    expect(await resolver.detectAgentKind?.(s)).toBeNull();
    expect(await resolver.isClaudeRunning(s)).toBe(false);
    expect(await resolver.isCodexRunning(s)).toBe(false);
  });

  it("the cheap path serves the cache while the pid is alive within the TTL (no re-snapshot)", async () => {
    const { w, resolver } = makeWorld();
    const s = "sess-cheap";
    withClaude(w, { configDir: "/home/.claude-x" });
    expect(await resolver.resolveConfigRoot(s)).toBe("/home/.claude-x");
    const afterFirst = w.snapshotCalls;
    // Within TTL with pid 200 still alive: repeated reads must hit the cache and
    // NOT re-dump the process table.
    await resolver.resolveConfigRoot(s);
    await resolver.isClaudeRunning(s);
    expect(w.snapshotCalls).toBe(afterFirst);
  });

  it("a transient pane-query failure keeps the last known claude config root", async () => {
    const { w, resolver } = makeWorld();
    const s = "sess-pane-gone";
    withClaude(w, { configDir: "/home/.claude-y" });
    expect(await resolver.resolveConfigRoot(s)).toBe("/home/.claude-y");
    // tmux hiccup: pane pid can't be read AND the cache has expired.
    w.panePid = null;
    w.clock += 6_000;
    expect(await resolver.resolveConfigRoot(s)).toBe("/home/.claude-y"); // keep last known
  });
});

describe("seam: live transcript / resume-id resolution (claude vs codex paths)", () => {
  it("extracts the claude session id from the pid's open projects/<dir>/<uuid>.jsonl", async () => {
    const { w, resolver } = makeWorld();
    const s = "sess-tc";
    withClaude(w);
    w.openFiles.set(200, [`/home/.claude/projects/-home-user-proj/${UUID_A}.jsonl`, "/dev/null"]);
    const live = await resolver.resolveLiveTranscript?.(s);
    expect(live?.sessionId).toBe(UUID_A);
    expect(live?.path).toContain(`${UUID_A}.jsonl`);
  });

  it("extracts the codex rollout id from the pid's open sessions/.../rollout-...jsonl", async () => {
    const { w, resolver } = makeWorld();
    const s = "sess-cx";
    withCodex(w);
    w.openFiles.set(300, [
      `/home/.codex/sessions/2026/06/17/rollout-2026-06-17T01-02-03-${UUID_B}.jsonl`,
    ]);
    const live = await resolver.resolveLiveTranscript?.(s);
    expect(live?.sessionId).toBe(UUID_B);
  });

  it("caches the open-file lookup (listOpenFiles called once across repeated reads)", async () => {
    const { w, resolver } = makeWorld();
    const s = "sess-cache-tx";
    withClaude(w);
    w.openFiles.set(200, [`/home/.claude/projects/-x/${UUID_A}.jsonl`]);
    await resolver.resolveLiveTranscript?.(s);
    await resolver.resolveLiveTranscript?.(s);
    await resolver.resolveLiveTranscript?.(s);
    expect(w.listOpenFilesCalls).toBe(1);
  });
});

// --- Transcript reply-matching: the shared "is this the reply to THIS prompt?"
// rule, exercised through BOTH agents' real parsers + file IO. ---

function tmpFile(name: string, lines: string[]): string {
  const dir = fs.mkdtempSync(join(tmpdir(), "tcb-seam-"));
  const p = join(dir, name);
  fs.writeFileSync(p, lines.join("\n"));
  return p;
}

function claudeUser(text: string): string {
  return JSON.stringify({
    type: "user",
    message: { content: text },
    timestamp: "2026-06-17T00:00:00Z",
  });
}
function claudeAsst(text: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text }] },
    timestamp: "2026-06-17T00:00:01Z",
  });
}
function codexUser(text: string): string {
  return JSON.stringify({
    payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
  });
}
function codexAsst(text: string): string {
  return JSON.stringify({
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
  });
}

describe("seam: reply-matching returns the LATEST reply for a re-sent prompt (both agents)", () => {
  const prompt = "deploy the app to staging";

  it("claude: the same prompt sent twice returns the second (newest) reply, not the stale first", async () => {
    const path = tmpFile(`${UUID_A}.jsonl`, [
      claudeUser(prompt),
      claudeAsst("Deployed v1."),
      claudeUser(prompt),
      claudeAsst("Deployed v2."),
    ]);
    const reply = await getLatestAssistantReply("/proj", prompt, "/cfg", path, 0, 0);
    expect(reply).toBe("Deployed v2.");
  });

  it("codex: the same prompt sent twice returns the second (newest) reply", async () => {
    const path = tmpFile(`rollout-x-${UUID_B}.jsonl`, [
      codexUser(prompt),
      codexAsst("Deployed v1."),
      codexUser(prompt),
      codexAsst("Deployed v2."),
    ]);
    const reply = await getLatestCodexReply("/cfg", "/proj", prompt, path, 0, 0);
    expect(reply).toBe("Deployed v2.");
  });

  it("claude: a prompt whose turn is not recorded yet returns null (caller then falls back to the pane)", async () => {
    // Last user line has NO assistant reply yet — the newest COMPLETE round is the
    // older one, whose prompt differs, so the rule must NOT return that stale reply.
    const path = tmpFile(`${UUID_A}.jsonl`, [
      claudeUser("older prompt"),
      claudeAsst("older reply"),
      claudeUser(prompt), // sent, reply not yet streamed to disk
    ]);
    const reply = await getLatestAssistantReply("/proj", prompt, "/cfg", path, 0, 0);
    expect(reply).toBeNull();
  });

  it("codex: a prompt whose turn is not recorded yet returns null", async () => {
    const path = tmpFile(`rollout-x-${UUID_B}.jsonl`, [
      codexUser("older prompt"),
      codexAsst("older reply"),
      codexUser(prompt),
    ]);
    const reply = await getLatestCodexReply("/cfg", "/proj", prompt, path, 0, 0);
    expect(reply).toBeNull();
  });

  it("claude: a short prompt (<10 chars) only matches exactly — no accidental fuzzy hit", async () => {
    const path = tmpFile(`${UUID_A}.jsonl`, [claudeUser("hi"), claudeAsst("hello there")]);
    expect(await getLatestAssistantReply("/proj", "hi", "/cfg", path, 0, 0)).toBe("hello there");
    // A different short prompt must NOT borrow the previous reply.
    expect(await getLatestAssistantReply("/proj", "yo", "/cfg", path, 0, 0)).toBeNull();
  });
});

describe("seam: claude project-dir encoding matches real claude (regression lock)", () => {
  // Each pair is (cwd, claude's real on-disk dir name) — the unicode/dot/space
  // cases were live-verified against a real claude launch.
  const cases: Array<[string, string]> = [
    ["/Users/test/project", "-Users-test-project"],
    ["/Users/test/social_media_posts", "-Users-test-social-media-posts"],
    ["/Users/test/my.app v2", "-Users-test-my-app-v2"],
    ["/private/tmp/tcb_测试.proj-1", "-private-tmp-tcb----proj-1"],
  ];
  for (const [cwd, encoded] of cases) {
    it(`encodes ${cwd}`, () => {
      expect(projectPathToHistoryDir(cwd, "/root")).toBe(`/root/projects/${encoded}`);
    });
  }
});

describe("seam: /history time formatting is identical for both agents", () => {
  const iso = "2026-06-17T00:00:00Z";

  it("codex rounds carry a FORMATTED local time (not the raw ISO string)", async () => {
    const rounds = parseCodexRounds(
      [codexUser("hello"), codexAsst("hi")]
        .map((l, i) => {
          // attach the same timestamp to the user line
          const o = JSON.parse(l);
          o.timestamp = i === 0 ? iso : iso;
          return JSON.stringify(o);
        })
        .join("\n"),
    );
    expect(rounds[0]?.time).toBe(formatTranscriptTime(iso));
    expect(rounds[0]?.time).not.toBe(iso); // regression: was the raw ISO before
  });

  it("claude and codex format the SAME timestamp identically", async () => {
    // claude side: parse a real transcript through getRecentConversations.
    const cPath = tmpFile(`${UUID_A}.jsonl`, [
      JSON.stringify({ type: "user", message: { content: "hello" }, timestamp: iso }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "hi" }] },
        timestamp: iso,
      }),
    ]);
    const claudeRounds = await getRecentConversations("/proj", "/cfg", cPath);
    const codexRounds = parseCodexRounds(
      [
        JSON.stringify({
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hello" }],
          },
          timestamp: iso,
        }),
      ].join("\n"),
    );
    expect(claudeRounds[0]?.time).toBe(codexRounds[0]?.time);
    expect(claudeRounds[0]?.time).toBe(formatTranscriptTime(iso));
  });

  it("an empty/invalid timestamp formats to '' (no 'Invalid Date')", () => {
    expect(formatTranscriptTime("")).toBe("");
    expect(formatTranscriptTime("not-a-date")).toBe("");
  });
});
