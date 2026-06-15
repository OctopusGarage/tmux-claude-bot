import { basename } from "node:path";
import { sleep } from "../shared/utils/sleep.js";
import { type ConfigResolver, parseClaudeConfigDir } from "./claude-config-resolver.js";
import { DEFAULT_CONFIG_ROOT } from "./history.js";
import { messages } from "./i18n/index.js";
import { copyToClipboard } from "./platform/clipboard.js";
import { channelFromScope } from "./project-manager.js";
import { botSelfRepoWarning } from "./project-ops.js";
import { getPathBySession, sessionNameFromPath, setPathForSession } from "./sessionPathMap.js";
import {
  createTakeoverProbe,
  isClaudeProcess,
  isPaneBusy,
  listOrphans,
  type OrphanClaude,
  type TakeoverResult,
  takeover,
} from "./takeover.js";
import type { TmuxBridge } from "./tmux.js";

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

/** Non-tmux claude processes the bot could adopt, newest session each. */
export function findAdoptableOrphans(): Promise<OrphanClaude[]> {
  return listOrphans(createTakeoverProbe());
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

/**
 * Map an `adoptOrphan` result to what the user should see — shared by both
 * adapters so the gone/busy/failed/done decision (and the nesting warning) can't
 * drift. Localized via the scope's channel; adapters only render `body`.
 */
export function composeAdoptOutcome(result: TakeoverResult | null, scope: string): AdoptOutcome {
  const m = messages(channelFromScope(scope));
  if (!result) return { ok: false, body: m.adoptGone, sessionName: "" };
  if (!result.ok) {
    const body = result.reason === "target_session_busy" ? m.adoptBusy : m.adoptFailed;
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
export async function adoptOrphan(pid: number, ctx: AdoptContext): Promise<TakeoverResult | null> {
  if (adoptInFlight.has(pid)) return null; // a takeover of this pid is already running
  adoptInFlight.add(pid);
  try {
    return await runAdopt(pid, ctx);
  } finally {
    adoptInFlight.delete(pid);
  }
}

/** Pids with an in-progress takeover — guards against a double-tap racing two
 * kill/resume sequences on the same process. */
const adoptInFlight = new Set<number>();

async function runAdopt(pid: number, ctx: AdoptContext): Promise<TakeoverResult | null> {
  const probe = createTakeoverProbe();
  const orphan = (await listOrphans(probe)).find((o) => o.pid === pid);
  if (!orphan) return null;

  return takeover(orphan, {
    probe,
    isTargetBusy: async (cwd) => {
      const name = sessionNameFromPath(cwd, ctx.projectSessionPrefix);
      if (!(await ctx.bridge.hasSession(name))) return false;
      return isPaneBusy(await ctx.bridge.paneCurrentCommand(name));
    },
    ensureSession: async (cwd) => {
      const name = sessionNameFromPath(cwd, ctx.projectSessionPrefix);
      if (!(await ctx.bridge.hasSession(name))) {
        await ctx.bridge.createSession(name, cwd);
        await sleep(ctx.warmupMs);
      }
      setPathForSession(name, cwd);
      return name;
    },
    startInSession: (name, command) => ctx.bridge.sendKeys(command, name),
    isClaudeRunning: (name) => ctx.configResolver.isClaudeRunning(name),
  });
}
