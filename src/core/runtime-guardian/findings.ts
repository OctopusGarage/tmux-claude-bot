export type RuntimeGuardianFindingKind =
  | "missing-system-gate"
  | "terminal-system-gate-failure"
  | "failed-eval-outcome"
  | "terminal-invalid-output"
  | "terminal-agent-transient-failure"
  | "terminal-work-order-active-lease"
  | "stale-dispatching-work-order"
  | "read-only-smoke-preflight-blocked";

export type RuntimeGuardianRepairDisposition = "bot-repairable" | "target-or-external-blocker";

export type RuntimeGuardianFinding = {
  kind: RuntimeGuardianFindingKind;
  severity: "medium" | "high";
  runId: string;
  projectId: string;
  projectPath: string;
  evidence: string[];
  /**
   * A machine-readable disposition supplied by the producing gate. Absence
   * means a legacy artifact whose wording must not decide queue behavior.
   */
  repairDisposition?: RuntimeGuardianRepairDisposition;
  runDir?: string;
};
