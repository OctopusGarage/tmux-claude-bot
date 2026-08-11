import { type AgentKind, agentGlyph } from "../../shared/types.js";
import { UI_ICONS } from "../../shared/ui/icons.js";
import { tildeifyHome } from "../../shared/utils/path.js";
import type { UsageSnapshot } from "../read/usage.js";
import type { DashboardSnapshot, SessionRow } from "./dashboard.js";
import type { RuntimeOverview } from "./runtime-overview.js";

/** Compact human-readable duration from milliseconds.
 * <60s → "Ns"; <60m → "Nm" or "NmSs"; <24h → "Nh" or "NhMm"; else "NdMh". */
export function humanizeMs(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const totalMin = Math.floor(totalSec / 60);
  const totalHour = Math.floor(totalMin / 60);
  const totalDay = Math.floor(totalHour / 24);

  if (totalSec < 60) return `${totalSec}s`;

  if (totalMin < 60) {
    const s = totalSec % 60;
    return s > 0 ? `${totalMin}m${s}s` : `${totalMin}m`;
  }

  if (totalHour < 24) {
    const m = totalMin % 60;
    return m > 0 ? `${totalHour}h${m}m` : `${totalHour}h`;
  }

  const h = totalHour % 24;
  return h > 0 ? `${totalDay}d${h}h` : `${totalDay}d`;
}

function formatAdapters(adapters: { telegram: boolean; lark: boolean }): string {
  const parts: string[] = [];
  if (adapters.telegram) parts.push("TG");
  if (adapters.lark) parts.push("Lark");
  return parts.length > 0 ? parts.join("+") : "none";
}

function formatUsageParts(usage: UsageSnapshot): string {
  const parts: string[] = [];
  if (usage.contextPct !== null) parts.push(`ctx ${Math.round(usage.contextPct)}%`);
  if (usage.fiveHourPct !== null) parts.push(`5h ${Math.round(usage.fiveHourPct)}%`);
  if (usage.sevenDayPct !== null) parts.push(`7d ${Math.round(usage.sevenDayPct)}%`);
  return parts.length > 0 ? `📊 ${parts.join(" · ")}` : "";
}

function formatAgentKind(kind: AgentKind): string {
  return kind === "codex" ? "Codex" : "Claude";
}

function formatSessionKind(row: SessionRow): string {
  if (row.sessionKind === "operator") return `${UI_ICONS.session.regular} operator`;
  if (row.sessionKind === "independent") {
    const slot = row.independentSlot !== null ? ` #${row.independentSlot}` : "";
    return `${UI_ICONS.session.independent} independent${slot}`;
  }
  return `${UI_ICONS.session.regular} regular`;
}

export type DashboardFormatOptions = {
  showGroups?: boolean;
  problemsOnly?: boolean;
  project?: string;
  labels?: Partial<DashboardLabels>;
};

export type DashboardLabels = {
  overallHealth: string;
  attention: string;
  activeWork: string;
  automation: string;
  operatorAi: string;
  runtimeDomains: string;
  recentOutcomes: string;
  projectSessions: string;
  none: string;
  more: string;
};

const ENGLISH_DASHBOARD_LABELS: DashboardLabels = {
  overallHealth: "Overall Health",
  attention: "Attention",
  activeWork: "Active Work",
  automation: "Automation",
  operatorAi: "Operator and AI Interfaces",
  runtimeDomains: "Runtime Domains",
  recentOutcomes: "Recent Outcomes",
  projectSessions: "Project Sessions",
  none: "none",
  more: "more",
};

function dashboardLabels(labels: Partial<DashboardLabels> | undefined): DashboardLabels {
  return { ...ENGLISH_DASHBOARD_LABELS, ...labels };
}

/** One session as two lines: a status-dot + name headline, then an indented
 * detail line (kind/api · state · uptime · usage · cumulative). Emoji-labeled
 * so it stays scannable as plain chat text (no monospace column alignment). */
