import { sleep } from "../../shared/utils/sleep.js";
import type { HandlerDeps } from "../deps.js";

const CONTEXT_RESET_SETTLE_MS = 250;

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
    await deps.bridge.sendRawKey("C-m", session);
    await sleep(settleMs);
    await deps.agent.waitUntilInputReady(session);
  }
}
