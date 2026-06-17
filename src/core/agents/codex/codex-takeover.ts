import { listOrphansFor, type OrphanAgent, type TakeoverProbe } from "../takeover.js";
import { codexProfile } from "./codex-profile.js";

/**
 * Enumerate non-tmux codex processes the bot could adopt. The codex-specific
 * knowledge (process match, CODEX_HOME, rollout-based session id, resume command)
 * lives on {@link codexProfile}; the shared skeleton is {@link listOrphansFor}.
 */
export async function listCodexOrphans(probe: TakeoverProbe): Promise<OrphanAgent[]> {
  return listOrphansFor(probe, codexProfile);
}
