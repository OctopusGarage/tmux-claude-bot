import { requiresActionConfirmation } from "../core/command/action-registry.js";

export type DangerConfirmationResult = "confirm" | "cancel" | "pending";

export function dangerousControlPrompt(action: string, label: string): string | null {
  return requiresActionConfirmation(action) ? `Confirm ${action} for ${label}? y/N` : null;
}

export function confirmDangerousControl(input: string): DangerConfirmationResult {
  if (input === "y" || input === "Y") return "confirm";
  if (input === "n" || input === "N" || input === "\u001b") return "cancel";
  return "pending";
}
