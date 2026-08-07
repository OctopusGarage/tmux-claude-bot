export type SecurityRiskAssessmentResult = {
  riskScore: number | null;
  actionThreshold: number;
  criticalThreshold: number;
  critical: boolean;
  decision: "run" | "skip" | "block";
  notes: string[];
  blockers: string[];
};

export function parseSecurityRiskAssessment(
  status: number,
  stdout: string,
  actionThreshold: number,
  criticalThreshold: number,
): SecurityRiskAssessmentResult {
  const base = {
    actionThreshold,
    criticalThreshold,
    critical: false,
    notes: [],
  } satisfies Pick<
    SecurityRiskAssessmentResult,
    "actionThreshold" | "criticalThreshold" | "critical" | "notes"
  >;
  if (status !== 0) {
    return {
      ...base,
      riskScore: null,
      decision: "block",
      blockers: [`security risk assessment failed with exit status ${status}`],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim()) as unknown;
  } catch {
    return {
      ...base,
      riskScore: null,
      decision: "block",
      blockers: ["security risk assessment did not return valid JSON"],
    };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ...base,
      riskScore: null,
      decision: "block",
      blockers: ["security risk assessment returned an invalid result"],
    };
  }

  const record = parsed as {
    riskScore?: unknown;
    critical?: unknown;
    severity?: unknown;
    findings?: unknown;
    suggestedBotImprovements?: unknown;
  };
  if (typeof record.riskScore !== "number" || !Number.isFinite(record.riskScore)) {
    return {
      ...base,
      riskScore: null,
      decision: "block",
      blockers: ["security risk assessment did not include a numeric riskScore"],
    };
  }

  const riskScore = Math.max(0, Math.min(100, record.riskScore));
  const critical =
    record.critical === true || record.severity === "critical" || riskScore >= criticalThreshold;
  const notes = [
    ...(critical ? ["critical security finding"] : []),
    ...(Array.isArray(record.findings)
      ? record.findings.filter((item): item is string => typeof item === "string")
      : []),
    ...(Array.isArray(record.suggestedBotImprovements)
      ? record.suggestedBotImprovements.filter((item): item is string => typeof item === "string")
      : []),
  ];
  return {
    ...base,
    riskScore,
    critical,
    decision: critical || riskScore >= actionThreshold ? "run" : "skip",
    notes,
    blockers: [],
  };
}
