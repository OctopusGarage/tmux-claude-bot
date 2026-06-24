import type { HandlerDeps } from "../deps.js";

/** Reset an agent's context: send the `/compact` or `/clear` slash command to the
 * pane and invalidate the cached transcript resolver (a fresh transcript may follow).
 * Shared by the `/clear`,`/compact` chat commands and the autopilot between-goals step. */
export async function sendContextReset(
  deps: HandlerDeps,
  session: string,
  op: "compact" | "clear",
): Promise<void> {
  await deps.bridge.sendKeys(`/${op}`, session);
  deps.configResolver.invalidate(session);
}
