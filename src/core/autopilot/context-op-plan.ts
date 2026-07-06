import type { AutopilotState } from "./types.js";

export type PendingContextOpPlan =
  | { kind: "none" }
  | { kind: "wait" }
  | { kind: "run"; op: "compact" | "clear" };

export function planPendingContextOp(state: AutopilotState, idle: boolean): PendingContextOpPlan {
  if (!state.pendingContextOp) return { kind: "none" };
  if (!idle) return { kind: "wait" };
  return { kind: "run", op: state.pendingContextOp };
}
