import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { parse, stringify } from "yaml";
import {
  type AgentSkillCommandRun,
  type AgentSkillRefreshSummary,
  AgentSkillRegistryStore,
  type AgentSkillSyncSummary,
  applyAgentSkillRegistryActions,
  type InstalledAgentSkill,
  listAgentSkills,
  refreshAgentSkillCatalog,
  resolveLatestGitSkill,
} from "../skills/registry.js";
import { LoopBacklogStore } from "./backlog.js";
import { type LoopValidationSummary, parseLoopConfigYaml, validateLoopConfig } from "./config.js";
import { listLoopReports, writeLoopRunReport } from "./report.js";
import { type LoopRunCommandInvocation, type LoopRunSummary, runLoopProject } from "./run.js";
import { LoopSchedulerStore, type LoopTickSummary, runLoopSchedulerTick } from "./scheduler.js";

export type LoopCommandResult =
  | { exitCode: number; stdout: string; stderr?: never }
  | { exitCode: number; stderr: string; stdout?: never };

function renderProjectLine(project: LoopValidationSummary["projects"][number]): string {
  const schedule = project.scheduled ? "scheduled" : "manual";
  const evalMode =
    project.eval.mode === "command"
      ? "command-eval"
      : project.eval.mode === "agent"
        ? "agent-eval"
        : "no-eval";
  const commit = project.commit.enabled ? "commits-on" : "commits-off";
  const execution = project.execution.agent ? "agent-exec" : "exec-off";
  return `- ${project.id}: ${project.readiness.runnable ? "runnable" : "blocked"} command-assessment ${evalMode} ${commit} ${execution} ${schedule}`;
}

function parseCliTime(value: string): number {
  if (/^\d+$/.test(value)) return Number(value);
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new Error(`invalid time "${value}"`);
  return parsed;
}

export function renderLoopValidationText(summary: LoopValidationSummary): string {
  return [
    `loop config ok: ${summary.projectCount} project(s), ${summary.approvedSkillCount} approved skill(s)`,
    `loop preflight: ${summary.readinessSummary.errorCount} error(s), ${summary.readinessSummary.warningCount} warning(s)`,
    ...summary.projects.map(renderProjectLine),
  ].join("\n");
}

export function renderLoopTickText(summary: LoopTickSummary): string {
  return [
    `loop tick completed: checked ${summary.checked}, scheduled ${summary.scheduled}, due ${summary.due}, executed ${summary.executed}`,
    ...summary.dueProjects.map(
      (project) =>
        `- ${project.projectId}: ${project.action} at ${new Date(project.scheduledAt).toISOString()}`,
    ),
  ].join("\n");
}

export function renderLoopSkillsListText(skills: InstalledAgentSkill[]): string {
  if (skills.length === 0) return "loop skills: none";
  return [
    `loop skills: ${skills.length} recorded`,
    ...skills.map(
      (skill) =>
        `- ${skill.skillId}: ${skill.status} ${skill.ref} ${skill.checksum} ${skill.platforms.join(",")}`,
    ),
  ].join("\n");
}

export function renderLoopSkillSyncText(summary: AgentSkillSyncSummary): string {
  return [
    `loop skills sync completed: actions ${summary.actions.length}, applied ${summary.applied}`,
    ...summary.actions.map((action) => `- ${action.skillId}: ${action.action}`),
  ].join("\n");
}

export function renderLoopSkillRefreshText(summary: AgentSkillRefreshSummary): string {
  return [
    `loop skills refresh completed: refreshed ${summary.refreshed}, changed ${summary.changed}`,
    ...summary.updates.map(
      (update) =>
        `- ${update.skillId}: ${update.changed ? "changed" : "unchanged"} ${update.trackingRef} -> ${update.ref}`,
    ),
  ].join("\n");
}

export function renderLoopRunText(summary: LoopRunSummary): string {
  return [
    `loop run completed: ${summary.projectId} ${summary.status}, commands ${summary.executed}, committed ${summary.committed}`,
    ...summary.commands.map(
      (command) => `- ${command.kind}: ${command.status === 0 ? "passed" : "failed"}`,
    ),
  ].join("\n");
}

