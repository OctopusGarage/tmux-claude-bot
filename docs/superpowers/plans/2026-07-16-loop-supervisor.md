# Loop Supervisor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in `agent-supervised` Loop Engineering runner that dispatches bounded work orders to a dedicated Loop Supervisor agent session for adaptive scheduled-task recovery.

**Architecture:** Keep the existing deterministic Loop runner as the default. Add pure config/work-order/report modules first, then a dedicated supervisor session modeled after the home operator, then wire the async Loop service to select the supervised runner for projects that explicitly opt in. AI reasoning continues to flow only through managed Claude Code / Codex sessions and the existing queue.

**Tech Stack:** TypeScript, Zod, Vitest, existing tmux bridge, existing queue/control surfaces, existing Loop Engineering stores and report conventions.

---

## File Structure

- Modify `src/core/loop/config.ts`: add strict `runner` schema with default `{ kind: "system" }`, expose runner fields in validation summaries.
- Create `src/core/loop/work-order.ts`: pure WorkOrder type, final marker builder, prompt builder, and summary parser.
- Create `src/core/loop/supervisor-session.ts`: reserved loop-supervisor identity, provisioning, and boot/start helper.
- Create `src/core/loop/supervised-runner.ts`: dispatch a WorkOrder to the supervisor queue and wait for final marker/timeout.
- Create `src/core/loop/supervisor-report.ts`: write supervisor Markdown/JSON reports under the existing loop report state tree.
- Modify `src/core/loop/service.ts`: select system vs agent-supervised runner in `runLoopServiceTickAsync`.
- Modify `src/core/projects/operator.ts`: add a generic reserved-session predicate or explicit supervisor exclusion helper.
- Modify project picker/recovery call sites only where needed to exclude the new reserved session.
- Modify `src/index.ts`: start the Loop Supervisor at boot when config says it is enabled or when Loop config contains supervised projects.
- Add tests under `tests/loop/` and focused project-session exclusion tests under `tests/core/`.
- Update docs after core behavior lands: `docs/future/loop-supervisor-design.md`, `docs/manual.md`, and a Loop config example.

## Task 1: Runner Config Schema

**Files:**
- Modify: `src/core/loop/config.ts`
- Test: `tests/loop/config.test.ts`

- [ ] **Step 1: Write failing tests for runner defaults and supervised options**

Add these tests to `tests/loop/config.test.ts`:

```ts
it("defaults loop project runner to system", () => {
  const config = parseLoopConfigYaml(validConfig);

  expect(config.projects[0]?.runner).toEqual({ kind: "system" });
});

it("parses agent-supervised runner options", () => {
  const config = parseLoopConfigYaml(
    validConfig.replace(
      "allowedActions:",
      [
        "runner:",
        "      kind: agent-supervised",
        "      timeoutMs: 7200000",
        "      maxTurns: 20",
        "      requireConfirmation: true",
        "    allowedActions:",
      ].join("\n"),
    ),
  );

  expect(config.projects[0]?.runner).toEqual({
    kind: "agent-supervised",
    timeoutMs: 7200000,
    maxTurns: 20,
    requireConfirmation: true,
  });
});

it("rejects unknown runner keys", () => {
  expect(() =>
    parseLoopConfigYaml(
      validConfig.replace(
        "allowedActions:",
        ["runner:", "      kind: system", "      surprise: true", "    allowedActions:"].join(
          "\n",
        ),
      ),
    ),
  ).toThrow(/projects\.0\.runner: Unrecognized key/i);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npx vitest run tests/loop/config.test.ts
```

Expected: failures because `runner` is not parsed yet.

- [ ] **Step 3: Add the schema**

In `src/core/loop/config.ts`, add:

```ts
const runnerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("system") }).strict(),
  z
    .object({
      kind: z.literal("agent-supervised"),
      timeoutMs: z.number().int().positive().optional(),
      maxTurns: z.number().int().positive().optional(),
      requireConfirmation: z.boolean().default(false),
    })
    .strict(),
]);
```

Then add to `projectSchema`:

```ts
runner: runnerSchema.default({ kind: "system" }),
```

If `LoopProjectValidationSummary` needs the mode for `tcb loop validate --json`, add:

```ts
runner: { kind: "system" | "agent-supervised" };
```

and include:

```ts
runner: { kind: project.runner.kind },
```

- [ ] **Step 4: Run tests**

Run:

```bash
npx vitest run tests/loop/config.test.ts
npm run lint:types:tests
```

