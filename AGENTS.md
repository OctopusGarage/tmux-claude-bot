# Agent Instructions

Read `CLAUDE.md` for the full project rules before making code changes.

## Active Goal Discipline

For broad autonomous goals, work in explicit, reviewable slices. Do not turn the
goal into an endless opportunistic sweep: verify and commit or clean up each
slice, stop after each slice to report exact state, and defer or revert useful
but out-of-scope edits instead of keeping them silently.

Do not implement bot-owned AI behavior by writing code or scripts that call
model-provider APIs directly. AI-backed behavior must route through the
currently running Claude Code / Codex agent sessions or the bot/agent control
surface described in `CLAUDE.md`.
AI work is active-agent-only: features that need AI reasoning must reuse the
currently running Claude Code / Codex capability managed by this bot, by queueing
work into an existing project session, using existing agent goal runners,
or talking to the running bot/agent control surface. Do not add a second model
transport for quick evals, prototypes, smoke checks, or helper scripts.
This project is not a model-client application: autonomous evals, smoke checks,
and other AI-backed work must use the already-running agent surface instead of
adding a separate provider-client path.
Historical names such as `aiEval` are quality-gate/report labels, not permission
to write helper scripts or modules that call model-provider APIs.
Do not add OpenAI/Anthropic/Gemini SDK clients, AI SDK provider packages, model API key
env vars, or model HTTP helper scripts for bot-owned features; use a
deterministic command contract or a control-surface adapter instead.
Do not create temporary/example eval or smoke scripts that bypass this boundary;
prototypes and helpers follow the same rule as production code.
If a design seems to need `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`,
a provider SDK, or a provider HTTP endpoint, redesign it around the current
Claude Code / Codex capability unless the user explicitly approves changing the
architecture.
When a feature needs AI judgment, reuse the active Claude Code / Codex session;
do not create a new code path that calls model APIs directly.
`eval.command`, assessment/execution commands, smoke helpers, and scripts are not
model-integration points; keep them deterministic/local or make them talk to the
running bot/agent control surface. Remove or replace any bot-owned provider SDK,
HTTP, or model-key based eval path with an agent-backed adapter.

## Local Verification Before Push

Before pushing or claiming CI readiness, run `npm run verify:local`. The
pre-push hook runs this command too. If a remote CI failure exposes a category
not covered locally, update `scripts/verify-local.sh`, the hook, or this file so
future agents see the same failure before push.

## Usage Documentation Lookup

When the task is about how to use tmux-claude-bot, available commands, setup,
configuration, the TUI, chat workflows, autopilot, or troubleshooting, check
`llms.txt` first. For direct task recipes, read `docs/agents/usage-guide.md`, then
follow its links to `docs/manual.md`, `docs/commands.md`, or `docs/tui.md` as needed.
Do not read source code to infer user-facing commands or flags until those
documentation references have been checked.

@RTK.md
