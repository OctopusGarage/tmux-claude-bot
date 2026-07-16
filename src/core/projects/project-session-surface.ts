import type { ProjectPickerLikeRow } from "./project-session-picker.js";
import { projectPickerHasAction, projectPickerPrimaryAction } from "./project-session-picker.js";

export type ProjectSessionPrimaryIntent =
  | { kind: "switch"; sid: string }
  | { kind: "create"; sid: string }
  | { kind: "inert" };

/**
 * Project Session Surface helper for adapter rendering. It translates picker
 * action ids into a small interface adapters can render without knowing the
 * catalog/picker action taxonomy.
 */
export function projectSessionPrimaryIntent(
  row: ProjectPickerLikeRow,
): ProjectSessionPrimaryIntent {
  const action = projectPickerPrimaryAction(row);
  if (action === "switch-session") return { kind: "switch", sid: row.sid };
  if (action === "create-session") return { kind: "create", sid: row.sid };
  return { kind: "inert" };
}

export function canCreateExistingIndependentGroup(row: ProjectPickerLikeRow): boolean {
  return projectPickerHasAction(row, "create-existing-independent-group");
}