type TickArgs = { file: string; json: boolean; now: number };
type SkillSyncArgs = { file: string; json: boolean };
type SkillRefreshArgs = { file: string; json: boolean; write: boolean };
type RunArgs = { file: string; projectId: string; json: boolean };
type LoopTargetKind = "project" | "workspace" | "repo";
type TargetListArgs = { file: string; json: boolean };
type TargetToggleArgs = {
  file: string;
  kind: LoopTargetKind;
  id: string;
  enabled: boolean;
  json: boolean;
};
type LoopTargetSummary = {
  kind: LoopTargetKind;
  id: string;
  name: string;
  enabled: boolean;
  scheduled: boolean;
  scheduledJobs: string[];
  schedule?: string;
};

function rejectManualRun(
  project: ReturnType<typeof parseLoopConfigYaml>["projects"][number],
): string | null {
  if (project.runner.kind !== "agent-supervised") return null;
  return `loop project "${project.id}" uses runner.kind=agent-supervised; manual CLI runs require the managed Loop Supervisor`;
}

function parseTickArgs(args: string[]): TickArgs | string {
  const [, file, ...rest] = args;
  if (file === undefined) return "Usage: loop tick <file> [--now <time>] [--json]";
  let json = false;
  let now = Date.now();
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--now") {
      const value = rest[index + 1];
      if (value === undefined) return "loop tick --now requires a value";
      now = parseCliTime(value);
      index++;
      continue;
    }
    return `unknown loop tick option "${arg}"`;
  }
  return { file, json, now };
}

function parseSkillSyncArgs(args: string[]): SkillSyncArgs | string {
  const [, , file, ...rest] = args;
  if (file === undefined) return "Usage: loop skills sync <file> [--json]";
  let json = false;
  for (const arg of rest) {
    if (arg === "--json") {
      json = true;
      continue;
    }
    return `unknown loop skills sync option "${arg}"`;
  }
  return { file, json };
}

function parseSkillRefreshArgs(args: string[]): SkillRefreshArgs | string {
  const [, , file, ...rest] = args;
  if (file === undefined) return "Usage: loop skills refresh <file> [--write] [--json]";
  let json = false;
  let write = false;
  for (const arg of rest) {
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--write") {
      write = true;
      continue;
    }
    return `unknown loop skills refresh option "${arg}"`;
  }
  return { file, json, write };
}

function parseRunArgs(args: string[]): RunArgs | string {
  const [, file, projectId, ...rest] = args;
  if (file === undefined || projectId === undefined) {
    return "Usage: loop run <file> <projectId> [--json]";
  }
  let json = false;
  for (const arg of rest) {
    if (arg === "--json") {
      json = true;
      continue;
    }
    return `unknown loop run option "${arg}"`;
  }
  return { file, projectId, json };
}

function parseTargetListArgs(args: string[]): TargetListArgs | string {
  const [, , file, ...rest] = args;
  if (file === undefined) return "Usage: loop targets list <file> [--json]";
  let json = false;
  for (const arg of rest) {
    if (arg === "--json") {
      json = true;
      continue;
    }
    return `unknown loop targets list option "${arg}"`;
  }
  return { file, json };
}

function parseTargetToggleArgs(args: string[], enabled: boolean): TargetToggleArgs | string {
  const [, , file, kindValue, id, ...rest] = args;
  if (file === undefined || kindValue === undefined || id === undefined) {
    return "Usage: loop targets <enable|disable> <file> <project|workspace|repo> <id> [--json]";
  }
  if (kindValue !== "project" && kindValue !== "workspace" && kindValue !== "repo") {
    return `unknown loop target kind "${kindValue}"`;
  }
  const kind = kindValue;
  let json = false;
  for (const arg of rest) {
    if (arg === "--json") {
      json = true;
      continue;
    }
    return `unknown loop targets ${enabled ? "enable" : "disable"} option "${arg}"`;
  }
  return { file, kind, id, enabled, json };
}

