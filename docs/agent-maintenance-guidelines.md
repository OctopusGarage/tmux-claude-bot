# Agent Maintenance Guidelines

This document holds detailed maintenance guidance that is too verbose for
always-loaded files such as `AGENTS.md` and `CLAUDE.md`.

Read this when changing service management, runtime state, logs, autonomous
task execution, notification routing, project sessions, verification scripts, or
developer-facing docs.

## Service And Runtime Management

Only one bot instance should run against a given `TCB_STATE_DIR`. The runtime
instance lock refuses a second instance sharing the same state directory, but it
does not protect unrelated state directories.

Supported modes:

- Managed prod: built `dist/cli.js`, persistent launchd/systemd service, prod
  config and state.
- Managed dev: source hot-reload through the dev supervisor, persistent
  launchd/systemd service, usually borrowing prod config and state.
- `npm run dev`: foreground source run, no persistence.
- `./dev.sh`: foreground dev helper that pauses the managed service and resumes
  it on exit.
- `npm run tui`: control-socket client, not a bot instance.

Managed install owns the full onboarding surface: runtime build, global
launchers, guided setup, launchd/systemd registration, isolated Home Operator
workspace provisioning, operator-home skill installation, and MCP profile
descriptor installation. It must not install global Claude/Codex skills by
default; `tcb skill install --scope global` is an explicit convenience command.
If one of those surfaces changes, update `install.sh`, `INSTALL.md`,
`docs/manual.md`, doctor coverage, and a script contract test in the same slice.

Use the service manager, not legacy process scripts, for persistent services:

- macOS launchd: `launchctl kickstart -k "gui/$(id -u)/com.octopusgarage.tmux-claude-bot"`.
- Linux systemd: `systemctl --user restart tmux-claude-bot`.
- Cross-platform project helpers: `npm run service:status`,
  `npm run service:dev`, `npm run service:prod`, `npm run service:pause`, and
  `npm run service:resume`.

Identify bot processes with both the project path and entrypoint
(`dist/cli.js` or `src/index.ts`). Do not use broad process patterns such as
`node` or `tsx` alone.

## Sensitive Data And Paths

Never hardcode personal paths, usernames, credentials, tokens, or private
workspace paths in source, tests, docs, examples, or `.env.example`. Use
environment variables, `os.homedir()`, `loadConfig()`, or generic test paths.

Before committing changes that touch config, paths, examples, docs, or tests,
check for accidental personal paths. Use the existing project verification or a
local search for home-directory literals; avoid committing real user-specific
paths from source, tests, docs, or generated examples.

The search pattern itself should not be copied into a committed command if that
would make the documentation match its own warning.

Every user-facing message, notification, card, and CLI display must collapse
the current home directory to `~` using the shared `tildeifyHome` or
`tildeifyHomeDeep` boundary. Never expose personal absolute paths. Keep
canonical absolute paths only in internal logic, state, logs, and artifacts.

## Logging And Artifacts

Long-running workflows must be diagnosable from persisted logs and artifacts
without replaying the task. Record at least:

- WorkOrder id, task type, configured project/workspace paths, branch, and
  GitHub account.
- Supervisor, worker, and runtime-guardian session names.
- Expected path, actual git toplevel, worktree path, cleanup action, and final
  gate result.
- Commands run, timeout decisions, relevant output summaries, PR URL, CI/check
  status, switch-back result, and clean-worktree result.
- Notification channel requested, resolved project-bound session/group, delivery
  status, and per-channel errors.

Use structured logs through the existing logger helpers. Do not rely only on
free-form chat text for operational state.

## Intelligent Automation Reference

The authoritative automation model lives in `docs/intelligent-automation.md`.
The alignment matrix and drift checklist live in `docs/automation-alignment.md`.
Keep these documents aligned with code and tests when changing:

- Loop Engineering task families: architecture, bug-fix, test-coverage,
  security-maintenance, harness-auto, opportunity-discovery, PR review, and
  workspace tasks.
- Autopilot active delegation.
- Daily Task Audit and auto-repair.
- Runtime Guardian and fast-heal repair.
- Supervisor pools, target workers, worktree isolation, and cleanup.
- Feishu/Lark, Telegram, TUI, CLI, and control API surfaces.

Do not add feature-specific side channels that bypass WorkOrder state,
system-gate artifacts, notification gateway routing, or conflict checks unless
the exception is documented and covered by tests.

## Supervisor And System Gates

Supervisors execute target-project work. The bot system enforces final
acceptance. Keep these responsibilities separate:

- Supervisor may sync branches, create work branches, delegate to project
  workers, fix code, add tests, run verification, commit, open or update PRs,
  clean PR bodies, and switch the target repo back to the configured branch.
- System gates must independently validate WorkOrder state, structured
  supervisor output, PR lookup, mergeability, CI/check interpretation,
  auto-merge completion, switch-back branch, clean worktree, notification
  result, and final artifact integrity.

If target-project code, tests, PR body, branch state, or local verification are
wrong, let the supervisor repair the target project through the configured
agent session. If a completed run is misclassified because system-gate logic is
wrong, fix this repository instead of weakening the gate.

