import type { HandlerDeps } from "../deps.js";
import {
  type CatalogActionId,
  type CatalogActionSelection,
  type CatalogQuery,
  catalogActionsForQuery,
  type ProjectSessionCatalogRow,
  readProjectSessionCatalog,
} from "./project-session-catalog.js";
import type { ProjectSessionSummary } from "./project-session-summary.js";

export type ProjectPickerMode =
  | "project-sessions"
  | "recent-projects"
  | "project-group-create"
  | "project-group-bind"
  | "parallel-project-group"
  | "existing-independent-project-group";

export type ProjectPickerEntryKind = "project-session" | "recent-project";

export type ProjectPickerActionId =
  | "switch-session"
  | "create-session"
  | "remove-session"
  | "create-project-group"
  | "bind-project-group"
  | "create-parallel-project-group"
  | "create-existing-independent-group";

export interface ProjectPickerRow extends ProjectSessionSummary {
  entryKind: ProjectPickerEntryKind;
  primaryAction: ProjectPickerActionId | null;
  actionIds: ProjectPickerActionId[];
}

export type ProjectPickerLikeRow = ProjectSessionSummary &
  Partial<Pick<ProjectPickerRow, "entryKind" | "primaryAction" | "actionIds">>;

export function projectPickerPrimaryAction(
  row: ProjectPickerLikeRow,
): ProjectPickerRow["primaryAction"] {
  if (row.primaryAction !== undefined) return row.primaryAction;
  if (row.active) return null;
  return row.alive ? "switch-session" : "create-session";
}

export function projectPickerHasAction(
  row: ProjectPickerLikeRow,
  action: ProjectPickerActionId,
): boolean {
  if (row.actionIds) return row.actionIds.includes(action);
  return action === "create-existing-independent-group" ? Boolean(row.canCreateFreeGroup) : false;
}

function withAction(row: ProjectPickerRow, action: ProjectPickerActionId): ProjectPickerRow {
  return { ...row, primaryAction: action, actionIds: [action] };
}

const CATALOG_TO_PICKER_ACTION: Record<CatalogActionId, ProjectPickerActionId> = {
  "switch-session": "switch-session",
  "create-session": "create-session",
  "remove-session": "remove-session",
  "create-regular-group": "create-project-group",
  "bind-group": "bind-project-group",
  "create-parallel-group": "create-parallel-project-group",
  "bind-existing-independent-group": "create-existing-independent-group",
};

function toPickerAction(action: CatalogActionId | null): ProjectPickerActionId | null {
  return action ? CATALOG_TO_PICKER_ACTION[action] : null;
}

function toPickerActions(actions: readonly CatalogActionId[]): ProjectPickerActionId[] {
  return actions.map((action) => CATALOG_TO_PICKER_ACTION[action]);
}

function toProjectSessionSummary(row: ProjectSessionCatalogRow): ProjectSessionSummary {
  return {
    sessionName: row.sessionName,
    sid: row.sid,
    label: row.label,
    alive: row.sessionLive,
    active: row.current,
    path: row.workspace.path,
    isFree: row.kind === "independent",
    freeSlot: row.independent.slot,
    agentKind: row.agent.kind,
    agentRunning: row.agent.running,
    agentBusy: row.agent.busy,
    hasGroup: row.group.hasBinding,
    groupLabel: row.group.label,
    statusLine: row.statusLine,
    canCreateFreeGroup: row.actions["bind-existing-independent-group"].available,
  };
}

function toPickerRow(
  row: ProjectSessionCatalogRow,
  selection: CatalogActionSelection,
): ProjectPickerRow {
  const summary = toProjectSessionSummary(row);
  const primary = toPickerAction(selection.primaryAction);
  const actionIds = toPickerActions(selection.actionIds);
  if (primary && !actionIds.includes(primary)) actionIds.unshift(primary);
  return {
    ...summary,
    entryKind: row.entryKind === "recent-project" ? "recent-project" : "project-session",
    primaryAction: primary,
    actionIds,
  };
}

function regularProject(row: ProjectPickerRow): boolean {
  return !row.isFree;
}

export function projectPickerRowsFromRecentRows(
  rows: readonly ProjectPickerRow[],
  mode: Extract<
    ProjectPickerMode,
    "recent-projects" | "project-group-create" | "project-group-bind" | "parallel-project-group"
  >,
): ProjectPickerRow[] {
  switch (mode) {
    case "recent-projects":
      return [...rows];
    case "project-group-create":
      return rows
        .filter((row) => regularProject(row) && !row.hasGroup)
        .map((row) => withAction(row, "create-project-group"));
    case "project-group-bind":
      return rows.filter(regularProject).map((row) => withAction(row, "bind-project-group"));
    case "parallel-project-group":
      return rows
        .filter(regularProject)
        .map((row) => withAction(row, "create-parallel-project-group"));
  }
}

function queryForMode(scope: string, mode: ProjectPickerMode): CatalogQuery {
  switch (mode) {
    case "project-sessions":
      return { kind: "live-roster", scope };
    case "recent-projects":
      return { kind: "workspace-picker", scope };
    case "project-group-create":
      return { kind: "regular-group-candidates", scope };
    case "project-group-bind":
      return { kind: "group-bind-candidates", scope, currentGroupId: groupIdFromScope(scope) };
    case "parallel-project-group":
      return { kind: "parallel-group-sources", scope };
    case "existing-independent-project-group":
      return { kind: "existing-independent-group-candidates", scope };
  }
}

function groupIdFromScope(scope: string): string | null {
  return scope.startsWith("lark:") ? scope.slice("lark:".length) || null : null;
}

export async function projectPickerRows(
  deps: HandlerDeps,
  channel: string,
  mode: ProjectPickerMode,
): Promise<ProjectPickerRow[]> {
  const query = queryForMode(channel, mode);
  const result = await readProjectSessionCatalog(deps, query);
  if (result.kind === "empty-current-selection") return [];
  return result.rows.map((row) => toPickerRow(row, catalogActionsForQuery(row, query)));
}

export async function currentSelectionRow(
  deps: HandlerDeps,
  channel: string,
): Promise<ProjectPickerRow | null> {
  const result = await readProjectSessionCatalog(deps, {
    kind: "current-selection",
    scope: channel,
  });
  if (result.kind === "empty-current-selection") return null;
  const [row] = result.rows;
  return row
    ? toPickerRow(row, catalogActionsForQuery(row, { kind: "current-selection", scope: channel }))
    : null;
}
