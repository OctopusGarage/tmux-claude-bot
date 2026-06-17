import { listOrphansFor, type OrphanAgent, type TakeoverProbe } from "../takeover.js";
import { claudeProfile } from "./claude-profile.js";

/**
 * Enumerate non-tmux claude processes the bot could adopt, newest session each.
 * Mirrors {@link listCodexOrphans}; the claude-specific knowledge (process match,
 * CLAUDE_CONFIG_DIR, session id, resume command) lives on {@link claudeProfile},
 * the shared skeleton is {@link listOrphansFor}.
 */
export async function listClaudeOrphans(probe: TakeoverProbe): Promise<OrphanAgent[]> {
  return listOrphansFor(probe, claudeProfile);
}
