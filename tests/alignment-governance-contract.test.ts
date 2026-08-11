import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  LOOP_TASK_FAMILY_GOVERNANCE,
  LOOP_WORK_ORDER_TASK_KINDS,
} from "../src/core/loop/task-family.js";
import { HOME_MCP_TOOLS, OBSERVER_MCP_TOOLS } from "../src/core/mcp/profiles.js";
import { NOTIFICATION_SOURCE_CATALOG } from "../src/core/notifications/gateway.js";

const root = path.resolve(__dirname, "..");
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), "utf8");
const walkFiles = (rel: string): string[] => {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(rel, entry.name);
    if (entry.isDirectory()) return walkFiles(child);
    return entry.isFile() ? [child] : [];
  });
};

const alignmentDocs = [
  "docs/automation-alignment.md",
  "docs/automation-capability-matrix.md",
  "docs/intelligent-automation.md",
  "docs/prompt-governance.md",
] as const;

const alignmentDocText = alignmentDocs.map(read).join("\n");

describe("alignment governance contract", () => {
  it("documents every WorkOrder task family in the automation alignment layer", () => {
    for (const kind of LOOP_WORK_ORDER_TASK_KINDS) {
      expect(alignmentDocText, `missing ${kind} in alignment docs`).toContain(kind);
    }
  });

  it("keeps code-changing WorkOrder families bounded by explicit governance metadata", () => {
    for (const kind of LOOP_WORK_ORDER_TASK_KINDS) {
      const policy = LOOP_TASK_FAMILY_GOVERNANCE[kind];
      expect(policy.stopRule.trim(), `${kind} must have a concrete stop rule`).not.toBe("");
      expect(policy.defaultWorktreeIsolation, `${kind} must declare isolation`).toMatch(
        /^(source-allowed-read-only|isolated|policy-controlled)$/,
      );

      if (policy.actionScope !== "read-only") {
        expect(policy.promptId, `${kind} must be tied to a governed prompt`).toMatch(/\S/);
      }

      if (policy.requiresAiEval) {
        expect(policy.requiresPlanning, `${kind} AI eval must be preceded by planning`).toBe(true);
      }

      if (policy.actionScope === "pr-creation") {
        expect(
          policy.stopRule,
          `${kind} PR-creation policy must explicitly forbid auto-merge`,
        ).toMatch(/never auto-merge|must not auto-merge/i);
      }
    }
  });

  it("documents every bot-owned notification source in capability or automation docs", () => {
    for (const source of NOTIFICATION_SOURCE_CATALOG) {
      expect(alignmentDocText, `missing notification source ${source}`).toContain(source);
    }
  });

  it("locks the Resource Guardian alignment and startup ordering", () => {
    const alignment = read("docs/automation-alignment.md");
    const automation = read("docs/intelligent-automation.md");
    const index = read("src/index.ts");
    const notificationBlock = index.slice(index.indexOf("const startNotificationDrivenServices"));

    for (const anchor of [
      "| Resource Guardian |",
      "observer/protector",
      "admission before reservation",
      "active delegated task admission",
      "Task 6 active",
      "Task 7 ownership proof",
      "Task 8 may reduce only revalidated bot-owned emergency load",
      "Task 9 dispatches at most one Resource Guardian repair",
      "global Repair Coordinator",
      "tcb resource status|incidents|mode|profile",
      "existing sysload",
      "Loop Engineering gates each due target",
      "Batch Scheduler gates each",
      "default disabled",
      "after notification",
    ]) {
      expect(alignment, `missing Resource Guardian alignment anchor: ${anchor}`).toContain(anchor);
    }
    expect(automation).toContain("Resource Guardian");
    expect(automation).toMatch(/Resource Guardian[\s\S]*host resource pressure/i);
    expect(automation).toMatch(/Runtime Guardian[\s\S]*durable runtime artifact/i);
    expect(automation).toMatch(/Resource Guardian[\s\S]*WorkOrder/i);

    const resourceStart = notificationBlock.indexOf("startResourceGuardian(deps)");
    const runtimeStart = notificationBlock.indexOf("startRuntimeGuardian(deps)");
    const auditStart = notificationBlock.indexOf("startDailyTaskAudit(deps)");
    expect(resourceStart).toBeGreaterThanOrEqual(0);
    expect(resourceStart).toBeLessThan(runtimeStart);
    expect(resourceStart).toBeLessThan(auditStart);
    expect(index.indexOf("startResourceGuardian(deps)")).toBeGreaterThan(
      index.indexOf("const startNotificationDrivenServices"),
    );
  });

  it("keeps Resource Guardian in both end-to-end architecture views", () => {
    const architecture = read("docs/intelligent-automation-architecture.md");
    const ascii = read("docs/intelligent-automation-ascii-architecture.md");

    expect(architecture).toContain("| Resource Guardian |");
    expect(architecture).toMatch(/Resource Guardian[\s\S]*host resource pressure/i);
    expect(architecture).toContain("admission before durable reservation");
    expect(architecture).toMatch(/Resource Guardian[\s\S]*Runtime Guardian/);
    expect(ascii).toContain("RESOURCE GUARDIAN");
    expect(ascii).toContain("background admission open");
    expect(ascii).toContain("background admission closed");
    expect(ascii).toContain("tcb resource status / incidents / mode / profile");
    expect(architecture).not.toContain("default target is\nArchitecture before allocating");
  });

  it("keeps important architecture modules present in the alignment contract", () => {
    const requiredModules = [
      "Operator surfaces",
      "Control and routing",
      "Session runtime",
      "Project, session, and group model",
      "Intent modules",
      "WorkOrder and system gate",
      "Prompt governance",
      "Capability dependency registry",
      "Input enhancement",
      "Evidence and observability",
      "Authorization and security policy",
      "State and configuration",
      "Deployment and lifecycle",
      "Localization and copy governance",
      "Quality and release gates",
    ];

    const alignment = read("docs/automation-alignment.md");
    for (const module of requiredModules) {
      expect(alignment, `missing module alignment row: ${module}`).toContain(`| ${module} |`);
    }
  });

  it("keeps scheduled automation governance visible in every architecture view", () => {
    for (const file of [
      "docs/intelligent-automation-architecture.md",
      "docs/intelligent-automation-ascii-architecture.md",
      "docs/agent-maintenance-guidelines.md",
    ]) {
      expect(read(file), `${file} must include automationGovernanceReview`).toContain(
        "automationGovernanceReview",
      );
    }
    const readme = read("README.md");
    expect(readme).toContain("automationGovernanceReview");
    expect(readme).toContain("| Resource Guardian |");
  });

  it("keeps the ASCII architecture on the canonical configurable state directory", () => {
    const ascii = read("docs/intelligent-automation-ascii-architecture.md");

    expect(ascii).toContain("<state-dir>");
    expect(ascii).toContain("not the install root");
    expect(ascii).not.toContain(" ~/.tmux-claude-bot/\n");
  });

  it("keeps development commands on the canonical state-directory environment file", () => {
    const devCommand = read(".claude/commands/dev.md");

    expect(devCommand).toContain("<state-dir>/.env");
    expect(devCommand).not.toContain("~/.tmux-claude-bot/.env");
  });

  it("keeps implemented MCP names and canonical role packages aligned", () => {
    const governance = read("docs/ai-tool-surface-governance.md");
    const matrix = read("docs/automation-capability-matrix.md");
    const alignment = read("docs/automation-alignment.md");

    for (const tool of [...OBSERVER_MCP_TOOLS, ...HOME_MCP_TOOLS]) {
      expect(governance, `missing implemented MCP tool ${tool}`).toContain(tool);
      expect(matrix, `missing implemented MCP tool ${tool}`).toContain(tool);
    }
    expect(governance).not.toMatch(/`tcb-(?:supervisor|worker)`/);
    expect(governance).not.toContain("Runtime Guardian config/check commands when added");
    expect(alignment).toContain("advertise its canonical server identity");
  });

  it("keeps voice and prompt translation visible in architecture and capability docs", () => {
    const architecture = [
      read("docs/intelligent-automation-architecture.md"),
      read("docs/intelligent-automation-ascii-architecture.md"),
      read("docs/automation-alignment.md"),
      read("docs/automation-capability-matrix.md"),
    ].join("\n");

    for (const anchor of [
      "Input enhancement",
      "Voice transcription",
      "Prompt translation",
      "voice_install",
      "voice_lang",
      "prompt_translate",
      "translate_install",
    ]) {
      expect(architecture, `missing input-enhancement architecture anchor: ${anchor}`).toContain(
        anchor,
      );
    }
  });

  it("documents the TUI controls that are already reachable in production", () => {
    const matrix = read("docs/automation-capability-matrix.md");
    const promptTranslation = matrix
      .split("\n")
      .find((line) => line.startsWith("| Prompt translation |"));
    const resourceGuardian = matrix
      .split("\n")
      .find((line) => line.startsWith("| Resource Guardian |"));
    const tui = read("docs/tui.md");

    expect(promptTranslation).toBeDefined();
    expect(promptTranslation?.split(/(?<!\\)\|/)[5]).toContain("`T`");
    expect(promptTranslation?.split(/(?<!\\)\|/)[2]).toContain("tcb prompt-translate");
    expect(resourceGuardian).toBeDefined();
    expect(resourceGuardian?.split(/(?<!\\)\|/)[5]).toContain("Resource Guardian");
    expect(tui).toContain("| `Enter` | refresh the peek |");
    expect(tui).toContain("| `?` | show the full keymap |");
    expect(tui).toMatch(/\| `m` \|[^\n]*Resource Guardian/);
    expect(read("src/tui/app.tsx")).toContain("machine load + Resource Guardian (sysload)");
  });

  it("keeps the Home Operator skill aligned with Resource Guardian inspection", () => {
    const skill = read("skills/tcb-home-operator/SKILL.md");

    expect(skill).toContain("tcb resource status");
    expect(skill).toContain("tcb resource incidents --limit 20");
  });

  it("keeps missing-worktree registration recovery in business and maintenance truth", () => {
    const automation = read("docs/intelligent-automation.md");
    const maintenance = read("docs/agent-maintenance-guidelines.md");

    for (const doc of [automation, maintenance]) {
      expect(doc).toContain("missing worktree directory");
      expect(doc).toMatch(/exact stale Git\s+worktree registration/);
      expect(doc).toMatch(/verified\s+source repository/);
    }
  });

  it("keeps live operator configuration out of source and maintained docs", () => {
    const checkedFiles = [
      ...walkFiles("src").filter((file) => file.endsWith(".ts")),
      ...walkFiles("tests").filter((file) => file.endsWith(".ts")),
      ...walkFiles("docs").filter((file) => file.endsWith(".md")),
      "README.md",
      ".env.example",
    ];
    const forbidden = [/\/Users\/kingsonwu\b/, /\bgithubAccount:\s*(Kingson4Wu|miao2016)\b/];

    for (const file of checkedFiles) {
      const content = read(file);
      for (const pattern of forbidden) {
        expect(content, `${file} must not contain live operator config ${pattern}`).not.toMatch(
          pattern,
        );
      }
    }
  });
});
