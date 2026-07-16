import type { SkillId } from "../../skills/schema.js";
import type { Goal } from "./types.js";

export function goalSkillIds(goal: Goal): SkillId[] {
  return [
    ...new Set(
      goal.phases.flatMap((phase) => (phase.intent.kind === "skill" ? [phase.intent.name] : [])),
    ),
  ].sort((a, b) => a.localeCompare(b));
}
