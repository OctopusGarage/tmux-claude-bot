import * as fs from "node:fs";
import type { AgentKind } from "../../shared/types.js";
import { sessionShortId } from "../../shared/utils/hash.js";
import { inspectAgentActivity, stoppedAgentActivity } from "../agents/agent-activity.js";
import { resolveAgentKind } from "../agents/agentKindMap.js";
import type { HandlerDeps } from "../deps.js";
import { messages } from "../i18n/index.js";
import { type FreeProjectEntry, freeLabel, freeSlotOf, getFreeProject } from "./free-projects.js";
import { bindingForSession } from "./group-bindings.js";
import { isOperator, listUserProjectSessions } from "./operator.js";
import { projectLabel } from "./project-label.js";
import { channelFromScope } from "./project-manager.js";
import { decorateProjectListLabel, formatProjectStatusLine } from "./project-summary-view.js";
import { readRecentProjectLines } from "./recentProjects.js";
import { getPathBySession, sessionNameFromPath } from "./sessionPathMap.js";

export type CatalogQuery =
  | { kind: "live-roster"; scope: string }
  | { kind: "workspace-picker"; scope: string }
  | { kind: "regular-group-candidates"; scope: string }
  | { kind: "group-bind-candidates"; scope: string; currentGroupId?: string | null }
  | { kind: "parallel-group-sources"; scope: string }
  | { kind: "existing-independent-group-candidates"; scope: string }
  | { kind: "current-selection"; scope: string };

export type CatalogRowKind = "regular" | "independent" | "operator";
export type CatalogEntryKind = "project-session" | "recent-project" | "current-selection";

export type CatalogActionId =
  | "switch-session"
  | "create-session"
  | "remove-session"
  | "create-regular-group"
  | "bind-group"
  | "create-parallel-group"
  | "bind-existing-independent-group";

export type CatalogActionUnavailableReason =
  | "not-live"
  | "already-live"
  | "already-current"
  | "not-regular-project"
  | "not-independent-project"
  | "missing-workspace"
  | "workspace-missing"
  | "already-has-group"
  | "operator-session";

export type CatalogActionDecision =
  | { available: true }
  | { available: false; reason: CatalogActionUnavailableReason };

export type CatalogActionSelection = {
  primaryAction: CatalogActionId | null;
  actionIds: CatalogActionId[];
};

export type ProjectSessionCatalogRow = {
  entryKind: CatalogEntryKind;
  sessionName: string;
  sid: string;
  kind: CatalogRowKind;
  label: string;
  baseLabel: string;
  statusLine: string;
  current: boolean;
  sessionLive: boolean;
  workspace: {
    path: string | null;
    exists: boolean;
  };
  independent: {
    slot: number | null;
    entry: FreeProjectEntry | null;
  };
  agent: {
    kind: AgentKind | null;
    running: boolean;
    busy: boolean;
    pathDrifted: boolean;
  };
  group: {
    hasBinding: boolean;
    label: string | null;
    chatId: string | null;
  };
  actions: Record<CatalogActionId, CatalogActionDecision>;
};

export type ProjectSessionCatalogResult =
  | { kind: "empty-current-selection" }
  | { kind: "rows"; rows: ProjectSessionCatalogRow[] };

type CatalogSource = {
  sessionName: string;
  entryKind: CatalogEntryKind;
  sessionLive: boolean;
  path: string | null;
  includeStoppedAgentFallback?: boolean;
};

export async function readProjectSessionCatalog(
  deps: HandlerDeps,
  query: CatalogQuery,
): Promise<ProjectSessionCatalogResult> {
  if (query.kind === "current-selection") {
    const current = await deps.currentProject.get(query.scope);
    if (!current) return { kind: "empty-current-selection" };
    const live = new Set(await listUserProjectSessions(deps));
    const row = await buildCatalogRow(deps, query.scope, {
      sessionName: current,
      entryKind: "current-selection",
      sessionLive: live.has(current),
      path: getPathBySession(current),
      includeStoppedAgentFallback: true,
    });
    return { kind: "rows", rows: [row] };
  }

  const rows =
    query.kind === "live-roster" || query.kind === "existing-independent-group-candidates"
      ? await liveRosterRows(deps, query.scope)
      : await workspaceRows(deps, query.scope);

  return { kind: "rows", rows: rows.filter((row) => includeForQuery(row, query)) };
}

