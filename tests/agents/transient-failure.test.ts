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

  it("does not classify ordinary task failures as transient agent failures", () => {
    expect(classifyAgentTransientFailure("npm test failed with assertion errors")).toBeNull();
    expect(isAgentTransientFailure("npm test failed with assertion errors")).toBe(false);
  });
});
