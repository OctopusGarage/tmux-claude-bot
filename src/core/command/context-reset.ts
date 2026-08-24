import { sleep } from "../../shared/utils/sleep.js";
import type { HandlerDeps } from "../deps.js";

const CONTEXT_RESET_SETTLE_MS = 250;
const CONTEXT_RESET_SUBMIT_ATTEMPTS = 3;

/** Reset an agent's context: send the `/compact` or `/clear` slash command to the
 * pane and invalidate the cached transcript resolver (a fresh transcript may follow).
 * Shared by the `/clear`,`/compact` chat commands and the autopilot between-goals step. */
export async function sendContextReset(
  deps: HandlerDeps,
  session: string,
  op: "compact" | "clear",
  options: { settleMs?: number; ensureSubmitted?: boolean } = {},
): Promise<void> {
  await deps.bridge.sendKeys(`/${op}`, session);
  deps.configResolver.invalidate(session);
  const settleMs = options.settleMs ?? CONTEXT_RESET_SETTLE_MS;
  await sleep(settleMs);
  await deps.agent.waitUntilInputReady(session);
  if (options.ensureSubmitted === true) {
    for (let attempt = 0; attempt < CONTEXT_RESET_SUBMIT_ATTEMPTS; attempt += 1) {
      await deps.bridge.sendRawKey("C-m", session);
      await sleep(settleMs);
      await deps.agent.waitUntilInputReady(session);
      if (!(await resetCommandStillInComposer(deps, session, op))) break;
    }
  }
}

async function resetCommandStillInComposer(
  deps: HandlerDeps,
  session: string,
  op: "compact" | "clear",
): Promise<boolean> {
  const capturePane = (deps.bridge as { capturePane?: (session: string) => Promise<string> })
    .capturePane;
  if (capturePane === undefined) return false;
  try {
    return activeComposerContainsResetCommand(await capturePane.call(deps.bridge, session), op);
  } catch {
    return false;
  }
}

function activeComposerContainsResetCommand(pane: string, op: "compact" | "clear"): boolean {
  const commandPattern = new RegExp(`^\\s*›\\s*/${op}(?:$|\\s|\\[)`);
  const lines = pane.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? "";
    if (commandPattern.test(line)) return true;
    if (/^\s*›/.test(line)) return false;
  }
  return false;
}