For owner-confirmed delegated work, keep the task advancement contract
structured. The WorkOrder should carry planning expectations when the task is
broad or agent-driven. Before substantive execution, the supervisor must form a
`delegationBrief` with the objective, current assessment, score or
not-applicable score, checklist, acceptance criteria, stop conditions,
non-goals, risks, and verification plan. Before completion, the final summary
must record `planReview` so the system can see whether the checklist was
completed, the score target was met or not applicable, a stop condition was
hit, over-optimization was avoided, verification completed, and residual risks
remain.

## Conflict And Isolation Rules

Default scheduled or delegated code-changing work to isolated worktrees and
dedicated worker sessions. Non-isolated execution should be explicit and limited
to flows that intentionally repair this bot's live runtime, such as Runtime
Guardian fast-heal, where immediate effect matters.

Block ordinary user prompts that target a project with unfinished or recoverable
supervisor-owned work. Diagnostic and cancel/escape controls should remain
available. System-originated supervisor prompts may continue because they are
part of the owning WorkOrder.

When adding a new task kind, define how it conflicts with:

- active supervisor WorkOrders;
- harness-auto runs containing the same subtask;
- repository-wide PR review;
- opportunity discussion and delegation;
- runtime-guardian repair;
- ordinary user chat into the same project/session.

## Notifications

For project-scoped notifications, always carry project/session identity through
the notification request.

Feishu/Lark must prefer the project-bound group for that session and fall back
to the owner only when no bound group exists. Telegram is owner-directed unless
a feature has an explicit Telegram project-chat target. Channel selection should
remain configurable as `lark`, `telegram`, or `both`.

Feishu/Lark cards and Telegram actions should provide capability parity by
default. Differences are allowed only when the platform model differs, and the
reason should be documented near the implementation or tests.

## GitHub Automation

When a project or repository config sets `pullRequest.githubAccount` or
`githubAccount`, every GitHub CLI command in that WorkOrder must use a
command-local token:

```bash
GH_TOKEN="$(gh auth token --user <account>)" gh ...
```

This applies to `gh api`, `gh pr`, `gh run`, `gh repo`, and security-alert
checks, even when the task does not create a PR. Do not rely on the global
active `gh` account for configured projects.

## Verification And Coverage

Before pushing or claiming CI readiness, run `npm run verify:local`. If remote
CI finds a class of issue not covered locally, update the local verification
script, hook, or instructions.

Release tags must not bypass the local gate. Keep `scripts/release.sh` running
`npm run verify:local` before `npm version`; `TCB_RELEASE_SKIP_VERIFY=1` is a
manual emergency escape hatch and should not be used for routine releases.

Git hooks must be safe in linked automation worktrees. Keep the worktree config
guard enabled in pre-commit and pre-push hooks so a hook failure cannot leave
the shared common git config with `core.bare=true` and break the source
worktree. Hook entrypoints must also clear Git's exported repository-local
environment variables, such as `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, and
the variables listed by `git rev-parse --local-env-vars`, before running Node
tests, shell scripts, or nested temporary-repository checks. Restoring
`core.bare=false` only at hook exit is a recovery fallback, not sufficient root
cause prevention.

When `core.bare=true`, an unexpected `core.worktree`, or suspected Git config
mutation appears again, inspect the guard trace before guessing. By default the
trace is written to `<git-common-dir>/tcb-git-config-guard.log`; tests and
diagnostic runs may override it with `TCB_GIT_CONFIG_TRACE_FILE`. Each line
records the stage, cwd, common git dir, config path, config checksum,
`core.bare`, `core.worktree`, and inherited Git-local environment variables.
`npm run verify:local` checkpoints before and after every command it runs, so
the first adjacent before/after pair whose checksum or value changes is the
command boundary to investigate. Treat inherited `GIT_DIR`/`GIT_WORK_TREE` as
evidence of wrong-repository targeting risk; treat an observed value transition
to `bare=true` as the proof needed to identify the writer.

Agent tool hooks must block attempts to set `core.bare=true` before the shell
command runs. Keep `scripts/agent-command-guard.sh` covered by tests and wired
into Claude/Codex `PreToolUse` hooks so agents cannot corrupt the source or
linked worktree configuration while trying to repair git state.

AI capacity, rate-limit, readiness, queue, and network transients must be
classified before they are reported as project failures. Keep the shared
transient classifier covered by tests, wire provider transients into bounded
supervisor dispatch retry, preserve retryable schedules after terminal dispatch
failure, and expose leaked terminal transients through Runtime Guardian.

Coverage work should improve meaningful behavior coverage. Do not add low-value
tests just to move a percentage. If a project cannot reasonably reach the
configured threshold in one round, record the evidence, useful tests added,
remaining gaps, and next target area.

Loop Engineering assessment findings must declare every path the active agent is
allowed to change in `affectedFiles`, including architecture guard directories,
config files, docs, and lockfiles. A dirty worktree after staging those paths is
a failed round.

## Documentation And Skills

`llms.txt` is the top-level documentation index for agents and documentation
indexers. Update it when adding durable reference docs.

When changing user-facing behavior, update:

- `docs/manual.md` for CLI/setup/workflow behavior;
- `docs/commands.md` for Telegram and Feishu/Lark commands;
- `docs/tui.md` for terminal UI behavior;
- `docs/intelligent-automation.md` for automation concepts and relationships;
- `docs/automation-alignment.md` for parity and drift expectations;
- relevant skills, `.claude/commands`, and tests.

Do not let installed skills, slash commands, runtime commands, and docs describe
different business behavior.
