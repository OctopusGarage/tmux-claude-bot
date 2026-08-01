# Project Principles

Keep this file short. It is always loaded into Claude Code context, so it should
contain only project-wide rules and pointers to deeper references.

## Usage Documentation Lookup

When the task is about how to use tmux-claude-bot, available commands, setup,
configuration, the TUI, chat workflows, autopilot, or troubleshooting, check
`llms.txt` first. For direct task recipes, read `docs/agents/usage-guide.md`, then
follow its links to `docs/manual.md`, `docs/commands.md`, or `docs/tui.md` as needed.
Do not read source code to infer user-facing commands or flags until those
documentation references have been checked.

## Rule Placement

- Put cross-agent hard rules in `AGENTS.md` and Claude-specific project rules
  here.
- Put intelligent-automation business truth in `docs/intelligent-automation.md`.
- Put cross-surface parity and drift checks in `docs/automation-alignment.md`.
- Put operational, logging, service, coverage, and maintenance details in
  `docs/agent-maintenance-guidelines.md`.
- Put reusable procedures in skills or thin slash-command wrappers.

When a rule must be enforced, add a schema check, contract test, hook, runtime
gate, or verification command. Memory and instruction files are context, not a
policy engine.

## Alignment Governance

Before changing user-facing commands, chat buttons/cards, TUI actions, CLI
surfaces, installed skills, `.claude` commands, Loop Engineering task families,
Autopilot, Opportunity Discovery, PR review, Daily Task Audit, Runtime Guardian,
notification routing, worktree/session isolation, or GitHub automation, read
`docs/automation-alignment.md` and update the relevant alignment surface in the
same slice.

## Local Tooling Rules

If `.codegraph/` exists at the repository root, use CodeGraph before grep/find
or manual file reading when locating or understanding code. Prefer
`codegraph_explore` when available; otherwise use `codegraph explore "<query>"`.

Use RTK for shell commands to reduce noisy output. Prefer `rtk <command>` for
git, test, build, search, and log commands. `RTK.md` contains the compact command
reference; do not replace these short always-loaded rules with the full
generated `rtk init` block.

## Active Goal Discipline

For broad autonomous goals, work in explicit, reviewable slices. Do not turn a broad active goal into an endless opportunistic sweep. Verify and commit or clean up each slice, stop after each slice to report exact state, and defer anything useful but out of scope. Clean up or revert opportunistic changes instead of keeping them silently.

## AI Capability Boundary

This is not a model-client application. AI work is active-agent-only: features
that need AI reasoning must reuse the active Claude Code / Codex session by
queueing work into an existing project session, using existing agent goal
runners, or talking to the running bot/agent control surface.

Do not add source, scripts, smoke tests, docs, or `.env.example` entries that
call OpenAI, Anthropic, Gemini/Google, or other LLM/model HTTP APIs directly. Do not ship helper scripts that instantiate model SDK clients such as
`GoogleGenerativeAI`, OpenAI, Anthropic, Gemini, AI SDK, or similar providers.
Use a deterministic command contract or an adapter that talks to the running bot/agent control surface.

Historical names such as `aiEval` are quality-gate/report labels, not
permission to write helper scripts or modules that call model-provider APIs
directly; they do not authorize a new script, helper, or module to bypass the
active agent surface. `eval.command`, assessment/execution commands, smoke helpers, and scripts are command-contract boundaries, not model-integration points. If a design seems to need a provider SDK, model API key, or model HTTP
endpoint, treat that as an architectural regression: stop and redesign around
the active agent surface unless the user explicitly approves changing the
architecture.

## Automation Boundaries

Loop Engineering, Autopilot, PR review, harness-auto, Daily Task Audit repair,
Runtime Guardian repair, and other long-running WorkOrders must be isolated from
ordinary user chat. A WorkOrder's configured `projectPath` or workspace
repository path is the only trusted target location.

Before sync, assessment, edits, PR review, or mutating shell commands, verify
`git -C <path> rev-parse --show-toplevel` matches the configured path. Block
rather than guessing when it does not. Persist the worker/session name, expected
path, actual toplevel, cleanup decision, and final gate result so failed runs can
be replayed after worker cleanup.

Agent supervisors execute project work; the bot system enforces final
acceptance. Keep PR lookup, mergeability, CI/check interpretation, auto-merge
completion, switch-back branch, clean worktree, and system-gate validation in
this repo rather than trusting only the supervisor self-report.

## Verification

Before pushing or claiming CI readiness, run `npm run verify:local`. The
pre-push hook runs the same command. If remote CI finds a class of issue not
covered locally, update `scripts/verify-local.sh`, the hook, or these rules so
future agents see the same failure before push.

## Documentation And Comment Language

Write maintained documentation, source comments, and test comments in English.
Localized user-facing strings are allowed only in i18n catalogs, UI fixtures,
and tests that intentionally verify localized behavior.

Loop Engineering assessment findings must declare every path the active agent is
allowed to change in `affectedFiles`, including architecture guard directories,
config files, docs, and lockfiles. A dirty worktree after staging those affected
files is a failed round; update the assessment contract instead of leaving
verified changes uncommitted.

@RTK.md