async function liveRosterRows(
  deps: HandlerDeps,
  scope: string,
): Promise<ProjectSessionCatalogRow[]> {
  const current = await deps.currentProject.get(scope);
  const sessions = await listUserProjectSessions(deps);
  const rows = await Promise.all(
    sessions.map((sessionName) =>
      buildCatalogRow(deps, scope, {
        sessionName,
        entryKind: "project-session",
        sessionLive: true,
        path: getPathBySession(sessionName),
      }),
    ),
  );
  return rows.sort((a, b) => compareLiveRows(a, b, current));
}

async function workspaceRows(
  deps: HandlerDeps,
  scope: string,
): Promise<ProjectSessionCatalogRow[]> {
  const prefix = deps.config.projectSessionPrefix;
  const live = new Set(await listUserProjectSessions(deps));
  const sources: CatalogSource[] = [];
  const seen = new Set<string>();

  for (const p of await readRecentProjectLines()) {
    const sessionName = sessionNameFromPath(p, prefix);
    if (seen.has(sessionName)) continue;
    seen.add(sessionName);
    sources.push({
      sessionName,
      entryKind: live.has(sessionName) ? "project-session" : "recent-project",
      sessionLive: live.has(sessionName),
      path: p,
    });
  }

  for (const sessionName of [...live].sort()) {
    if (seen.has(sessionName)) continue;
    if (freeSlotOf(sessionName, prefix) !== null) continue;
    const p = getPathBySession(sessionName);
    if (!p) continue;
    seen.add(sessionName);
    sources.push({
      sessionName,
      entryKind: "project-session",
      sessionLive: true,
      path: p,
    });
  }

  const rows = await Promise.all(sources.map((source) => buildCatalogRow(deps, scope, source)));
  return rows.filter((row) => row.workspace.exists);
}

async function buildCatalogRow(
  deps: HandlerDeps,
  scope: string,
  source: CatalogSource,
): Promise<ProjectSessionCatalogRow> {
  const prefix = deps.config.projectSessionPrefix;
  const current = await deps.currentProject.get(scope);
  const slot = freeSlotOf(source.sessionName, prefix);
  const operator = isOperator(source.sessionName, prefix);
  const path = source.path ?? getPathBySession(source.sessionName);
  const binding = bindingForSession(source.sessionName);
  const baseLabel =
    slot !== null
      ? freeLabel(slot, getFreeProject(slot), path)
      : projectLabel(source.sessionName, path ?? undefined);

  let agent = stoppedAgentActivity();
  let label = baseLabel;
  if (source.sessionLive) {
    try {
      agent = await inspectAgentActivity(deps, source.sessionName, path);
      label = decorateProjectListLabel(baseLabel, agent);
    } catch {
      // Keep the row actionable with its plain label if a pane/agent probe fails.
    }
  } else if (source.includeStoppedAgentFallback) {
    try {
      agent = {
        ...agent,
        agentKind: await resolveAgentKind(deps.configResolver, source.sessionName),
      };
    } catch {
      // Current-selection must still render if the resolver is unavailable.
    }
  }

  const rowCore = {
    entryKind: source.entryKind,
    sessionName: source.sessionName,
    sid: sessionShortId(source.sessionName),
    kind: operator ? "operator" : slot !== null ? "independent" : "regular",
    label,
    baseLabel,
    statusLine: formatProjectStatusLine(
      messages(channelFromScope(scope)),
      {
        alive: source.sessionLive,
        isFree: slot !== null,
        agentKind: agent.agentKind,
        agentRunning: agent.agentRunning,
        agentBusy: agent.agentBusy,
        hasGroup: Boolean(binding),
        groupLabel: binding?.binding.label ?? null,
      },
      { showGroup: channelFromScope(scope) === "lark" },
    ),
    current: current === source.sessionName,
    sessionLive: source.sessionLive,
    workspace: {
      path,
      exists: path !== null && fs.existsSync(path),
    },
    independent: {
      slot,
      entry: slot !== null ? getFreeProject(slot) : null,
    },
    agent: {
      kind: agent.agentKind,
      running: agent.agentRunning,
      busy: agent.agentBusy,
      pathDrifted: agent.pathDrifted,
    },
    group: {
      hasBinding: Boolean(binding),
      label: binding?.binding.label ?? null,
      chatId: binding?.chatId ?? null,
    },
  } satisfies Omit<ProjectSessionCatalogRow, "actions">;

  return { ...rowCore, actions: actionDecisions(rowCore) };
}

