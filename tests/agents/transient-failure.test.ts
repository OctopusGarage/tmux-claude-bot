import { describe, expect, it } from "vitest";
import {
  classifyAgentTransientFailure,
  isAgentTransientFailure,
  isProviderTransientFailure,
} from "../../src/core/agents/transient-failure.js";

describe("agent transient failure classification", () => {
  it("classifies model capacity as a retryable provider failure", () => {
    expect(
      classifyAgentTransientFailure("Selected model is at capacity. Please try a different model."),
    ).toEqual({
      kind: "model-capacity",
      domain: "provider",
      retryable: true,
    });
  });

  it("classifies Codex backend transport 404 output as a retryable provider failure", () => {
    const output =
      "unexpected status 404 Not Found: Unknown error, url: https://chatgpt.com/backend-api/codex/responses";

    expect(classifyAgentTransientFailure(output)).toEqual({
      kind: "rate-limit",
      domain: "provider",
      retryable: true,
    });
    expect(isProviderTransientFailure(output)).toBe(true);
  });

  it("classifies queue and readiness failures without treating them as provider failures", () => {
    expect(classifyAgentTransientFailure("loop supervisor task queue is full")).toEqual({
      kind: "queue-capacity",
      domain: "queue",
      retryable: true,
    });
    expect(classifyAgentTransientFailure("Codex did not become ready in time")).toEqual({
      kind: "agent-readiness",
      domain: "agent-runtime",
      retryable: true,
    });
    expect(isProviderTransientFailure("loop supervisor task queue is full")).toBe(false);
  });

  it.each([
    "Cannot verify live agent identity for managed context reset",
    "Codex live transcript unavailable and no fresh launch grant",
    "Cannot verify automation input surface: composer missing or contains pending input",
    "Agent context reset readiness deadline exhausted",
  ])("classifies managed dispatch readiness refusal: %s", (message) => {
    expect(classifyAgentTransientFailure(message)).toEqual({
      kind: "agent-readiness",
      domain: "agent-runtime",
      retryable: true,
    });
    expect(isProviderTransientFailure(message)).toBe(false);
  });

  it.each([
    "Codex live transcript unavailable for managed completion evidence",
    "Reserved worker ownership changed during context reset",
    "Codex process changed during managed context reset",
    "Cannot verify an unrelated project identity",
  ])("preserves ownership and unrelated failures: %s", (message) => {
    expect(classifyAgentTransientFailure(message)).toBeNull();
  });

  it.each([
    "ownership changed",
    "process changed",
    "stop unverified",
    "unresolved active turn",
    "Codex live transcript unavailable for managed completion evidence",
  ])("does not let a reset refusal override unsafe execution evidence: %s", (unsafe) => {
    for (const refusal of [
      "Cannot verify automation input surface: composer missing or contains pending input",
      "Agent context reset readiness deadline exhausted",
    ])
      expect(classifyAgentTransientFailure(`${refusal}; ${unsafe}`)).toBeNull();
  });

  it("does not classify ordinary task failures as transient agent failures", () => {
    expect(classifyAgentTransientFailure("pnpm test failed with assertion errors")).toBeNull();
    expect(isAgentTransientFailure("pnpm test failed with assertion errors")).toBe(false);
  });
});
