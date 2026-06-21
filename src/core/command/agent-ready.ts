import { resolveAgentKind } from "../agents/agentKindMap.js";
import { profileFor } from "../agents/registry.js";
import type { HandlerDeps } from "../deps.js";
import { getPathBySession } from "../projects/sessionPathMap.js";
import { paneIsAnimating } from "../session/pane-activity.js";

/** A transcript write newer than this → the agent is actively streaming output →
 * busy, no pane capture needed. */
const RECENT_ACTIVITY_MS = 8_000;

/** Quiet for longer than this → confidently idle, skip the pane probe. A silent
 * tool call almost always starts within seconds of the agent's last output, so the
 * ambiguous "recently active then went quiet" window is short; beyond it, treat the
 * agent as idle and keep the common (long-dormant) path fast. */
const DORMANT_MS = 60_000;

/** Pane-diff for the idle-gate's confirm arm. SHORT on purpose: a working agent
 * shows a spinner that cycles every ~100ms, so a sub-second diff reliably catches
 * it — far cheaper than the dashboard's 1.1s (which also wants to catch a bare,
 * 1s-resolution elapsed timer and isn't on a per-message latency path). */
const GATE_PANE_DIFF_MS = 450;

/**
 * Whether the session's agent is idle enough to safely type the next message
 * into it. Used as the queue's idle-gate so a chat message never lands in a pane
 * that's busy with work the bot didn't start — e.g. the user driving the agent
 * directly on the desktop. The bot's OWN in-flight work is already serialized by
 * the queue, so this only has to catch foreign (desktop-driven) activity.
 *
 * Three tiers, cheapest-first — the expensive pane capture runs ONLY in the narrow
 * ambiguous window, so the dominant cases stay fork-free:
 *  - No transcript / quiet > DORMANT_MS  → idle (fast, no capture).
 *  - Fresh write < RECENT_ACTIVITY_MS    → streaming → busy (fast, no capture).
 *  - In between (recently active, now quiet) → could be a SILENT tool call, so
 *    confirm via the pane: animating → busy, static → idle.
 * Best-effort: any probe failure resolves to idle so a flaky capture can never
 * deadlock the queue.
 */
export async function agentIsIdle(deps: HandlerDeps, session: string): Promise<boolean> {
  try {
    const projectPath = getPathBySession(session) ?? session;
    const profile = profileFor(await resolveAgentKind(deps.configResolver, session));
    const last =
      (await profile.lastActivityAt?.(deps.configResolver, session, projectPath)) ?? null;
    if (last === null) return true; // never wrote → idle
    const age = Date.now() - last;
    if (age < RECENT_ACTIVITY_MS) return false; // streaming → busy
    if (age > DORMANT_MS) return true; // long quiet → idle
    return !(await paneIsAnimating(deps.bridge, session, GATE_PANE_DIFF_MS));
  } catch {
    return true; // never deadlock the queue on a probe failure
  }
}
