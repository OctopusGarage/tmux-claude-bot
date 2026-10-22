export type AgentTransientFailureKind =
  | "model-capacity"
  | "rate-limit"
  | "agent-readiness"
  | "queue-capacity"
  | "network-transient";

export type AgentTransientFailureDomain = "provider" | "agent-runtime" | "queue" | "network";

export type AgentTransientFailure = {
  kind: AgentTransientFailureKind;
  domain: AgentTransientFailureDomain;
  retryable: true;
};

export function classifyAgentTransientFailure(
  text: string | undefined,
): AgentTransientFailure | null {
  const normalized = (text ?? "").toLowerCase();
  if (normalized.length === 0) return null;

  if (
    normalized.includes("selected model is at capacity") ||
    normalized.includes("model is at capacity") ||
    normalized.includes("try a different model") ||
    normalized.includes("model capacity")
  ) {
    return { kind: "model-capacity", domain: "provider", retryable: true };
  }
  if (
    normalized.includes("rate limit") ||
    normalized.includes("rate-limit") ||
    normalized.includes("too many requests") ||
    normalized.includes("temporarily unavailable") ||
    normalized.includes("overloaded") ||
    (normalized.includes("unexpected status 404") &&
      normalized.includes("backend-api/codex/responses"))
  ) {
    return { kind: "rate-limit", domain: "provider", retryable: true };
  }
  if (
    normalized.includes("did not become ready") ||
    normalized.includes("no live loop supervisor session")
  ) {
    return { kind: "agent-readiness", domain: "agent-runtime", retryable: true };
  }
  if (
    normalized.includes("queue is full") ||
    normalized.includes("duplicate loop supervisor task is already queued or running")
  ) {
    return { kind: "queue-capacity", domain: "queue", retryable: true };
  }
  if (
    normalized.includes("network") ||
    normalized.includes("socket") ||
    normalized.includes("tls handshake")
  ) {
    return { kind: "network-transient", domain: "network", retryable: true };
  }
  return null;
}

export function isAgentTransientFailure(text: string | undefined): boolean {
  return classifyAgentTransientFailure(text) !== null;
}

export function isProviderTransientFailure(text: string | undefined): boolean {
  return classifyAgentTransientFailure(text)?.domain === "provider";
}
