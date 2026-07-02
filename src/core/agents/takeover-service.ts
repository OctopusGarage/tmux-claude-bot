import { basename, resolve as resolvePath } from "node:path";
import { sleep } from "../../shared/utils/sleep.js";
import { messages } from "../i18n/index.js";
import { copyToClipboard } from "../platform/clipboard.js";
import {
  allocateFreeSlot,
  FREE_PROJECT_LIMIT,
  freeSessionName,
  setFreeProject,
} from "../projects/free-projects.js";
import { channelFromScope } from "../projects/project-manager.js";
import { botSelfRepoWarning } from "../projects/project-ops.js";
import {
  getPathBySession,
  sessionNameFromPath,
  setPathForSession,
} from "../projects/sessionPathMap.js";
import type { TmuxBridge } from "../session/tmux.js";
import { type ConfigResolver, parseClaudeConfigDir } from "./agent-config-resolver.js";
import { setAgentKind } from "./agentKindMap.js";
import { DEFAULT_CONFIG_ROOT } from "./claude/claude-history.js";
import { listClaudeOrphans } from "./claude/claude-takeover.js";
import { listCodexOrphans } from "./codex/codex-takeover.js";
import { markSessionRunning } from "./runningSessions.js";
import {
  createTakeoverProbe,
  isClaudeProcess,
  isPaneBusy,
  type OrphanAgent,
  type TakeoverResult,
  takeover,
} from "./takeover.js";

/** CLAUDE_CONFIG_DIR of every currently-running claude (deduped) — the accounts /
 * flavors actually in use. Shared by takeover and the status-usage install. */
export async function claudeConfigDirsInUse(): Promise<string[]> {
  const probe = createTakeoverProbe();
  const claudeRows = (await probe.snapshot()).filter((r) => isClaudeProcess(r.command));
  const roots = await Promise.all(
    claudeRows.map(
      async (r) => parseClaudeConfigDir(await probe.readProcEnv(r.pid)) ?? DEFAULT_CONFIG_ROOT,
    ),
  );
  return [...new Set(roots)];
}

/** Capabilities a takeover needs from the bot's core — a thin slice of HandlerDeps. */
export interface AdoptContext {
  bridge: TmuxBridge;
  configResolver: ConfigResolver;
  projectSessionPrefix: string;
  warmupMs: number;
}

/** Non-tmux claude and codex processes the bot could adopt, newest session each. */
export async function findAdoptableOrphans(): Promise<OrphanAgent[]> {
  const probe = createTakeoverProbe();
  const [claudes, codexes] = await Promise.all([listClaudeOrphans(probe), listCodexOrphans(probe)]);
  return [...claudes, ...codexes];
}

/** Single-quote a value for safe pasting into a shell (session names can contain
 * spaces when the project path does). */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** The command to attach a terminal to an adopted session. */
export function attachCommand(sessionName: string): string {
  return `tmux attach -t ${shellQuote(sessionName)}`;
}

/**
 * Copy the attach command to the system clipboard (best-effort) and return it,
 * so the success reply can show it too. Auto-attaching the *original* terminal
 * isn't reliable (no input injection into a foreign tty), so we hand the user a
 * one-paste command that works in any terminal. Cross-platform (pbcopy / wl-copy
 * / xclip / xsel); a no-op where no clipboard tool exists (e.g. a headless box).
 */
export function copyAttachCommand(sessionName: string): string {
  const cmd = attachCommand(sessionName);
  // Fire-and-forget: best-effort copy; the command is also shown in the reply,
  // so a failure (or no clipboard tool) is harmless. copyToClipboard never rejects.
  void copyToClipboard(cmd);
  return cmd;
}

export interface AdoptOutcome {
  ok: boolean;
  /** Fully-composed, localized message (an error reason, or the done line plus a
   * nesting warning when the adopted project is the bot's own repo). */
  body: string;
  sessionName: string;
}

export type AdoptTarget = "path" | "free";

export interface AdoptOptions {
  /** `path` reuses the canonical project session; `free` creates a parallel free_N session. */
  target?: AdoptTarget;
}

/**
 * Map an `adoptOrphan` result to what the user should see — shared by both
 * adapters so the gone/busy/failed/done decision (and the nesting warning) can't
 * drift. Localized via the scope's channel; adapters only render `body`.
 */
export function composeAdoptOutcome(result: TakeoverResult | null, scope: string): AdoptOutcome {
  const m = messages(channelFromScope(scope));
  if (!result) return { ok: false, body: m.adoptGone, sessionName: "" };
  if (!result.ok) {
    let body = m.adoptFailed;
    if (result.reason === "target_session_busy") body = m.adoptBusy;
    else if (result.reason === "project_agent_running") body = m.adoptProjectRunning;
    else if (result.reason === "free_project_limit") body = m.freeProjectLimit(FREE_PROJECT_LIMIT);
    return { ok: false, body, sessionName: result.sessionName };
  }
  const path = getPathBySession(result.sessionName);
  const proj = basename(path ?? result.sessionName);
  const done = m.adoptDone(proj, result.resumed);
  const warn = botSelfRepoWarning(path, scope);
  return { ok: true, body: warn ? `${done}\n\n${warn}` : done, sessionName: result.sessionName };
}