Expected: both pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/loop/config.ts tests/loop/config.test.ts
git commit -m "feat(loop): add supervised runner config"
```

## Task 2: WorkOrder Builder and Final Summary Parser

**Files:**
- Create: `src/core/loop/work-order.ts`
- Test: `tests/loop/work-order.test.ts`

- [ ] **Step 1: Write failing WorkOrder tests**

Create `tests/loop/work-order.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseLoopConfigYaml } from "../../src/core/loop/config.js";
import {
  buildLoopSupervisorPrompt,
  buildLoopWorkOrder,
  finalMarkerForWorkOrder,
  parseSupervisorFinalSummary,
} from "../../src/core/loop/work-order.js";

const config = parseLoopConfigYaml(`
skills:
  approved:
    - id: improve-codebase-architecture
      sourceUrl: https://github.com/mattpocock/skills
      sourcePath: skills/engineering/improve-codebase-architecture
      ref: 082131022ca026f353ab74d9a6e1dcc11adbd954
      checksum: sha256:abc
      platforms: [codex]
      tags: [architecture]
      trustLevel: approved
      risk: medium
      updatePolicy: notify
projects:
  - id: datavibe
    name: Datavibe
    path: /repo/datavibe
    agent: codex
    schedule: "30 5 * * *"
    runner:
      kind: agent-supervised
      timeoutMs: 7200000
      maxTurns: 20
    goal: Improve architecture.
    maxRounds: 3
    targetScore: 90
    assessment:
      command: npm run assess
    execution:
      agent: true
    allowedActions: [tests, docs, small-refactor]
    blockedActions: [direct-model-api, dependency-upgrade, broad-rewrite]
`);

