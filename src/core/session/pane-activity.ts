import { sleep } from "../../shared/utils/sleep.js";
import type { TmuxBridge } from "./tmux.js";

/** Default gap between the two pane captures. Long enough to span a spinner tick
 * / elapsed-timer increment, short enough to keep a probe sub-second-ish. */
export const PANE_DIFF_MS = 1_100;

/**
 * True if the session's pane changed across a ~diffMs gap — i.e. something is
 * animating (spinner / elapsed timer / streaming output), which means the agent
 * is working even when it wrote no transcript (a long silent tool call) and drove
 * no bot task. Agent-agnostic: no fragile UI-string match. Best-effort: a capture
 * failure or a static pane reads as not-animating.
 *
 * Shared by the dashboard (busy detection) and the queue idle-gate (don't type
 * into a pane that's mid-render) so the two can't drift.
 */
export async function paneIsAnimating(
  bridge: Pick<TmuxBridge, "capturePane">,
  session: string,
  diffMs: number = PANE_DIFF_MS,
): Promise<boolean> {
  const a = await bridge.capturePane(session).catch(() => null);
  if (a === null) return false;
  await sleep(diffMs);
  const b = await bridge.capturePane(session).catch(() => null);
  return b !== null && b !== a;
}
