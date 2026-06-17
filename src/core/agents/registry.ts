import { claudeProfile } from "./claude/claude-profile.js";
import { codexProfile } from "./codex/codex-profile.js";
import type { AgentKind, AgentProfile } from "./types.js";

const PROFILES: Record<AgentKind, AgentProfile> = {
  claude: claudeProfile,
  codex: codexProfile,
};

/** Profile for a known agent kind. */
export function profileFor(kind: AgentKind): AgentProfile {
  return PROFILES[kind];
}