function formatSessionBlock(row: SessionRow, options: DashboardFormatOptions = {}): string {
  // Three states: 🟢 busy (agent working) · 🟡 idle (agent up, waiting) · ⚫ stopped
  // (no agent in the pane — a shell, or the agent exited). The middle/last were
  // previously both ⚪, so a stopped session looked the same as an idle one.
  const dot = row.busy ? "🟢" : row.running ? "🟡" : "⚫";
  const label = row.operator ? `${UI_ICONS.session.regular} ${row.label}` : row.label;
  // api vs subscription matters operationally (which sessions burn API credits).
  const apiTag = row.apiMode ? `/${row.apiMode === "subscription" ? "sub" : "api"}` : "";
  const agent = `${agentGlyph(row.kind)} ${formatAgentKind(row.kind)}${apiTag}`;
  const type = formatSessionKind(row);
  const group =
    options.showGroups === false || !row.group
      ? ""
      : `${UI_ICONS.group.projectGroup} ${row.group.label}`;
  const path = row.workspacePath
    ? `${UI_ICONS.project.workspace} ${tildeifyHome(row.workspacePath)}`
    : "";
  // Same precedence as the dot (busy → running → stopped): a session can read busy
  // from recent activity while its agent has just exited (running=false), and there
  // it should show 🔥 busy, not ⏹ stopped — matching its 🟢 dot.
  const state = row.busy
    ? row.taskMs !== undefined
      ? `🔥 busy ${humanizeMs(row.taskMs)}`
      : "🔥 busy"
    : row.running
      ? "💤 idle"
      : "⏹ stopped";
  const uptime = `⏱ up ${humanizeMs(row.uptimeMs)}`;
  const usage = row.usage ? formatUsageParts(row.usage) : "";
  const total = row.cumulativeBusyMs > 0 ? `Σ ${humanizeMs(row.cumulativeBusyMs)}` : "";

  const detail = [agent, type, group, path, state, uptime, usage, total]
    .filter(Boolean)
    .join(" · ");
  return `${dot} ${label}\n   ↳ ${detail}`;
}

/** The compact fleet summary line(s) shown at the top of the dashboard / TUI:
 * bot version + uptime, session counts, queue depth, and connected adapters. */
export function formatHeader(s: DashboardSnapshot, labels: Partial<DashboardLabels> = {}): string {
  const uptime = s.global.botUptimeMs !== null ? humanizeMs(s.global.botUptimeMs) : "?";
  const adapters = formatAdapters(s.global.adapters);
  const text = dashboardLabels(labels);
  const health = s.overview
    ? `${text.overallHealth}: ${s.overview.health.status} · ${text.attention.toLowerCase()} ${s.overview.health.attentionCount} · ${text.activeWork.toLowerCase()} ${s.overview.activeWork.total}\n`
    : "";
  return (
    health +
    `🤖 tmux-claude-bot · v${s.global.version}\n` +
    `⏱ up ${uptime} · 🗂 ${s.global.sessionCount} sessions · ` +
    `▶ ${s.global.runningCount} running · 🟢 ${s.global.busyCount} busy · ` +
    `📬 queue ${s.global.queueDepth} · 🔌 ${adapters}`
  );
}

function truncationLine(total: number, included: number, more: string): string[] {
  const omitted = total - included;
  return omitted > 0 ? [`  … +${omitted} ${more}`] : [];
}

