import { appStateDir } from "../../shared/state-dir.js";
import type { LoopWorkOrder } from "./work-order-contract.js";

/** Keep native gates and delegated host checks bound to the same WorkOrder. */
export function workOrderCommandEnv(
  workOrder: LoopWorkOrder,
  projectPath = workOrder.projectPath,
): Record<string, string> {
  return {
    TCB_STATE_DIR: appStateDir(),
    LOOP_WORK_ORDER_ID: workOrder.id,
    LOOP_PROJECT_ID: workOrder.projectId,
    LOOP_PROJECT_NAME: workOrder.projectName,
    LOOP_PROJECT_AGENT: workOrder.agent,
    LOOP_PROJECT_GOAL: workOrder.goal,
    LOOP_PROJECT_PATH: projectPath,
    LOOP_BOT_ROOT: process.cwd(),
    LOOP_PROJECT_TARGET_SCORE: String(workOrder.targetScore),
    LOOP_PROJECT_MAX_ROUNDS: String(workOrder.maxRounds),
  };
}