function actionDecisions(
  row: Omit<ProjectSessionCatalogRow, "actions">,
): Record<CatalogActionId, CatalogActionDecision> {
  return {
    "switch-session": row.current
      ? unavailable("already-current")
      : row.sessionLive
        ? available()
        : unavailable("not-live"),
    "create-session": row.sessionLive
      ? unavailable("already-live")
      : row.workspace.path
        ? available()
        : unavailable("missing-workspace"),
    "remove-session":
      row.kind === "operator"
        ? unavailable("operator-session")
        : row.sessionLive
          ? available()
          : unavailable("not-live"),
    "create-regular-group":
      row.kind !== "regular"
        ? unavailable("not-regular-project")
        : row.group.hasBinding
          ? unavailable("already-has-group")
          : row.workspace.exists
            ? available()
            : unavailable("workspace-missing"),
    "bind-group":
      row.kind !== "regular"
        ? unavailable("not-regular-project")
        : row.workspace.exists
          ? available()
          : unavailable("workspace-missing"),
    "create-parallel-group":
      row.kind === "regular" && row.workspace.exists
        ? available()
        : unavailable(row.kind === "regular" ? "workspace-missing" : "not-regular-project"),
    "bind-existing-independent-group":
      row.kind !== "independent"
        ? unavailable("not-independent-project")
        : !row.sessionLive
          ? unavailable("not-live")
          : !row.workspace.path
            ? unavailable("missing-workspace")
            : row.group.hasBinding
              ? unavailable("already-has-group")
              : available(),
  };
}

function includeForQuery(row: ProjectSessionCatalogRow, query: CatalogQuery): boolean {
  switch (query.kind) {
    case "live-roster":
      return (
        row.kind !== "operator" &&
        row.sessionLive &&
        (row.kind !== "regular" || row.workspace.exists)
      );
    case "workspace-picker":
      return row.kind === "regular";
    case "regular-group-candidates":
      return row.actions["create-regular-group"].available;
    case "group-bind-candidates":
      return (
        row.kind === "regular" &&
        row.workspace.exists &&
        (!row.group.hasBinding ||
          (query.currentGroupId !== undefined &&
            query.currentGroupId !== null &&
            row.group.chatId === query.currentGroupId))
      );
    case "parallel-group-sources":
      return row.actions["create-parallel-group"].available;
    case "existing-independent-group-candidates":
      return row.actions["bind-existing-independent-group"].available;
    case "current-selection":
      return true;
  }
}

export function catalogActionsForQuery(
  row: ProjectSessionCatalogRow,
  query: CatalogQuery,
): CatalogActionSelection {
  switch (query.kind) {
    case "live-roster":
      return {
        primaryAction: row.current ? null : "switch-session",
        actionIds: availableCatalogActions(row, [
          "switch-session",
          "remove-session",
          "bind-existing-independent-group",
        ]),
      };
    case "workspace-picker":
      return singlePrimaryAction(
        row.current ? null : row.sessionLive ? "switch-session" : "create-session",
      );
    case "regular-group-candidates":
      return singlePrimaryAction("create-regular-group");
    case "group-bind-candidates":
      return singlePrimaryAction("bind-group");
    case "parallel-group-sources":
      return singlePrimaryAction("create-parallel-group");
    case "existing-independent-group-candidates":
      return singlePrimaryAction("bind-existing-independent-group");
    case "current-selection":
      return singlePrimaryAction(null);
  }
}

function singlePrimaryAction(action: CatalogActionId | null): CatalogActionSelection {
  return { primaryAction: action, actionIds: action ? [action] : [] };
}

function availableCatalogActions(
  row: ProjectSessionCatalogRow,
  actions: readonly CatalogActionId[],
): CatalogActionId[] {
  return actions.filter((action) => row.actions[action].available);
}

function compareLiveRows(
  a: ProjectSessionCatalogRow,
  b: ProjectSessionCatalogRow,
  current: string | null,
): number {
  const currentDelta = Number(b.sessionName === current) - Number(a.sessionName === current);
  if (currentDelta !== 0) return currentDelta;
  const groupA = a.kind === "regular" ? 0 : a.kind === "independent" ? 1 : 2;
  const groupB = b.kind === "regular" ? 0 : b.kind === "independent" ? 1 : 2;
  if (groupA !== groupB) return groupA - groupB;
  if (a.kind === "independent" && b.kind === "independent") {
    return (a.independent.slot ?? 0) - (b.independent.slot ?? 0);
  }
  return a.baseLabel.localeCompare(b.baseLabel);
}

function available(): CatalogActionDecision {
  return { available: true };
}

function unavailable(reason: CatalogActionUnavailableReason): CatalogActionDecision {
  return { available: false, reason };
}