function formatOverviewBlocks(
  overview: RuntimeOverview,
  options: {
    chat?: boolean;
    problemsOnly?: boolean;
    project?: string;
    labels?: Partial<DashboardLabels>;
  } = {},
): string[] {
  const labels = dashboardLabels(options.labels);
  const attentionLimit = options.chat ? 3 : overview.attention.items.length;
  const activeLimit = options.chat ? 5 : overview.activeWork.items.length;
  const outcomeLimit = options.chat ? 3 : overview.recentOutcomes.items.length;
  const attention = overview.attention.items.slice(0, attentionLimit);
  const active = overview.activeWork.items
    .filter(
      (item) =>
        options.project === undefined ||
        item.projectId === options.project ||
        item.label.toLowerCase().includes(options.project.toLowerCase()),
    )
    .slice(0, activeLimit);
  const outcomes = overview.recentOutcomes.items
    .filter(
      (item) =>
        options.project === undefined ||
        item.label.toLowerCase().includes(options.project.toLowerCase()),
    )
    .slice(0, outcomeLimit);
  const blocks: string[] = [];

  if (attention.length > 0) {
    blocks.push(
      [
        `${labels.attention} (${overview.attention.total})`,
        ...attention.map(
          (item) =>
            `  ${item.severity === "error" ? "🔴" : item.severity === "warning" ? "🟠" : "🔵"} ${item.summary} — ${item.nextAction}`,
        ),
        ...truncationLine(overview.attention.total, attention.length, labels.more),
      ].join("\n"),
    );
  } else {
    blocks.push(`${labels.attention}: ${labels.none}`);
  }

  if (!options.problemsOnly) {
    blocks.push(
      [
        `${labels.activeWork} (${overview.activeWork.total})`,
        ...(active.length > 0
          ? active.map((item) => `  ▶ ${item.label} · ${item.status}`)
          : [`  ${labels.none}`]),
        ...truncationLine(overview.activeWork.total, active.length, labels.more),
      ].join("\n"),
    );
    const enabled = overview.automation.filter((item) => item.enabled);
    blocks.push(
      [
        `${labels.automation} (${enabled.length}/${overview.automation.length} enabled)`,
        ...overview.automation.map(
          (item) =>
            `  ${item.enabled ? "✓" : "○"} ${item.label} · ${item.enabled ? "enabled" : "disabled"} · active ${item.activeCount}${item.tickMs === undefined ? "" : ` · every ${humanizeMs(item.tickMs)}`}`,
        ),
      ].join("\n"),
    );
    blocks.push(
      [
        labels.operatorAi,
        `  session ${overview.operator.session.state} · skills ${overview.operator.skills.installed}/${overview.operator.skills.expected} ${overview.operator.skills.state} · MCP ${overview.operator.mcpProfiles.installed}/${overview.operator.mcpProfiles.expected} ${overview.operator.mcpProfiles.state}`,
        `  Prompt Library ${overview.operator.promptLibrary.state} · optional project MCPs ${overview.operator.optionalProjectMcpCount}`,
      ].join("\n"),
    );
    blocks.push(
      [
        labels.runtimeDomains,
        ...overview.runtimeDomains.map(
          (item) =>
            `  ${item.status === "healthy" ? "✓" : item.status === "disabled" ? "○" : "!"} ${item.label} · ${item.status} · ${item.summary}`,
        ),
      ].join("\n"),
    );
    blocks.push(
      [
        `${labels.recentOutcomes} (${overview.recentOutcomes.total})`,
        ...(outcomes.length > 0
          ? outcomes.map(
              (item) => `  ${item.status === "passed" ? "✓" : "!"} ${item.label} · ${item.status}`,
            )
          : [`  ${labels.none}`]),
        ...truncationLine(overview.recentOutcomes.total, outcomes.length, labels.more),
      ].join("\n"),
    );
  }
  return blocks;
}

/** Read-only Runtime Overview detail used by compact terminal surfaces. */
export function formatRuntimeOverviewText(
  overview: RuntimeOverview,
  labels: Partial<DashboardLabels> = {},
): string {
  return formatOverviewBlocks(overview, { labels }).join("\n\n");
}

/** Assemble header + a blank line + the session blocks (header only when empty). */
function assemble(header: string, blocks: string[]): string {
  return blocks.length > 0 ? `${header}\n\n${blocks.join("\n")}` : header;
}

/** Render a full text dashboard: header + one block per session. */
export function formatDashboardText(
  s: DashboardSnapshot,
  options: DashboardFormatOptions = {},
): string {
  const sessions = s.sessions.filter(
    (row) =>
      options.project === undefined ||
      row.session === options.project ||
      row.label.toLowerCase().includes(options.project.toLowerCase()),
  );
  const blocks = [
    ...(s.overview ? formatOverviewBlocks(s.overview, options) : []),
    ...(options.problemsOnly
      ? []
      : [
          dashboardLabels(options.labels).projectSessions,
          ...sessions.map((row) => formatSessionBlock(row, options)),
        ]),
  ];
  return assemble(formatHeader(s, options.labels), blocks);
}

/** Render a chat-friendly dashboard capped at `maxChars`.
 * Header is always included; session blocks are appended while they fit (a blank
 * line separates the header). If blocks are dropped, a `…(+N more)` trailer is
 * appended when it still fits. */
export function formatDashboardForChat(
  s: DashboardSnapshot,
  { maxChars, showGroups, labels }: { maxChars: number } & DashboardFormatOptions,
): string {
  const header = formatHeader(s, labels);
  const options = showGroups === undefined ? {} : { showGroups };
  const blocks = [
    ...(s.overview
      ? formatOverviewBlocks(s.overview, {
          chat: true,
          ...(labels === undefined ? {} : { labels }),
        })
      : []),
    ...s.sessions.map((row) => formatSessionBlock(row, options)),
  ];

  let result = header.slice(0, maxChars);
  let included = 0;
  for (let i = 0; i < blocks.length; i++) {
    const sep = i === 0 ? "\n\n" : "\n"; // blank line after the header only
    const candidate = `${result}${sep}${blocks[i]}`;
    if (candidate.length <= maxChars) {
      result = candidate;
      included++;
    } else {
      break;
    }
  }

  const dropped = blocks.length - included;
  if (dropped > 0) {
    const trailer = `\n…(+${dropped} ${dashboardLabels(labels).more})`;
    if ((result + trailer).length <= maxChars) result += trailer;
  }

  return result;
}
