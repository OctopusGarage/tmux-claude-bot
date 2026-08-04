# Agent Instructions

Read `CLAUDE.md` before making code changes. Keep this file short because it is
always loaded by agents.

## Active Goal Discipline

For broad autonomous goals, work in explicit, reviewable slices. Do not turn the
goal into an endless opportunistic sweep: verify and commit or clean up each
slice, stop after each slice to report exact state, and defer or revert useful
but out-of-scope edits instead of keeping them silently.

## Alignment Governance

Before changing user-facing commands, chat buttons/cards, TUI actions, CLI
surfaces, installed skills, `.claude` commands, Loop Engineering task families,
Autopilot, Opportunity Discovery, PR review, Daily Task Audit, Runtime Guardian,
notification routing, worktree/session isolation, or GitHub automation, read
`docs/automation-alignment.md` and update the relevant alignment surface in the
same slice.

When a change introduces, removes, or changes user personal configuration that
operators may need to inspect or modify, prefer a safe `tcb ...` command surface
over instructions to edit state files by hand. Reads must redact secrets by
default; generic writes must be allowlisted and non-secret, with credentials and
owner identifiers staying behind setup or dedicated commands.

Keep durable business truth out of always-loaded memory when possible:
`docs/intelligent-automation.md` owns automation terminology and relationships,
`docs/automation-alignment.md` owns cross-surface drift checks, and
`docs/agent-maintenance-guidelines.md` owns operational and maintenance detail.
If a rule must be enforced, add a schema check, contract test, hook, runtime
gate, or verification command instead of relying only on prose.

## Local Tooling Rules

If `.codegraph/` exists at the repository root, use CodeGraph before grep/find
or manual file reading when locating or understanding code. Prefer
`codegraph_explore` when available; otherwise use `codegraph explore "<query>"`.

Use RTK for shell commands to reduce noisy output. Prefer `rtk <command>` for
git, test, build, search, and log commands. `RTK.md` contains the compact command
reference; do not replace these short always-loaded rules with the full
generated `rtk init` block.

## Automation Session Isolation

For Loop Engineering, Autopilot, PR review, harness-auto, Daily Task Audit
repair, Runtime Guardian repair, and other long-running WorkOrders, keep
execution context isolated from ordinary user chat. A WorkOrder's configured
`projectPath` or workspace repository path is the only trusted target location.
Before sync, assessment, edits, PR review, or mutating shell commands, verify
`git -C <path> rev-parse --show-toplevel` matches that configured path; block
rather than guessing when it does not.

Keep product logic and user configuration separate. Do not copy active user
project lists, repository paths, GitHub accounts, schedules, cleanup policies,
or live task settings into source, tests, or maintained docs unless they are
clearly synthetic fixtures or generic examples. Live user configuration belongs
under the state/config directory, external backups, or operator notes outside
the source tree.

## AI Capability Boundary

Do not implement bot-owned AI behavior by writing code or scripts that call
model-provider APIs directly. AI work is active-agent-only: features that need
AI reasoning must reuse the currently running Claude Code / Codex agent sessions
or the bot/agent control surface. This project is not a model-client application.

Historical names such as `aiEval` are quality-gate/report labels, not permission
to add model-provider clients. Do not add OpenAI/Anthropic/Gemini SDK clients, AI SDK provider packages, model API key env vars, or model HTTP helper scripts for bot-owned features. If a design seems to need direct provider access, redesign it around the current running Claude Code / Codex capability.
When a feature needs AI judgment, reuse the active Claude Code / Codex session; `eval.command`, assessment/execution commands, smoke helpers, and scripts are not model-integration points.

## Local Verification Before Push

Before pushing or claiming CI readiness, run `npm run verify:local`. The
pre-push hook runs this command too. If a remote CI failure exposes a category
not covered locally, update `scripts/verify-local.sh`, the hook, or this file so
future agents see the same failure before push.

## Documentation And Comment Language

Write maintained documentation, source comments, and test comments in English.
Localized user-facing strings are allowed only in i18n catalogs, UI fixtures,
and tests that intentionally verify localized behavior.

## Usage Documentation Lookup

When the task is about how to use tmux-claude-bot, available commands, setup,
configuration, the TUI, chat workflows, autopilot, or troubleshooting, check
`llms.txt` first. For direct task recipes, read `docs/agents/usage-guide.md`,
then follow its links to `docs/manual.md`, `docs/commands.md`, or `docs/tui.md`
as needed. Do not read source code to infer user-facing commands or flags until
those documentation references have been checked.

@RTK.md