function targetSummaries(config: ReturnType<typeof parseLoopConfigYaml>): LoopTargetSummary[] {
  const validation = validateLoopConfig(stringify(config));
  const projectJobs = new Map(
    validation.projects.map((project) => [project.id, project.scheduledJobs] as const),
  );
  const workspaceJobs = new Map(
    validation.workspaces.map((workspace) => [workspace.id, workspace.scheduledJobs] as const),
  );
  return [
    ...config.projects.map((project): LoopTargetSummary => {
      const scheduledJobs = projectJobs.get(project.id) ?? [];
      return {
        kind: "project",
        id: project.id,
        name: project.name,
        enabled: project.enabled,
        scheduled: scheduledJobs.length > 0,
        scheduledJobs,
        ...(project.schedule !== undefined ? { schedule: project.schedule } : {}),
      };
    }),
    ...config.workspaces.map((workspace): LoopTargetSummary => {
      const scheduledJobs = workspaceJobs.get(workspace.id) ?? [];
      return {
        kind: "workspace",
        id: workspace.id,
        name: workspace.name,
        enabled: workspace.enabled,
        scheduled: scheduledJobs.length > 0,
        scheduledJobs,
        ...(workspace.architecture.schedule !== undefined
          ? { schedule: workspace.architecture.schedule }
          : {}),
      };
    }),
    ...config.prReview.repositories.map(
      (repository): LoopTargetSummary => ({
        kind: "repo",
        id: repository.id,
        name: repository.name,
        enabled: repository.enabled,
        scheduled: repository.enabled,
        scheduledJobs: repository.enabled ? ["repository-pull-request-review"] : [],
        schedule: repository.schedule,
      }),
    ),
  ];
}

function renderLoopTargetsText(targets: LoopTargetSummary[]): string {
  if (targets.length === 0) return "loop targets: none";
  return [
    `loop targets: ${targets.length}`,
    ...targets.map((target) => {
      const schedule = target.scheduled ? "scheduled" : "paused";
      const enabled = target.enabled ? "enabled" : "disabled";
      const jobs = target.scheduledJobs.length > 0 ? target.scheduledJobs.join(",") : "none";
      return `- ${target.kind}:${target.id}: ${enabled} ${schedule} jobs=${jobs}`;
    }),
  ].join("\n");
}

function rawTargetList(doc: Record<string, unknown>, kind: LoopTargetKind): unknown[] {
  if (kind === "project") return Array.isArray(doc.projects) ? doc.projects : [];
  if (kind === "workspace") return Array.isArray(doc.workspaces) ? doc.workspaces : [];
  const prReview =
    typeof doc.prReview === "object" && doc.prReview !== null && !Array.isArray(doc.prReview)
      ? (doc.prReview as Record<string, unknown>)
      : {};
  return Array.isArray(prReview.repositories) ? prReview.repositories : [];
}

function setLoopTargetEnabled(
  text: string,
  input: TargetToggleArgs,
): { text: string; changed: boolean } {
  const raw = parse(text) as Record<string, unknown> | null;
  const doc = raw ?? {};
  const targets = rawTargetList(doc, input.kind);
  const target = targets.find(
    (item): item is Record<string, unknown> =>
      typeof item === "object" &&
      item !== null &&
      !Array.isArray(item) &&
      (item as Record<string, unknown>).id === input.id,
  );
  if (target === undefined) throw new Error(`loop target not found: ${input.kind} "${input.id}"`);
  const previous = target.enabled !== false;
  target.enabled = input.enabled;
  const nextText = stringify(doc);
  parseLoopConfigYaml(nextText);
  return { text: nextText, changed: previous !== input.enabled };
}

