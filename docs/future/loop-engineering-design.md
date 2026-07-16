# Loop Engineering Design Handoff

Status: core implementation restored. The previous overbuilt implementation was
intentionally rolled back; this document tracks the intended product plus the
implemented safety boundaries.

## Objective

Loop Engineering should let tmux-claude-bot run recurring engineering-maintenance
goals across selected local projects, using the already-running Claude Code or
Codex sessions that the bot manages.

The loop should:

1. Consume the shared agent capability registry to keep approved engineering
   skills available to project agents.
2. Pick the right skill and prompt style for the current maintenance goal.
3. Run small, reviewable improvement rounds.
4. Verify the result with deterministic checks plus agent-backed evaluation.
5. Commit only verified changes when configured to do so.
6. Produce a clear report that summarizes every round, verification result,
   commit, deferred finding, and follow-up.
7. Feed useful runtime/system-improvement suggestions back into a backlog for
   improving tmux-claude-bot itself.

## Hard Constraints

- Do not call OpenAI, Anthropic, Gemini, or other model-provider APIs directly
  from this repository.
- Do not add provider SDK clients, API-key env vars, or helper scripts that own
  model transport.
- Any AI-backed assessment, execution, or eval must happen through the active
  Claude Code / Codex agent session already managed by the bot.
- Broad maintenance goals must be split into explicit, reviewable slices.
- A failed verification or failed eval must block commits.
- The feature must be opt-in. A normal bot install must not start autonomous
  code changes unless a config explicitly enables it.

## Product Shape

### CLI

Proposed command group:

```bash
tcb loop validate <file> [--json]
tcb loop tick <file> [--now <iso-or-epoch-ms>] [--json]
tcb loop run <file> <projectId> [--json]
tcb loop reports list [--json]
tcb loop backlog list [--all] [--json]
tcb loop backlog close <id> [--json]
tcb loop skills list [--json]
tcb loop skills sync <file> [--json]
```

Use `loop`, not `maintenance`, to make the feature name explicit and avoid
confusing it with generic repository maintenance.

Phase 1 implements only `tcb loop validate <file> [--json]`. It parses config,
performs static preflight checks, and never executes a project, queues an agent
message, syncs a skill, runs verification, or commits code.

Phase 2 implements `tcb loop tick <file> [--now <time>] [--json]` as a due-only
scheduler pass. It reads config, checks scheduled projects, persists
`loop_lastfired.json`, and reports which projects would run. It still never
executes a project, queues an agent message, syncs a skill, runs verification, or
commits code.

Phase 3 implements `tcb loop skills list [--json]`,
`tcb loop skills refresh <file> [--write] [--json]`, and
`tcb loop skills sync <file> [--json]` as skill registry management. Catalog
entries may track Git refs such as `main`, but `refresh` resolves them to pinned
approved entries with concrete commit SHAs and checksums before project runs use
them. `sync` plans install/update/remove/keep actions from pinned config
metadata, persists `loop_skills.json`, and delegates actual
installation/removal to `skills.applyCommand`. The bot still does not download,
copy, symlink, or mutate agent skill files directly, and it still does not
execute projects, queue agent messages, run verification, or commit code.

Phase 4 implements `tcb loop run <file> <projectId> [--json]` as a deterministic
command-backed run path. It runs `assessment.command` in the configured project
directory, then runs `eval.command` when configured and the assessment command
succeeds. Command exit codes are the gate for this phase. The command output is
recorded in the run summary, while reports, backlog, managed ticks, and
agent-backed eval remain deferred to the next phase.

Phase 5 completes the first usable managed loop: `eval.agent` is accepted through
an injected active-agent adapter boundary, `eval.command` JSON can contribute
score and bot-improvement suggestions, `loop run` writes Markdown/JSON reports,
`loop reports list` and `loop backlog list|close` expose persisted state, and the
managed service can periodically run due command-backed projects when
`LOOP_ENGINEERING_CONFIG_FILE` is set and `LOOP_ENGINEERING_TICK_MS` is non-zero.
Agent-backed project modification, finding normalization, and commits remain
explicitly out of the default path until their safety contract is added.

Phase 6 adds the guarded execution loop. `assessment.command` may emit JSON
findings; the runner normalizes them, skips unsafe findings with reasons, selects
up to `maxRounds` safe findings, and only queues project-modification prompts when
`execution.agent: true` is explicitly set. The managed service routes those prompts
through the existing project session queue, waits for the active Claude Code/Codex
session to finish, runs each finding's deterministic verification commands, and
creates targeted per-round git commits only when `commit.enabled: true`.

