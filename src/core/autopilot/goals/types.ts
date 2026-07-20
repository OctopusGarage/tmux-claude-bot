import type { SkillId } from "../../skills/schema.js";

export type Intent =
  | { kind: "prompt"; text: string }
  | { kind: "skill"; name: SkillId; fallback: string };

export type DoneCondition =
  | { kind: "sentinel"; marker: string }
  | { kind: "check"; cmd: string }
  | { kind: "detectCheck"; purpose: "coverage" | "test" }
  | { kind: "humanGate" }
  | { kind: "all"; of: DoneCondition[] }
  | { kind: "seq"; of: DoneCondition[] };

export type GoalBudget = { maxIterations?: number; maxWallClockMs?: number };

export type Phase = {
  id: string;
  intent: Intent;
  done: DoneCondition;
  autonomy?: "conservative" | "aggressive";
};

export type Goal = {
  id: string;
  titleKey: string;
  phases: Phase[];
  budget?: GoalBudget;
};
