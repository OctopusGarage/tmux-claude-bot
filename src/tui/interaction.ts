import { dangerousControlPrompt } from "./danger-confirmation.js";

export type PendingDanger = { action: string; session: string; label: string };

export type InteractionState = {
  status: string;
  pendingDanger: PendingDanger | null;
};

export type InteractionEffect =
  | { kind: "control"; action: string; session: string }
  | { kind: "send"; session: string; text: string }
  | { kind: "open-project"; sid: string; label: string };

export type InteractionResult = { state: InteractionState; effect?: InteractionEffect };

export function initialInteractionState(
  overrides: Partial<InteractionState> = {},
): InteractionState {
  return { status: "connecting…", pendingDanger: null, ...overrides };
}

export function controlIntent(state: InteractionState, input: PendingDanger): InteractionResult {
  const prompt = dangerousControlPrompt(input.action, input.label);
  if (prompt !== null) return { state: { ...state, pendingDanger: input, status: prompt } };
  return controlEffect(state, input);
}

export function controlOutcome(
  state: InteractionState,
  outcome: "confirm" | "cancel",
): InteractionResult {
  const pending = state.pendingDanger;
  if (pending === null) return { state };
  if (outcome === "cancel") {
    return { state: { ...state, pendingDanger: null, status: `cancelled ${pending.action}` } };
  }
  return controlEffect({ ...state, pendingDanger: null }, pending);
}

export function promptSendIntent(
  state: InteractionState,
  input: { session: string; label: string; text: string },
): InteractionResult {
  const text = input.text.trim();
  if (!text) return { state };
  return {
    state: { ...state, status: `→ sent to ${input.label}` },
    effect: { kind: "send", session: input.session, text },
  };
}

export function projectOpenIntent(
  state: InteractionState,
  input: { sid: string; label: string },
): InteractionResult {
  return {
    state: { ...state, status: `opening ${input.label}…` },
    effect: { kind: "open-project", sid: input.sid, label: input.label },
  };
}

export function controlServerEvent(
  state: InteractionState,
  event:
    | { kind: "disconnected" }
    | { kind: "reconnected" }
    | { kind: "notify"; text: string }
    | { kind: "error"; error: string }
    | { kind: "reply"; session: string; output: string },
): InteractionResult {
  if (event.kind === "disconnected")
    return { state: { ...state, status: "⚠ bot disconnected — reconnecting…" } };
  if (event.kind === "reconnected") return { state: { ...state, status: "reconnected" } };
  if (event.kind === "notify")
    return { state: { ...state, status: `… ${event.text.slice(0, 70)}` } };
  if (event.kind === "error")
    return { state: { ...state, status: `✗ ${event.error.slice(0, 70)}` } };
  return {
    state: {
      ...state,
      status: `✓ ${event.session.slice(-18)}: ${event.output.replace(/\s+/g, " ").slice(0, 60)}`,
    },
  };
}

function controlEffect(state: InteractionState, input: PendingDanger): InteractionResult {
  return {
    state: { ...state, status: `→ ${input.action} → ${input.label}` },
    effect: { kind: "control", action: input.action, session: input.session },
  };
}