Phase 1 decisions:

- Assessment starts with `assessment.command`; `assessment.agent` is rejected
  until the managed agent JSON contract is implemented.
- Skill sync is delegated through `skills.applyCommand`; the bot records and
  validates registry metadata but does not copy or symlink skill files itself.
- Reports should default to app state (`state/loop-runs/<project>/<runId>/`) with
  optional per-project `reportDir` override in a later phase.
- Commits are off by default. When enabled, per-round commits are the safer first
  implementation because they are easier to audit and revert.
- Dashboard integration is deferred; CLI summaries and logs are the first
  operating surface.

### Managed Service

Config env:

```bash
LOOP_ENGINEERING_CONFIG_FILE=
LOOP_ENGINEERING_TICK_MS=300000
```

If either the config file is blank or tick interval is `0`, the managed service
does nothing.

### Config

Example:

```yaml
skills:
  applyCommand: ./scripts/sync-agent-skill.sh
  catalog:
    - id: improve-codebase-architecture
      sourceUrl: https://github.com/mattpocock/skills
      sourcePath: skills/engineering/improve-codebase-architecture
      trackingRef: main
      platforms: [claude, codex]
      tags: [architecture, refactor]
      trustLevel: approved
      risk: medium
      updatePolicy: notify
  approved:
    - id: improve-codebase-architecture
      sourceUrl: https://github.com/mattpocock/skills
      sourcePath: skills/engineering/improve-codebase-architecture
      ref: 2f3c4d5e6a
      checksum: sha256:...
      platforms: [claude, codex]
      tags: [architecture, refactor]
      trustLevel: approved
      risk: medium
      updatePolicy: notify

projects:
  - id: tmux-claude-bot
    name: tmux-claude-bot
    path: /path/to/project
    agent: codex
    schedule: "0 2 * * *"
    goal: >
      Improve core module clarity and reliability in small verified slices.
    maxRounds: 3
    targetScore: 90
    assessment:
      command: npm run loop-assess
    execution:
      agent: true
    eval:
      agent: true
      minScore: 95
    commit:
      enabled: true
      perRound: true
      branch: loop/tmux-claude-bot/daily
    allowedActions:
      - tests
      - docs
      - small-refactor
    blockedActions:
      - direct-model-api
      - dependency-upgrade
      - broad-rewrite
    selfImprovement:
      enabled: true
      maxItemsPerRun: 5
```

## Architecture

### Modules

Proposed modules:

- `src/core/loop/config.ts`
  Parses YAML, validates schedules, policies, skill registry config, commit
  policy, eval mode, and project paths.

- `src/core/loop/scheduler.ts`
  Computes due projects and persists last-fired anchors. It must not backfill
  ancient missed runs on first start.

- `src/core/skills/schema.ts` and `src/core/skills/registry.ts`
  Shared agent capability registry used by Loop Engineering and Autopilot.
  Reconciles approved skill specs through a command boundary. It pins refs,
  rejects floating refs such as `main`, records installed state, and quarantines
  unsafe entries. `src/core/loop/skill-registry.ts` is only a compatibility
  re-export.

- `src/core/loop/assessment.ts`
  Produces findings from either a deterministic command or an agent-backed prompt.
  Findings must be normalized into a typed schema before planning.

- `src/core/loop/planner.ts`
  Selects the next safe finding. It should prefer high-confidence, low-risk,
  verifiable slices and defer broad rewrites, manual-only items, and unverified
  work.

- `src/core/loop/executor.ts`
  Sends the selected round to the existing project agent queue. It must not spawn
  or call a separate model client.

- `src/core/loop/verification.ts`
  Runs deterministic verification commands in order, stops on first failure, and
  records stdout/stderr summary.

- `src/core/loop/eval.ts`
  Performs final quality evaluation. `eval.agent: true` should queue a judging
  prompt into the active project agent and parse a strict JSON result. A local
  `eval.command` may exist only as a deterministic contract or as an adapter to
  the running bot/agent surface, not as a model-provider client.

- `src/core/loop/commit.ts`
  Handles branch checkout, targeted staging, staged-diff detection, commit
  message construction, and SHA capture.

- `src/core/loop/report.ts`
  Writes a Markdown report and optional JSON summary per run.

