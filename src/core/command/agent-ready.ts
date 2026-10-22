import { readAgentLastActivityAt } from "../agents/read.js";
import { paneHasActiveTurn } from "../agents/runner-base.js";
import type { HandlerDeps } from "../deps.js";
import { getPathBySession } from "../projects/sessionPathMap.js";
import { paneIsAnimating } from "../session/pane-activity.js";

/** A transcript write newer than this → the agent is actively streaming output →
 * busy, no pane capture needed. */
const RECENT_ACTIVITY_MS = 8_000;

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
 *  - No transcript                       → idle (fast, no capture).
 *  - Fresh write < RECENT_ACTIVITY_MS    → streaming → busy (fast, no capture).
 *  - Quiet transcript                    → check the pane for blocking states,
 *    then confirm via animation: animating → busy, static → idle.
 * Best-effort: any probe failure resolves to idle so a flaky capture can never
 * deadlock the queue.
 */
export async function agentIsIdle(deps: HandlerDeps, session: string): Promise<boolean> {
  try {
    const projectPath = getPathBySession(session) ?? session;
    const last = await readAgentLastActivityAt(deps.configResolver, session, projectPath);
    if (last === null) return true; // never wrote → idle
    const age = Date.now() - last;
    if (age < RECENT_ACTIVITY_MS) return false; // streaming → busy
    if (await paneHasBlockingState(deps, session)) return false;
    return !(await paneIsAnimating(deps.bridge, session, GATE_PANE_DIFF_MS));
  } catch {
    return true; // never deadlock the queue on a probe failure
  }
}

async function paneHasBlockingState(deps: HandlerDeps, session: string): Promise<boolean> {
  const capturePane = (deps.bridge as { capturePane?: (session: string) => Promise<string> })
    .capturePane;
  if (!capturePane) return false;
  const pane = await capturePane.call(deps.bridge, session).catch(() => null);
  return pane !== null && paneBlocksInput(pane);
}

function paneBlocksInput(pane: string): boolean {
  return (
    paneHasActiveTurn(pane) ||
    /UserPromptSubmit hook/i.test(pane) ||
    /hook \(blocked\)/i.test(pane) ||
    /Messages to be submitted after next tool call/i.test(pane) ||
    /(?:Enter|Press enter) to (?:confirm|continue)/i.test(pane)
  );
}
