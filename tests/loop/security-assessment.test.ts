import { describe, expect, it } from "vitest";
import { parseSecurityRiskAssessment } from "../../src/core/loop/security-assessment.js";

describe("parseSecurityRiskAssessment", () => {
  it("runs critical findings even when the action threshold is higher", () => {
    const result = parseSecurityRiskAssessment(
      0,
      JSON.stringify({ riskScore: 45, critical: true }),
      70,
      90,
    );

    expect(result).toMatchObject({ decision: "run", riskScore: 45, critical: true });
  });

  it("runs actionable risks at or above the action threshold", () => {
    const result = parseSecurityRiskAssessment(
      0,
      JSON.stringify({ riskScore: 70, findings: ["reachable authorization bypass"] }),
      70,
      90,
    );

    expect(result).toMatchObject({ decision: "run", riskScore: 70, critical: false });
  });

  it("skips low-risk findings without dispatching a repair", () => {
    const result = parseSecurityRiskAssessment(0, JSON.stringify({ riskScore: 39 }), 70, 90);

    expect(result).toMatchObject({ decision: "skip", riskScore: 39, critical: false });
  });

  it("blocks failed or malformed assessments", () => {
    expect(parseSecurityRiskAssessment(1, "", 70, 90).decision).toBe("block");
    expect(parseSecurityRiskAssessment(0, "not-json", 70, 90).decision).toBe("block");
    expect(parseSecurityRiskAssessment(0, JSON.stringify({ findings: [] }), 70, 90).decision).toBe(
      "block",
    );
  });
});