- `src/core/loop/backlog.ts`
  Stores runtime/system-improvement suggestions separately from target-project
  changes.

- `src/core/loop/service.ts`
  Wires scheduler, shared skill sync, project runner, and managed bot queue
  together.

### Data Flow

1. Scheduler determines a project is due.
2. Skill registry sync runs first. Failure blocks project execution.
3. Assessment produces score and findings.
4. Planner selects one finding or stops if already healthy.
5. Executor queues a focused prompt into the active project agent.
6. Verification runs deterministic checks.
7. If verification passes, optional per-round commit is created.
8. Repeat against the normalized assessment findings until max rounds or no safe
   findings remain.
9. Eval gate runs when configured.
10. Report and runtime-improvement backlog are written.
11. Tick summary logs pass/fail counts.

## Agent Prompt Contract

Execution prompts should include:

- Project identity and path.
- Overall goal.
- Selected finding title, severity, confidence, affected files, suggested action.
- Allowed and blocked action policy.
- Required verification plan.
- Skill hint, if selected.
- Explicit instruction to make the smallest safe change.
- Explicit instruction to stop after the slice, report files changed, and avoid
  unrelated opportunistic refactors.

Eval prompts should include:

- The final run JSON.
- Report path.
- Target score and min excellent score.
- Round summaries and verification outcomes.
- Direct instruction to judge on the current agent surface only.
- Direct instruction not to request or use model-provider API keys.
- Required JSON output schema:

```json
{
  "passed": true,
  "score": 95,
  "findings": [
    {
      "criterion": "rounds-verified",
      "status": "pass",
      "message": "All executed rounds passed verification."
    }
  ],
  "suggestedBotImprovements": [
    "Make failed scheduler ticks easier to diagnose."
  ]
}
```

## Safety Policy

Automatically executable findings must satisfy all of these:

- `confidence` is high enough.
- `autofixSafety` is safe or guarded.
- affected files are explicit and bounded.
- verification plan is non-empty unless the action is docs-only.
- action category is allowed by project policy.
- finding is not a broad architecture rewrite.
- finding does not require secrets, external account setup, or user approval.

Everything else is deferred into the report.

## Reporting

Each report should include:

- project id/name/path
- configured goal
- run start/end time
- score before/after
- target score and eval min score
- quality-gate verdict
- every selected round
- skill hint per round
- affected files
- verification command results
- commit sha/message per round or final commit
- deferred findings and reasons
- final eval result and findings
- runtime/system-improvement suggestions

## Testing Plan

Core unit tests:

- config parsing and validation
- scheduler due/anchor behavior
- skill registry install/update/remove/quarantine planning
- finding normalization
- round planner safe/deferred policy
- queue executor prompt construction
- agent eval prompt construction and robust JSON extraction
- verification gate ordering and fail-fast behavior
- commit manager staging/commit/failure paths
- report writer output
- backlog dedupe/close/list behavior
- service tick failure isolation

Integration/smoke tests:

- `tcb loop validate` text and JSON output
- deterministic `tcb loop run` with a fake project
- deterministic `tcb loop tick` with persisted anchors
- managed-service tick with injected fake queue runner
- build, lint, full test suite, and smoke

Current implemented coverage includes config validation, scheduler anchors, skill
registry reconciliation, deterministic command-backed run, finding normalization,
planner skip reasons, queue-backed agent task delivery, verification fail-fast,
targeted git commit flow, report/backlog persistence, and managed service ticks.

AI eval:

- Use an already-running project agent session.
- Record prompt, response, parsed JSON, and report path.
- Require an excellent threshold, not just a pass boolean.
- Treat malformed or incomplete agent output as a failed eval gate.

## Rollout Plan

1. Land config, validate CLI, docs, and tests only.
2. Land scheduler/tick without execution.
3. Land skill registry sync/list.
4. Land deterministic command-backed run path.
5. Land report, backlog, agent-eval adapter boundary, and managed service ticking.
6. Land managed queue-backed project execution. Done.
7. Land finding normalization and planner. Done.
8. Land commits behind verified gates. Done.
9. Enable on one low-risk project with `commit.enabled: false`.
10. Enable commits only after several successful dry runs.

## Open Questions

- What exact JSON schema should `assessment.agent` emit when it is added?
- Should a later aggregate-final-commit mode exist after per-round commits are
  proven stable?
- How should the dashboard surface active loop runs without cluttering normal
  session state once the core loop is stable?