/**
 * Adopt the orphan with the given pid into a bot-controlled tmux session.
 * Re-scans at call time (the list the user tapped may be stale), so a pid that
 * has since exited or moved into tmux resolves to null rather than acting on the
 * wrong process. The tmux/claude side-effects are wired from the bot's bridge.
 */
export async function adoptOrphan(
  pid: number,
  ctx: AdoptContext,
  options: AdoptOptions = {},
): Promise<TakeoverResult | null> {
  if (adoptInFlight.has(pid)) return null; // a takeover of this pid is already running
  adoptInFlight.add(pid);
  try {
    return await runAdopt(pid, ctx, options);
  } finally {
    adoptInFlight.delete(pid);
  }
}

/** Pids with an in-progress takeover — guards against a double-tap racing two
 * kill/resume sequences on the same process. */
const adoptInFlight = new Set<number>();

type AdoptTargetSession =
  | { kind: "path"; sessionName: string }
  | { kind: "free"; sessionName: string; slot: number };

async function runAdopt(
  pid: number,
  ctx: AdoptContext,
  options: AdoptOptions,
): Promise<TakeoverResult | null> {
  const probe = createTakeoverProbe();
  const [claudes, codexes] = await Promise.all([listClaudeOrphans(probe), listCodexOrphans(probe)]);
  const orphan = [...claudes, ...codexes].find((o) => o.pid === pid);
  if (!orphan) return null;

  const target = await resolveAdoptTarget(orphan, ctx, options.target ?? "path");
  if ("reason" in target) {
    return { ok: false, sessionName: target.sessionName, resumed: false, reason: target.reason };
  }

  const isAgentRunning =
    orphan.agent === "codex"
      ? (name: string) => ctx.configResolver.isCodexRunning(name)
      : (name: string) => ctx.configResolver.isClaudeRunning(name);

  const result = await takeover(orphan, {
    probe,
    isTargetBusy: async () => {
      if (!(await ctx.bridge.hasSession(target.sessionName))) return false;
      return isPaneBusy(await ctx.bridge.paneCurrentCommand(target.sessionName));
    },
    ensureSession: async (cwd) => {
      const name = target.sessionName;
      if (!(await ctx.bridge.hasSession(name))) {
        await ctx.bridge.createSession(name, cwd);
        await sleep(ctx.warmupMs);
      }
      if (target.kind === "free") setFreeProject(target.slot, { label: null });
      setPathForSession(name, cwd);
      return name;
    },
    startInSession: (name, command) => ctx.bridge.sendKeys(command, name),
    isAgentRunning,
  });
  // Record which agent the adopted session runs, so dispatch/status route it
  // correctly afterward. Claude orphans record "claude" (the default) — harmless;
  // codex orphans record "codex", without which the session would route to claude.
  if (result.ok) {
    setAgentKind(result.sessionName, orphan.agent);
    // Adoption makes an agent live without going through the dispatcher's start
    // hook, so add it to the reboot-recovery roster here (the sweep would catch
    // it eventually, but not if a reboot lands in the gap).
    markSessionRunning(result.sessionName);
  }
  return result;
}

async function resolveAdoptTarget(
  orphan: OrphanAgent,
  ctx: AdoptContext,
  target: AdoptTarget,
): Promise<
  | AdoptTargetSession
  | { reason: "project_agent_running" | "free_project_limit"; sessionName: string }
> {
  if (target === "free") {
    const slot = allocateFreeSlot();
    if (slot === null) return { reason: "free_project_limit", sessionName: "" };
    return { kind: "free", slot, sessionName: freeSessionName(ctx.projectSessionPrefix, slot) };
  }

  const running = await sameProjectRunningAgentSession(orphan.cwd, ctx);
  if (running) return { reason: "project_agent_running", sessionName: running };
  return { kind: "path", sessionName: sessionNameFromPath(orphan.cwd, ctx.projectSessionPrefix) };
}

async function sameProjectRunningAgentSession(
  cwd: string,
  ctx: AdoptContext,
): Promise<string | null> {
  const wanted = resolvePath(cwd);
  const sessions = await ctx.bridge.listProjectSessions();
  for (const session of sessions) {
    const path = getPathBySession(session);
    if (!path || resolvePath(path) !== wanted) continue;
    const [claudeRunning, codexRunning] = await Promise.all([
      ctx.configResolver.isClaudeRunning(session),
      ctx.configResolver.isCodexRunning(session),
    ]);
    if (claudeRunning || codexRunning) return session;
  }
  return null;
}
