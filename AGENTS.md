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

## Project-Scoped Notifications

For proactive notifications tied to a project, workspace, run, delegated task,
or tmux session, always carry the project/session identity through the
notification request. Feishu/Lark delivery must prefer the project-bound group
for that session, and fall back to the owner only when no bound group exists.
Do not send project-scoped notices as generic owner DMs just because the
notification gateway can send without a session.

Telegram currently remains owner-directed unless a feature has an explicit
Telegram project-chat target. When a notification can choose channels, keep the
channel selection configurable (`lark`, `telegram`, or `both`) and log the
requested channel, resolved session, registered channels, delivery status, and
per-channel delivery results so routing mistakes are auditable from logs.

## Cross-Channel Feature Parity

Feishu/Lark, Telegram, the TUI, and the control API are delivery shells around
the same bot capabilities. When adding or changing a user-facing command,
button, card action, notification workflow, or delegated-task control, review
all supported shells in the same slice and keep behavior equivalent by default.
Do not implement a Feishu-only interaction and forget the Telegram equivalent,
or vice versa.

Allowed differences must be intentional and documented near the implementation
or tests. Examples: Telegram currently has no project-bound group concept, so
project-group routing can remain Lark-specific; a Lark interactive card may map
to a Telegram inline keyboard, slash command, or concise text action instead of
an identical UI. The standard is capability parity, not pixel-level UI parity.

Before finishing a cross-channel feature, check the matching handlers,
callbacks/card-actions, keyboards/cards, command registry, notification routing,
usage docs, and tests. If a shell is deliberately unsupported, leave a clear
reason and make the user-facing fallback explicit.

## Intelligent Automation Taxonomy

Keep the intelligent automation terms distinct:

- Loop Engineering is the scheduled project/workspace health platform.
- Loop Supervisor is the managed Claude/Codex worker that executes bounded WorkOrders.
- Autopilot means active delegation of a user-confirmed current task to the Loop
  Supervisor; do not reuse the name for legacy keepalive or goal-cycle UI.
- Opportunity Discovery is read-only proposal generation. Discussion and
  implementation remain separate; execution goes through active delegation.
- Daily Task Audit is the bot's self-check/self-healing schedule audit. It checks
  tmux-claude-bot-owned launchd/Loop Engineering tasks plus reported ledger tasks,
  sends the final Telegram/Feishu result, and can dispatch supervisor repair when
  `TASK_AUDIT_AUTO_REPAIR=true`.
- Daily Task Audit must also audit its own previous execution before trusting the
  rest of the schedule report. A previous audit that failed, timed out, left
  `repair-dispatch=failed|blocked|unavailable`, or delivered only a partial/failed
  final notification is a first-class self-repair candidate. Do not remove this
  recursion guard: self-repair records already marked `running` must not be
  dispatched again until their current repair resolves.
- Daily Task Audit auto-repair must be evidence-led. For each unresolved item,
  the delegated repair task must first state the concrete problem, verify it from
  ledger/report/log/git/scheduler evidence, classify whether it is a bot bug or an
  external/target-project condition, and only then edit this repo. Do not submit a
  repair task that skips the problem statement and review gate.
- `pullRequestReview` is scoped to configured project/workspace loop PRs;
  `prReview.repositories` is the repository-wide open-PR queue processor.
- The batch scheduler is configured with `BATCH_SCHEDULER_*`. Keep
  `AUTOPILOT_SCHEDULER_*` only as legacy aliases; new automation must not extend
  those old names.
- Workspace tasks are generic multi-repository WorkOrders. Use top-level
  `workspace.runner`; `architecture.runner` is legacy compatibility for the
  architecture task, not the workspace feature boundary.

## Usage Documentation Lookup

When the task is about how to use tmux-claude-bot, available commands, setup,
configuration, the TUI, chat workflows, autopilot, or troubleshooting, check
`llms.txt` first. For direct task recipes, read `docs/agents/usage-guide.md`, then
follow its links to `docs/manual.md`, `docs/commands.md`, or `docs/tui.md` as needed.
Do not read source code to infer user-facing commands or flags until those
documentation references have been checked.

@RTK.md
