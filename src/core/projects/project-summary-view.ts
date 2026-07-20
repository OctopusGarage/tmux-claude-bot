import { type AgentKind, agentGlyph } from "../../shared/types.js";
import { UI_ICONS } from "../../shared/ui/icons.js";
import type { Messages } from "../i18n/index.js";

export const PROJECT_SUMMARY_ICONS = {
  busy: UI_ICONS.session.busy,
  driftedPath: UI_ICONS.session.driftedPath,
  free: UI_ICONS.session.independent,
  regular: UI_ICONS.session.regular,
  grouped: UI_ICONS.group.projectGroup,
  path: UI_ICONS.project.workspace,
  ungrouped: UI_ICONS.project.create,
  sessionRunning: UI_ICONS.session.active,
  sessionStopped: UI_ICONS.session.stopped,
} as const;

export type ProjectSummaryStatus = {
  alive: boolean;
  isFree: boolean;
  agentKind: AgentKind | null;
  agentRunning: boolean;
  agentBusy: boolean;
  hasGroup: boolean;
  groupLabel: string | null;
};

export type ProjectSummaryBlock = {
  label: string;
  statusLine?: string;
  path?: string | null;
};

export type ProjectSummaryFormatOptions = {
  boldLabel?: boolean;
  markdownPath?: boolean;
};

export type ProjectStatusLineOptions = {
  showGroup?: boolean;
};

export function formatAgentKind(kind: AgentKind): string {
  return kind === "codex" ? "Codex" : "Claude";
}

export function formatOptionalAgentKind(kind: AgentKind | null): string | null {
  return kind ? formatAgentKind(kind) : null;
}

export function decorateProjectListLabel(
  baseLabel: string,
  status: {
    agentKind: AgentKind | null;
    agentBusy: boolean;
    pathDrifted: boolean;
  },
): string {
  const busy = status.agentBusy ? PROJECT_SUMMARY_ICONS.busy : "";
  const drift = status.pathDrifted ? ` ${PROJECT_SUMMARY_ICONS.driftedPath}` : "";
  return `${agentGlyph(status.agentKind)}${busy} ${baseLabel}${drift}`;
}

export function formatProjectStatusLine(
  m: Messages,
  input: ProjectSummaryStatus,
  options: ProjectStatusLineOptions = {},
): string {
  const agent = formatOptionalAgentKind(input.agentKind);
  const session = m.projectStatusSession(input.alive);
  const agentStatus = m.projectStatusAgent(agent, input.agentRunning, input.agentBusy);
  const type = m.projectStatusType(input.isFree);
  if (options.showGroup === false) return [session, agentStatus, type].join(" · ");
  return m.projectStatusLine(
    session,
    agentStatus,
    type,
    m.projectStatusGroup(input.hasGroup ? input.groupLabel : null),
  );
}

export function formatProjectSummaryItem(
  project: ProjectSummaryBlock,
  options: ProjectSummaryFormatOptions = {},
): string {
  const label = options.boldLabel ? `**${project.label}**` : project.label;
  const path = project.path
    ? `${PROJECT_SUMMARY_ICONS.path} ${options.markdownPath ? `\`${project.path}\`` : project.path}`
    : null;
  return [label, project.statusLine, path].filter(Boolean).join("\n");
}

export function formatCurrentProjectSummary(
  m: Messages,
  project: ProjectSummaryBlock,
  options: ProjectSummaryFormatOptions = {},
): string {
  return formatProjectSummaryItem(
    {
      label: m.currentProjectIs(project.label),
      ...(project.statusLine ? { statusLine: project.statusLine } : {}),
      ...(project.path ? { path: project.path } : {}),
    },
    options,
  );
}

export function formatProjectSummaryBlock(
  projects: readonly ProjectSummaryBlock[],
  options: ProjectSummaryFormatOptions = {},
): string {
  return projects.map((p) => formatProjectSummaryItem(p, options)).join("\n\n");
}
