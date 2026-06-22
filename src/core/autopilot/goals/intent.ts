import type { AgentKind } from "../../../shared/types.js";
import type { Intent } from "./types.js";

export function intentToText(intent: Intent, agentKind: AgentKind): string {
  if (intent.kind === "prompt") return intent.text;
  return agentKind === "claude" ? `/${intent.name}` : intent.fallback;
}