function runShellCommand(run: AgentSkillCommandRun | LoopRunCommandInvocation) {
  const result = spawnSync("sh", ["-lc", run.command], {
    cwd: run.cwd,
    env: { ...process.env, ...run.env },
    encoding: "utf8",
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.error instanceof Error ? result.error.message : result.stderr,
  };
}

function loopConfigTextWithApprovedSkills(
  text: string,
  approved: AgentSkillRefreshSummary["approved"],
) {
  const raw = parse(text) as Record<string, unknown> | null;
  const doc = raw ?? {};
  const skills =
    typeof doc.skills === "object" && doc.skills !== null && !Array.isArray(doc.skills)
      ? (doc.skills as Record<string, unknown>)
      : {};
  skills.approved = approved;
  doc.skills = skills;
  return stringify(doc);
}

export function runLoopCommand(args: string[]): LoopCommandResult {
  const [command, file, maybeJson] = args;
  try {
    if (command === "validate") {
      if (file === undefined)
        return { exitCode: 1, stderr: "Usage: loop validate <file> [--json]" };
      const json = maybeJson === "--json";
      if (maybeJson !== undefined && maybeJson !== "--json") {
        return { exitCode: 1, stderr: `unknown loop validate option "${maybeJson}"` };
      }
      const summary = validateLoopConfig(readFileSync(file, "utf8"));
      return {
        exitCode: summary.ok ? 0 : 1,
        stdout: json ? JSON.stringify(summary) : renderLoopValidationText(summary),
      };
    }
    if (command === "tick") {
      const parsed = parseTickArgs(args);
      if (typeof parsed === "string") return { exitCode: 1, stderr: parsed };
      const config = parseLoopConfigYaml(readFileSync(parsed.file, "utf8"));
      const store = new LoopSchedulerStore();
      const summary = runLoopSchedulerTick({
        config,
        now: parsed.now,
        lastFired: store.getLastFired(),
      });
      return {
        exitCode: 0,
        stdout: parsed.json ? JSON.stringify(summary) : renderLoopTickText(summary),
      };
    }
    if (command === "run") {
      const parsed = parseRunArgs(args);
      if (typeof parsed === "string") return { exitCode: 1, stderr: parsed };
      const config = parseLoopConfigYaml(readFileSync(parsed.file, "utf8"));
      const project = config.projects.find((candidate) => candidate.id === parsed.projectId);
      const rejection = project !== undefined ? rejectManualRun(project) : null;
      if (rejection !== null) {
        return {
          exitCode: 1,
          stderr: rejection,
        };
      }
      const startedAt = Date.now();
      const summary = runLoopProject({
        config,
        projectId: parsed.projectId,
        runCommand: runShellCommand,
      });
      const endedAt = Date.now();
      const report = writeLoopRunReport(summary, { startedAt, endedAt });
      new LoopBacklogStore().addSuggestions(summary, endedAt, report.runId);
      return {
        exitCode: summary.status === "passed" ? 0 : 1,
        stdout: parsed.json ? JSON.stringify(summary) : renderLoopRunText(summary),
      };
    }
    if (command === "reports") {
      const action = args[1];
      const option = args[2];
      if (action !== "list") {
        return { exitCode: 1, stderr: "Usage: loop reports list [--json]" };
      }
      if (option !== undefined && option !== "--json") {
        return { exitCode: 1, stderr: `unknown loop reports list option "${option}"` };
      }
      const reports = listLoopReports();
      return {
        exitCode: 0,
        stdout:
          option === "--json"
            ? JSON.stringify(reports)
            : [
                `loop reports: ${reports.length}`,
                ...reports.map(
                  (r) =>
                    `- ${r.projectId}: ${r.status} ${r.runId}${
                      r.evalOutcome === undefined ? "" : ` eval=${r.evalOutcome.status}`
                    }`,
                ),
              ].join("\n"),
      };
    }
    if (command === "targets") {
      const action = args[1];
      if (action === "list") {
        const parsed = parseTargetListArgs(args);
        if (typeof parsed === "string") return { exitCode: 1, stderr: parsed };
        const config = parseLoopConfigYaml(readFileSync(parsed.file, "utf8"));
        const targets = targetSummaries(config);
        return {
          exitCode: 0,
          stdout: parsed.json ? JSON.stringify(targets) : renderLoopTargetsText(targets),
        };
      }
      if (action === "enable" || action === "disable") {
        const parsed = parseTargetToggleArgs(args, action === "enable");
        if (typeof parsed === "string") return { exitCode: 1, stderr: parsed };
        const text = readFileSync(parsed.file, "utf8");
        const updated = setLoopTargetEnabled(text, parsed);
        if (updated.changed) writeFileSync(parsed.file, updated.text);
        const config = parseLoopConfigYaml(updated.text);
        const target = targetSummaries(config).find(
          (candidate) => candidate.kind === parsed.kind && candidate.id === parsed.id,
        );
        const result = {
          kind: parsed.kind,
          id: parsed.id,
          enabled: parsed.enabled,
          changed: updated.changed,
          scheduled: target?.scheduled ?? false,
          scheduledJobs: target?.scheduledJobs ?? [],
        };
        return {
          exitCode: 0,
          stdout: parsed.json
            ? JSON.stringify(result)
            : `loop target ${action}: ${parsed.kind}:${parsed.id} ${updated.changed ? "updated" : "unchanged"}`,
        };
      }
      return {
        exitCode: 1,
        stderr:
          "Usage: loop targets list <file> [--json] | loop targets <enable|disable> <file> <project|workspace|repo> <id> [--json]",
      };
    }
    if (command === "backlog") {
      const action = args[1];
      const store = new LoopBacklogStore();
      if (action === "list") {
        const options = new Set(args.slice(2));
        for (const option of options) {
          if (option !== "--json" && option !== "--all") {
            return { exitCode: 1, stderr: `unknown loop backlog list option "${option}"` };
          }
        }
        const items = store.list({ all: options.has("--all") });
        return {
          exitCode: 0,
          stdout: options.has("--json")
            ? JSON.stringify(items)
            : [
                `loop backlog: ${items.length}`,
                ...items.map((item) => `- ${item.id}: ${item.text}`),
              ].join("\n"),
        };
      }
      if (action === "close") {
        const id = args[2];
        const json = args[3] === "--json";
        if (id === undefined)
          return { exitCode: 1, stderr: "Usage: loop backlog close <id> [--json]" };
        if (args[3] !== undefined && args[3] !== "--json") {
          return { exitCode: 1, stderr: `unknown loop backlog close option "${args[3]}"` };
        }
        const closed = store.close(id, Date.now());
        return {
          exitCode: closed ? 0 : 1,
          stdout: json
            ? JSON.stringify({ id, closed })
            : `loop backlog close: ${closed ? "closed" : "not found"} ${id}`,
        };
      }
      return {
        exitCode: 1,
        stderr: "Usage: loop backlog list [--all] [--json] | loop backlog close <id> [--json]",
      };
    }
    if (command === "skills") {
      const action = args[1];
      if (action === "list") {
        const option = args[2];
        if (option !== undefined && option !== "--json") {
          return { exitCode: 1, stderr: `unknown loop skills list option "${option}"` };
        }
        const skills = listAgentSkills();
        return {
          exitCode: 0,
          stdout: option === "--json" ? JSON.stringify(skills) : renderLoopSkillsListText(skills),
        };
      }
      if (action === "sync") {
        const parsed = parseSkillSyncArgs(args);
        if (typeof parsed === "string") return { exitCode: 1, stderr: parsed };
        const config = parseLoopConfigYaml(readFileSync(parsed.file, "utf8"));
        const summary = applyAgentSkillRegistryActions({
          approved: config.skills.approved,
          store: new AgentSkillRegistryStore(),
          now: Date.now(),
          runCommand: runShellCommand,
          ...(config.skills.applyCommand !== undefined
            ? { applyCommand: config.skills.applyCommand }
            : {}),
        });
        return {
          exitCode: 0,
          stdout: parsed.json ? JSON.stringify(summary) : renderLoopSkillSyncText(summary),
        };
      }
      if (action === "refresh") {
        const parsed = parseSkillRefreshArgs(args);
        if (typeof parsed === "string") return { exitCode: 1, stderr: parsed };
        const text = readFileSync(parsed.file, "utf8");
        const config = parseLoopConfigYaml(text);
        const summary = refreshAgentSkillCatalog({
          catalog: config.skills.catalog,
          approved: config.skills.approved,
          resolveLatest: resolveLatestGitSkill,
        });
        if (parsed.write) {
          writeFileSync(parsed.file, loopConfigTextWithApprovedSkills(text, summary.approved));
        }
        return {
          exitCode: 0,
          stdout: parsed.json ? JSON.stringify(summary) : renderLoopSkillRefreshText(summary),
        };
      }
      return {
        exitCode: 1,
        stderr:
          "Usage: loop skills list [--json] | loop skills sync <file> [--json] | loop skills refresh <file> [--write] [--json]",
      };
    }
    return {
      exitCode: 1,
      stderr:
        "Usage: loop validate <file> [--json] | loop tick <file> [--now <time>] [--json] | loop run <file> <projectId> [--json] | loop reports list [--json] | loop targets list <file> [--json] | loop targets <enable|disable> <file> <project|workspace|repo> <id> [--json] | loop backlog list [--all] [--json] | loop backlog close <id> [--json] | loop skills list [--json] | loop skills sync <file> [--json] | loop skills refresh <file> [--write] [--json]",
    };
  } catch (err) {
    return {
      exitCode: 1,
      stderr: err instanceof Error ? err.message : String(err),
    };
  }
}