describe("loop supervisor work order", () => {
  it("builds a bounded work order from project config", () => {
    const project = config.projects[0]!;
    const workOrder = buildLoopWorkOrder({
      config,
      project,
      scheduledAt: Date.parse("2026-07-16T05:30:00Z"),
      runId: "1752643800000-datavibe",
    });

    expect(workOrder).toMatchObject({
      id: "1752643800000-datavibe",
      projectId: "datavibe",
      projectPath: "/repo/datavibe",
      agent: "codex",
      maxRounds: 3,
      targetScore: 90,
      requiredFinalMarker: "[LOOP_SUPERVISOR_DONE:1752643800000-datavibe]",
    });
    expect(workOrder.skills.approved[0]?.id).toBe("improve-codebase-architecture");
  });

  it("renders a prompt with policy, commands, and the final marker", () => {
    const workOrder = buildLoopWorkOrder({
      config,
      project: config.projects[0]!,
      scheduledAt: 1752643800000,
      runId: "1752643800000-datavibe",
    });

    const prompt = buildLoopSupervisorPrompt(workOrder);

    expect(prompt).toContain("You are the Loop Supervisor for tmux-claude-bot.");
    expect(prompt).toContain("Do not call model-provider APIs.");
    expect(prompt).toContain("tcb send <project>");
    expect(prompt).toContain(finalMarkerForWorkOrder("1752643800000-datavibe"));
  });

  it("parses the final marker and JSON summary", () => {
    const result = parseSupervisorFinalSummary(
      [
        "done",
        "[LOOP_SUPERVISOR_DONE:wo-1]",
        '{"status":"completed","projectId":"datavibe","actionsTaken":["verified"],"delegatedTasks":[],"finalVerification":"passed","commits":[],"followUps":[]}',
      ].join("\\n"),
      "wo-1",
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary.status).toBe("completed");
      expect(result.summary.finalVerification).toBe("passed");
    }
  });

  it("rejects output without the expected final marker", () => {
    expect(parseSupervisorFinalSummary("{}", "wo-1")).toEqual({
      ok: false,
      reason: "missing-final-marker",
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npx vitest run tests/loop/work-order.test.ts
```

Expected: module-not-found failure.

- [ ] **Step 3: Implement WorkOrder module**

Create `src/core/loop/work-order.ts`:

```ts
import type { ApprovedSkill } from "../skills/schema.js";
import type { LoopConfig, LoopProjectConfig } from "./config.js";

export type SupervisorFinalStatus = "completed" | "failed" | "blocked" | "timeout" | "cancelled";

export type LoopSupervisorFinalSummary = {
  status: SupervisorFinalStatus;
  projectId: string;
  actionsTaken: string[];
  delegatedTasks: Array<{ projectId: string; status: SupervisorFinalStatus }>;
  finalVerification: "passed" | "failed" | "not-run" | "unknown";
  commits: string[];
  followUps: string[];
};

export type LoopWorkOrder = {
  id: string;
  scheduledAt: number;
  projectId: string;
  projectName: string;
  projectPath: string;
  agent: LoopProjectConfig["agent"];
  goal: string;
  maxRounds: number;
  targetScore: number;
  allowedActions: string[];
  blockedActions: string[];
  skills: { approved: ApprovedSkill[] };
  preflight: LoopProjectConfig["preflight"];
  assessment: LoopProjectConfig["assessment"];
  eval?: LoopProjectConfig["eval"];
  execution: LoopProjectConfig["execution"];
  recovery: LoopProjectConfig["recovery"];
  commitPolicy: LoopProjectConfig["commit"];
  requiredFinalMarker: string;
};

export function finalMarkerForWorkOrder(workOrderId: string): string {
  return `[LOOP_SUPERVISOR_DONE:${workOrderId}]`;
}

export function buildLoopWorkOrder(input: {
  config: LoopConfig;
  project: LoopProjectConfig;
  scheduledAt: number;
  runId: string;
}): LoopWorkOrder {
  return {
    id: input.runId,
    scheduledAt: input.scheduledAt,
    projectId: input.project.id,
    projectName: input.project.name,
    projectPath: input.project.path,
    agent: input.project.agent,
    goal: input.project.goal,
    maxRounds: input.project.maxRounds,
    targetScore: input.project.targetScore,
    allowedActions: input.project.allowedActions,
    blockedActions: input.project.blockedActions,
    skills: { approved: input.config.skills.approved },
    preflight: input.project.preflight,
    assessment: input.project.assessment,
    ...(input.project.eval !== undefined ? { eval: input.project.eval } : {}),
    execution: input.project.execution,
    recovery: input.project.recovery,
    commitPolicy: input.project.commit,
    requiredFinalMarker: finalMarkerForWorkOrder(input.runId),
  };
}

export function buildLoopSupervisorPrompt(workOrder: LoopWorkOrder): string {
  return [
    "You are the Loop Supervisor for tmux-claude-bot.",
    "",
    "WorkOrder:",
    JSON.stringify(workOrder, null, 2),
    "",
    "Available operating surface:",
    "- tcb dashboard --json",
    "- tcb open <project>",
    "- tcb peek <project>",
    '- tcb send <project> "<task>"',
    "- tcb loop run <config> <projectId>",
    "- tcb notify ...",
    "",
    "Rules:",
    "- Do not call model-provider APIs.",
    "- Do not send work to the supervisor session itself.",
    "- Diagnose failures before giving up.",
    "- Keep project changes small, verified, and inside allowed actions.",
    "- Do not perform destructive actions unless the work order explicitly allows it.",
    `- Finish with the exact final marker ${workOrder.requiredFinalMarker} and a JSON summary.`,
  ].join("\n");
}

function parseJsonObject(text: string): unknown | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function parseSupervisorFinalSummary(
  output: string,
  workOrderId: string,
):
  | { ok: true; summary: LoopSupervisorFinalSummary }
  | { ok: false; reason: "missing-final-marker" | "invalid-summary" } {
  if (!output.includes(finalMarkerForWorkOrder(workOrderId))) {
    return { ok: false, reason: "missing-final-marker" };
  }
  const parsed = parseJsonObject(output);
  if (parsed === null || typeof parsed !== "object") return { ok: false, reason: "invalid-summary" };
  const summary = parsed as Partial<LoopSupervisorFinalSummary>;
  if (
    typeof summary.status !== "string" ||
    typeof summary.projectId !== "string" ||
    !Array.isArray(summary.actionsTaken) ||
    !Array.isArray(summary.delegatedTasks) ||
    typeof summary.finalVerification !== "string" ||
    !Array.isArray(summary.commits) ||
    !Array.isArray(summary.followUps)
  ) {
    return { ok: false, reason: "invalid-summary" };
  }
  return { ok: true, summary: summary as LoopSupervisorFinalSummary };
}
```

- [ ] **Step 4: Run tests**

Run:

```bash
npx vitest run tests/loop/work-order.test.ts
npm run lint:types:tests
```

Expected: both pass. If Biome asks for formatting, run `npx biome check --write src/core/loop/work-order.ts tests/loop/work-order.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/core/loop/work-order.ts tests/loop/work-order.test.ts
git commit -m "feat(loop): build supervised work orders"
```

## Task 3: Supervisor Session Identity and Provisioning

**Files:**
- Create: `src/core/loop/supervisor-session.ts`
- Modify: `src/core/projects/operator.ts`
- Test: `tests/loop/supervisor-session.test.ts`
- Test: update `tests/core/project-ops.test.ts` if the project list needs explicit supervisor exclusion.

- [ ] **Step 1: Write failing supervisor session tests**

Create `tests/loop/supervisor-session.test.ts`:

```ts
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isLoopSupervisorSession,
  loopSupervisorDir,
  loopSupervisorSessionName,
  provisionLoopSupervisorHome,
  startLoopSupervisor,
} from "../../src/core/loop/supervisor-session.js";

const originalStateDir = process.env.TCB_STATE_DIR;

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
  else process.env.TCB_STATE_DIR = originalStateDir;
});

describe("loop supervisor session", () => {
  it("uses a reserved project-family session name", () => {
    expect(loopSupervisorSessionName("tmux_proj_")).toBe("tmux_proj_loop-supervisor");
    expect(isLoopSupervisorSession("tmux_proj_loop-supervisor", "tmux_proj_")).toBe(true);
    expect(isLoopSupervisorSession("tmux_proj_home", "tmux_proj_")).toBe(false);
  });

  it("provisions supervisor instructions idempotently", () => {
    const dir = mkdtempSync(join(tmpdir(), "tcb-loop-supervisor-"));
    try {
      provisionLoopSupervisorHome(dir);
      const first = readFileSync(join(dir, "AGENTS.md"), "utf8");
      provisionLoopSupervisorHome(dir);
      const second = readFileSync(join(dir, "AGENTS.md"), "utf8");

      expect(existsSync(join(dir, "AGENTS.md"))).toBe(true);
      expect(first).toBe(second);
      expect(first).toContain("Loop Supervisor");
      expect(first).toContain("Do not call model-provider APIs");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("starts the configured supervisor session", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-loop-supervisor-state-"));
    const createSession = vi.fn(async () => {});
    const isPaneAlive = vi.fn(async () => false);
    const deps = {
      bridge: { createSession, isPaneAlive },
      config: {
        projectSessionPrefix: "tmux_proj_",
        loopEngineering: {
          supervisor: { enabled: true, dir: "", agent: "codex" as const },
        },
        startCommands: [{ agent: "codex" as const, command: "codex" }],
        claudeStartCommand: "claude",
      },
    };
    const performStart = vi.fn(async () => "started");

    await startLoopSupervisor(deps as never, performStart);

    expect(createSession).toHaveBeenCalledWith(
      "tmux_proj_loop-supervisor",
      loopSupervisorDir(deps.config as never),
    );
    expect(performStart).toHaveBeenCalledWith(
      deps,
      "tmux_proj_loop-supervisor",
      expect.stringContaining("codex"),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npx vitest run tests/loop/supervisor-session.test.ts
```

Expected: module-not-found failure.

- [ ] **Step 3: Implement supervisor session helper**

Create `src/core/loop/supervisor-session.ts`:

```ts
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appStateDir } from "../../shared/state-dir.js";
import { createLogger } from "../../shared/utils/logger.js";
import { CODEX_SKIP_PERMS, SKIP_PERMS } from "../agents/resume-command.js";
import { markSessionStopped } from "../agents/runningSessions.js";
import { performStart as defaultPerformStart } from "../command/dispatch.js";
import type { HandlerDeps } from "../deps.js";
import { setPathForSession } from "../projects/sessionPathMap.js";

const log = createLogger("loop.supervisor-session");

const LOOP_SUPERVISOR_AGENTS = `# Loop Supervisor

You are the Loop Supervisor for tmux-claude-bot.

You process scheduled Loop Engineering work orders. You manage other project
sessions through the tcb CLI. You do not call model-provider APIs directly. You
do not send work to yourself. You diagnose failures before giving up, keep
changes small, and finish every work order with the required final marker and
JSON summary.
`;

export function loopSupervisorSessionName(prefix: string): string {
  return `${prefix}loop-supervisor`;
}

export function isLoopSupervisorSession(session: string, prefix: string): boolean {
  return session === loopSupervisorSessionName(prefix);
}

export function loopSupervisorDir(config: {
  loopEngineering: { supervisor?: { dir?: string } };
}): string {
  return config.loopEngineering.supervisor?.dir || join(appStateDir(), "loop-supervisor");
}

export function provisionLoopSupervisorHome(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "AGENTS.md");
  if (!existsSync(file)) writeFileSync(file, LOOP_SUPERVISOR_AGENTS);
}

function resolveSupervisorStartCommand(config: HandlerDeps["config"]): string {
  const agent = config.loopEngineering.supervisor?.agent ?? "codex";
  const match = config.startCommands.find((command) => command.agent === agent);
  const base = match?.command ?? config.claudeStartCommand;
  const effectiveAgent = match?.agent ?? "claude";
  const skipFlag = effectiveAgent === "codex" ? CODEX_SKIP_PERMS : SKIP_PERMS;
  return base.includes(skipFlag) ? base : `${base} ${skipFlag}`;
}

export async function startLoopSupervisor(
  deps: HandlerDeps,
  performStart: typeof defaultPerformStart = defaultPerformStart,
): Promise<void> {
  const supervisor = deps.config.loopEngineering.supervisor;
  if (!supervisor?.enabled) return;
  const name = loopSupervisorSessionName(deps.config.projectSessionPrefix);
  const dir = loopSupervisorDir(deps.config);
  try {
    provisionLoopSupervisorHome(dir);
    if (!(await deps.bridge.isPaneAlive(name))) await deps.bridge.createSession(name, dir);
    setPathForSession(name, dir);
    const start = await performStart(deps, name, resolveSupervisorStartCommand(deps.config));
    markSessionStopped(name);
    log.info("loop supervisor session ensured", { data: { session: name, dir, start } });
  } catch (err) {
    log.error("failed to start loop supervisor session", { err });
  }
}
```

- [ ] **Step 4: Add supervisor config to app config types**

Update `src/shared/types.ts` and `src/shared/config.ts` only after checking their current shapes. Add a nested `loopEngineering.supervisor` object with `enabled`, `dir`, and `agent`. Environment variables can be:

```text
LOOP_SUPERVISOR_ENABLED=false
LOOP_SUPERVISOR_AGENT=codex
LOOP_SUPERVISOR_DIR=
```

The parsed config should default to disabled.

- [ ] **Step 5: Run tests**

Run:

```bash
npx vitest run tests/loop/supervisor-session.test.ts
npm run lint:types:tests
```

Expected: both pass.

- [ ] **Step 6: Commit**

```bash
git add src/core/loop/supervisor-session.ts src/shared/config.ts src/shared/types.ts tests/loop/supervisor-session.test.ts
git commit -m "feat(loop): add supervisor session"
```

## Task 4: Supervised Runner Dispatch and Timeout

**Files:**
- Create: `src/core/loop/supervised-runner.ts`
- Test: `tests/loop/supervised-runner.test.ts`

- [ ] **Step 1: Write failing dispatch tests**

Create `tests/loop/supervised-runner.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { LoopWorkOrder } from "../../src/core/loop/work-order.js";
import { runLoopSupervisedProjectAsync } from "../../src/core/loop/supervised-runner.js";

const workOrder: LoopWorkOrder = {
  id: "wo-1",
  scheduledAt: 1,
  projectId: "datavibe",
  projectName: "Datavibe",
  projectPath: "/repo/datavibe",
  agent: "codex",
  goal: "Improve architecture.",
  maxRounds: 3,
  targetScore: 90,
  allowedActions: ["tests"],
  blockedActions: ["direct-model-api"],
  skills: { approved: [] },
  preflight: { commands: [], repair: { agent: false } },
  assessment: { command: "npm run assess" },
  execution: { agent: true },
  recovery: { agent: false, dirtyWorktree: false, maxAttempts: 1 },
  commitPolicy: { enabled: false, perRound: true },
  requiredFinalMarker: "[LOOP_SUPERVISOR_DONE:wo-1]",
};

describe("runLoopSupervisedProjectAsync", () => {
  it("dispatches the work order and parses completed output", async () => {
    const result = await runLoopSupervisedProjectAsync({
      workOrder,
      supervisorSession: "tmux_proj_loop-supervisor",
      timeoutMs: 1000,
      dispatch: async (req) => {
        expect(req.session).toBe("tmux_proj_loop-supervisor");
        expect(req.prompt).toContain("[LOOP_SUPERVISOR_DONE:wo-1]");
        return {
          status: 0,
          stdout:
            '[LOOP_SUPERVISOR_DONE:wo-1]\\n{"status":"completed","projectId":"datavibe","actionsTaken":[],"delegatedTasks":[],"finalVerification":"passed","commits":[],"followUps":[]}',
          stderr: "",
        };
      },
    });

    expect(result.status).toBe("completed");
    expect(result.summary?.finalVerification).toBe("passed");
  });

  it("returns failed when dispatch cannot enqueue", async () => {
    const result = await runLoopSupervisedProjectAsync({
      workOrder,
      supervisorSession: "tmux_proj_loop-supervisor",
      timeoutMs: 1000,
      dispatch: async () => ({ status: 1, stdout: "", stderr: "queue full" }),
    });

    expect(result).toMatchObject({ status: "failed", reason: "queue full" });
  });

  it("returns timeout when dispatch does not finish before deadline", async () => {
    const result = await runLoopSupervisedProjectAsync({
      workOrder,
      supervisorSession: "tmux_proj_loop-supervisor",
      timeoutMs: 1,
      dispatch: () => new Promise(() => {}),
    });

    expect(result.status).toBe("timeout");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npx vitest run tests/loop/supervised-runner.test.ts
```

Expected: module-not-found failure.

- [ ] **Step 3: Implement supervised runner**

Create `src/core/loop/supervised-runner.ts`:

```ts
import { buildLoopSupervisorPrompt, parseSupervisorFinalSummary, type LoopSupervisorFinalSummary, type LoopWorkOrder } from "./work-order.js";

export type SupervisorDispatchResult = { status: number; stdout: string; stderr: string };

export type LoopSupervisedRunResult = {
  status: "completed" | "failed" | "blocked" | "timeout" | "cancelled";
  reason?: string;
  summary?: LoopSupervisorFinalSummary;
  output: string;
};

export async function runLoopSupervisedProjectAsync(input: {
  workOrder: LoopWorkOrder;
  supervisorSession: string;
  timeoutMs: number;
  dispatch: (request: { session: string; prompt: string }) => Promise<SupervisorDispatchResult>;
}): Promise<LoopSupervisedRunResult> {
  const prompt = buildLoopSupervisorPrompt(input.workOrder);
  const timeout = new Promise<SupervisorDispatchResult>((resolve) => {
    const timer = setTimeout(
      () => resolve({ status: 124, stdout: "", stderr: "loop supervisor work order timed out" }),
      input.timeoutMs,
    );
    timer.unref?.();
  });
  const result = await Promise.race([
    input.dispatch({ session: input.supervisorSession, prompt }),
    timeout,
  ]);
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  if (result.status === 124) return { status: "timeout", reason: result.stderr, output };
  if (result.status !== 0) return { status: "failed", reason: result.stderr || "dispatch failed", output };
  const parsed = parseSupervisorFinalSummary(result.stdout, input.workOrder.id);
  if (!parsed.ok) return { status: "failed", reason: parsed.reason, output };
  return { status: parsed.summary.status, summary: parsed.summary, output };
}
```

- [ ] **Step 4: Run tests**

Run:

```bash
npx vitest run tests/loop/supervised-runner.test.ts tests/loop/work-order.test.ts
npm run lint:types:tests
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/loop/supervised-runner.ts tests/loop/supervised-runner.test.ts
git commit -m "feat(loop): dispatch supervised work orders"
```

## Task 5: Supervisor Reports

**Files:**
- Create: `src/core/loop/supervisor-report.ts`
- Test: `tests/loop/supervisor-report.test.ts`

- [ ] **Step 1: Write failing report tests**

Create `tests/loop/supervisor-report.test.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LoopWorkOrder } from "../../src/core/loop/work-order.js";
import { writeLoopSupervisorReport } from "../../src/core/loop/supervisor-report.js";

const originalStateDir = process.env.TCB_STATE_DIR;

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
  else process.env.TCB_STATE_DIR = originalStateDir;
});

const workOrder = {
  id: "wo-1",
  projectId: "datavibe",
  projectName: "Datavibe",
  projectPath: "/repo/datavibe",
  agent: "codex",
  goal: "Improve architecture.",
  scheduledAt: 1,
  maxRounds: 3,
  targetScore: 90,
  allowedActions: ["tests"],
  blockedActions: ["direct-model-api"],
  skills: { approved: [] },
  preflight: { commands: [], repair: { agent: false } },
  assessment: { command: "npm run assess" },
  execution: { agent: true },
  recovery: { agent: false, dirtyWorktree: false, maxAttempts: 1 },
  commitPolicy: { enabled: false, perRound: true },
  requiredFinalMarker: "[LOOP_SUPERVISOR_DONE:wo-1]",
} satisfies LoopWorkOrder;

describe("writeLoopSupervisorReport", () => {
  it("writes markdown and JSON supervisor reports", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-loop-supervisor-report-"));

    const report = writeLoopSupervisorReport({
      workOrder,
      supervisorSession: "tmux_proj_loop-supervisor",
      startedAt: 1,
      endedAt: 2,
      result: {
        status: "completed",
        output: "done",
        summary: {
          status: "completed",
          projectId: "datavibe",
          actionsTaken: ["verified"],
          delegatedTasks: [],
          finalVerification: "passed",
          commits: [],
          followUps: [],
        },
      },
    });

    expect(report.runId).toBe("wo-1");
    expect(await readFile(report.markdownPath, "utf8")).toContain("Loop Supervisor Report");
    expect(JSON.parse(await readFile(report.summaryPath, "utf8"))).toMatchObject({
      workOrderId: "wo-1",
      status: "completed",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npx vitest run tests/loop/supervisor-report.test.ts
```

Expected: module-not-found failure.

- [ ] **Step 3: Implement report writer**

Create `src/core/loop/supervisor-report.ts` using the same state-dir conventions as `src/core/loop/report.ts`. Use `mkdirSync(..., { recursive: true })`, write `supervisor.md`, and write `supervisor-summary.json`.

Use this exported shape:

```ts
export function writeLoopSupervisorReport(input: {
  workOrder: LoopWorkOrder;
  supervisorSession: string;
  startedAt: number;
  endedAt: number;
  result: LoopSupervisedRunResult;
}): { runId: string; markdownPath: string; summaryPath: string }
```

Markdown must include:

```markdown
# Loop Supervisor Report

- Work Order: ...
- Project: ...
- Status: ...
- Supervisor: ...
- Started: ...
- Ended: ...

## Actions Taken
...

## Raw Output
...
```

- [ ] **Step 4: Run tests**

Run:

```bash
npx vitest run tests/loop/supervisor-report.test.ts
npm run lint:types:tests
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/loop/supervisor-report.ts tests/loop/supervisor-report.test.ts
git commit -m "feat(loop): write supervisor reports"
```

## Task 6: Loop Service Integration

**Files:**
- Modify: `src/core/loop/service.ts`
- Modify: `src/index.ts`
- Test: `tests/loop/service.test.ts`
- Test: add `tests/loop/service-supervisor.test.ts` if keeping existing service tests compact is cleaner.

- [ ] **Step 1: Write failing service integration test**

Add to `tests/loop/service.test.ts` or create `tests/loop/service-supervisor.test.ts`:

```ts
it("dispatches agent-supervised projects to the supervisor runner", async () => {
  process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-loop-service-supervisor-state-"));
  const dir = mkdtempSync(join(tmpdir(), "tcb-loop-service-supervisor-"));
  const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-project-"));
  const file = join(dir, "loop.yml");
  writeFileSync(
    file,
    `
projects:
  - id: hub
    name: Hub
    path: ${projectDir}
    agent: codex
    schedule: "*/5 * * * *"
    runner:
      kind: agent-supervised
      timeoutMs: 1000
    goal: Improve core module clarity in small verified slices.
    maxRounds: 1
    targetScore: 90
    assessment:
      command: npm run assess
    execution:
      agent: true
    allowedActions: [tests]
`,
  );
  const dispatched: string[] = [];

  const result = await runLoopServiceTickAsync({
    configFile: file,
    now: Date.parse("2026-07-16T10:10:00Z"),
    schedulerStore: new LoopSchedulerStore(),
    runCommand: () => {
      throw new Error("system runner should not run");
    },
    runSupervisorTask: async (request) => {
      dispatched.push(request.prompt);
      return {
        status: 0,
        stdout:
          '[LOOP_SUPERVISOR_DONE:1752660600000-hub]\\n{"status":"completed","projectId":"hub","actionsTaken":[],"delegatedTasks":[],"finalVerification":"passed","commits":[],"followUps":[]}',
        stderr: "",
      };
    },
    supervisorSessionName: "tmux_proj_loop-supervisor",
  });

  expect(result).toMatchObject({ checked: 1, due: 1, ran: 1, failed: 0 });
  expect(dispatched[0]).toContain("Loop Supervisor");
});
```

Adjust the exact run id assertion to match the run id currently generated in `service.ts` (`${due.scheduledAt}-${due.projectId}`).

- [ ] **Step 2: Run service tests to verify they fail**

Run:

```bash
npx vitest run tests/loop/service.test.ts
```

Expected: TypeScript/test failure because `runSupervisorTask` is not supported yet.

- [ ] **Step 3: Wire `runLoopServiceTickAsync`**

In `src/core/loop/service.ts`, import:

```ts
import { loopSupervisorSessionName } from "./supervisor-session.js";
import { runLoopSupervisedProjectAsync } from "./supervised-runner.js";
import { buildLoopWorkOrder } from "./work-order.js";
import { writeLoopSupervisorReport } from "./supervisor-report.js";
```

Extend input:

```ts
runSupervisorTask?: (request: { session: string; prompt: string }) => Promise<LoopRunCommandResult>;
supervisorSessionName?: string;
```

In the due loop, before `runLoopProjectAsync`, branch:

```ts
const project = config.projects.find((p) => p.id === due.projectId);
if (project?.runner.kind === "agent-supervised") {
  if (input.runSupervisorTask === undefined) {
    failed++;
    continue;
  }
  const runId = `${due.scheduledAt}-${due.projectId}`;
  const workOrder = buildLoopWorkOrder({ config, project, scheduledAt: due.scheduledAt, runId });
  const result = await runLoopSupervisedProjectAsync({
    workOrder,
    supervisorSession:
      input.supervisorSessionName ?? loopSupervisorSessionName("tmux_proj_"),
    timeoutMs: project.runner.timeoutMs ?? 7_200_000,
    dispatch: input.runSupervisorTask,
  });
  writeLoopSupervisorReport({
    workOrder,
    supervisorSession:
      input.supervisorSessionName ?? loopSupervisorSessionName("tmux_proj_"),
    startedAt,
    endedAt: Date.now(),
    result,
  });
  ran++;
  if (result.status !== "completed") failed++;
  continue;
}
```

Do not hardcode `"tmux_proj_"`; use `deps.config.projectSessionPrefix` when called from `startLoopEngineering`. If the pure test path lacks deps, require `supervisorSessionName` in tests or pass it into the service function.

- [ ] **Step 4: Add queue adapter for supervisor**

Create a small helper in `src/core/loop/agent-queue.ts` or a new file:

```ts
export function createLoopSupervisorTaskRunner(
  deps: QueueDeps,
  supervisorSession: string,
): (request: { session: string; prompt: string }) => Promise<LoopRunCommandResult> {
  return (request) => enqueueLoopAgentPrompt(deps, {
    cwd: getPathBySession(supervisorSession) ?? supervisorSession,
    agent: "codex",
    prompt: request.prompt,
    projectId: "loop-supervisor",
  });
}
```

If `enqueueLoopAgentPrompt` currently resolves project sessions by cwd only, do not force it. Add a direct session enqueue helper instead:

```ts
async function enqueueLoopAgentPromptToSession(
  deps: QueueDeps,
  sessionName: string,
  prompt: string,
): Promise<LoopRunCommandResult>
```

Use that direct helper for supervisor dispatch.

- [ ] **Step 5: Start supervisor at boot**

Modify `src/index.ts`:

```ts
import { startLoopSupervisor } from "./core/loop/supervisor-session.js";
```

Then after `startLoopEngineering(...)` or near `startOperator(...)`:

```ts
void startLoopSupervisor(deps);
```

It should no-op unless `LOOP_SUPERVISOR_ENABLED=true` or the parsed runtime config chooses to enable it. Keep this conservative: first implementation should require explicit env enablement.

- [ ] **Step 6: Run focused tests**

Run:

```bash
npx vitest run tests/loop/service.test.ts tests/loop/supervised-runner.test.ts tests/loop/work-order.test.ts
npm run lint:types:tests
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add src/core/loop/service.ts src/core/loop/agent-queue.ts src/index.ts tests/loop/service.test.ts
git commit -m "feat(loop): run supervised projects through supervisor"
```

## Task 7: Docs, Smoke, and Full Verification

**Files:**
- Modify: `docs/future/loop-supervisor-design.md`
- Modify: `docs/manual.md`
- Modify: `docs/examples/loop-skills-catalog.example.yml`
- Modify: `scripts/smoke.sh`
- Test: existing docs and smoke tests.

- [ ] **Step 1: Update docs**

In `docs/manual.md`, add a short note in the Loop Engineering section:

```markdown
Loop projects default to the deterministic `system` runner. Advanced projects can
opt into `runner.kind: agent-supervised`, which dispatches a bounded work order
to the dedicated Loop Supervisor session. The supervisor uses the existing `tcb`
control surface and managed project sessions; it does not call model-provider
APIs directly.
```

In `docs/future/loop-supervisor-design.md`, change status from design proposal to:

```markdown
Status: initial implementation.
```

Only do this after Tasks 1-6 pass.

- [ ] **Step 2: Add example config**

Add this to `docs/examples/loop-skills-catalog.example.yml` under the example project:

```yaml
    runner:
      kind: system
```

Add a commented supervised example:

```yaml
#    runner:
#      kind: agent-supervised
#      timeoutMs: 7200000
#      maxTurns: 20
#      requireConfirmation: false
```

- [ ] **Step 3: Extend smoke script**

In `scripts/smoke.sh`, ensure the loop config smoke includes:

```yaml
    runner:
      kind: system
```

Add a validate-only supervised config smoke that does not require a real supervisor session:

```bash
node dist/cli.js loop validate "$supervised_loop_config" --json >/dev/null
```

- [ ] **Step 4: Run full verification**

Run:

```bash
npm run lint
npm run lint:sh
npm run lint:types
npm run lint:types:tests
npm run build
npm test
npm run smoke
git diff --check
```

Expected: all pass. Existing Node `punycode` warnings during tests are acceptable if tests pass.

- [ ] **Step 5: Commit**

```bash
git add docs/future/loop-supervisor-design.md docs/manual.md docs/examples/loop-skills-catalog.example.yml scripts/smoke.sh
git commit -m "docs(loop): document supervised runner"
```

## Self-Review

- Spec coverage: Tasks 1-7 cover runner schema, WorkOrder, supervisor session, dispatch, final marker parsing, reporting, service integration, and docs/smoke.
- Safety boundary: No task adds model-provider API clients, SDK dependencies, API-key env vars, or direct model HTTP calls. The supervised runner dispatches prompts through managed sessions.
- Scope control: The first version deliberately excludes JSON action executors, multiple supervisor concurrency, dashboard UI, and autonomous Loop config mutation.
- Type consistency: The plan uses `runner.kind`, `LoopWorkOrder`, `LoopSupervisorFinalSummary`, `runLoopSupervisedProjectAsync`, and `writeLoopSupervisorReport` consistently across tasks.
- Execution risk: Task 6 is the highest-risk slice because it crosses queue/session/service boundaries. Do not start it until Tasks 1-5 are committed and green.
