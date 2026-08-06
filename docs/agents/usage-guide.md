# Guiding users of tmux-claude-bot — AI reference

A reference for an **AI assistant** to answer "how do I use this?" and walk a user
through any task **without memorising the system**. Find the task below → relay the
steps. This is the AI-facing companion to the human manual; the canonical detail
lives in [docs/manual.md](../manual.md), [docs/commands.md](../commands.md), and
[docs/tui.md](../tui.md) — link the user there for depth.

How to use this doc: skim "30-second model" to frame your answer, find the matching
"task recipe", relay the exact command/keys, and only then point to the canonical doc
if they want more. Prefer giving the one concrete command over describing options.

---

## 30-second model (so you can frame any answer)

tmux-claude-bot runs a coding agent (**Claude Code** or **Codex**) inside managed
sessions on the user's computer, and lets them **drive it remotely** from **Telegram /
Feishu** (phone, text + voice) and from a **terminal UI** (`tcb tui`) at the PC. The
bot is a long-running, auto-restarting service; it's the single brain — phone, Feishu,
and TUI are all just clients of it. One session per project; multiple projects run
in parallel.

Three surfaces, all driving the same bot:
- **Chat** (Telegram / Feishu): commands + buttons + voice. Full table: commands.md.
- **TUI** (`tcb tui`): keyboard control panel at the PC. Guide: tui.md.
- **CLI** (`tcb …`): local admin commands.

---

## Task recipes — "the user wants to …"

**Install it** → one-line installer (macOS/Linux); it builds, registers an
auto-restarting service, and runs a guided setup wizard. Point them at the README
install command + `tcb doctor` to verify.

**Connect Telegram** → in setup, paste a bot token from **@BotFather**, then send the
bot any message so it captures their user id. Re-run later: `tcb setup --reconfigure`.

**Connect Feishu/Lark** → `tcb setup:lark` → scan the QR with the Feishu app to create
the app; their own open_id is captured as the allow-list.

**Send a prompt / get a reply** → just send text in the chat; it's typed into the
current session's agent and the reply returns when the agent finishes. Voice messages
are auto-transcribed. Optional local prompt translation: run `npm run translate:install`
or send `/translate_install` in Telegram/Feishu, then set `PROMPT_TRANSLATE_MODE=argos`,
`PROMPT_TRANSLATE_FROM=zh`,
`PROMPT_TRANSLATE_TO=en` (or source-specific `TELEGRAM_...` / `LARK_...` /
`CONTROL_...` overrides). Runtime controls: Telegram/Feishu
`/prompt_translate status|off|on [from] [to]`; local control
`tcb prompt-translate status|off|on [from] [to]`; TUI `T` toggles control
zh→en.

**Run / switch between multiple projects** → each project is its own session.
Create/switch/remove via the projects commands/buttons (commands.md). On Feishu they
can bind a **group per project** so switching groups = switching projects (no `/cd`).

**Re-run a past input** → `/inputs` (chat) lists recent inputs, tap one to re-run; in
the TUI press `u`.

**Accidentally exited the agent** → use the idle **Resume** button or `/resume` in the
current project. It relaunches the last recorded agent flavor and exact conversation
id for that project. Use `/start` only when they want a fresh agent session.

**See what the agent is doing** → `/peek` (a snapshot of the session pane), `/history`
(recent rounds). In the TUI it's the live right-pane; `a` drops into the real session pane.

**The bot stopped responding** → walk them through: (1) `tcb doctor`; (2) confirm
exactly ONE bot process (two cause a Telegram 409); (3) check network/proxy can reach
the chat API; (4) on macOS, was it asleep? — see keep-awake.

**Keep the Mac awake so it stays reachable** → a sleeping Mac drops the bot (an
outbound long-poll can't be woken). Enable in setup or `tcb setup --reconfigure`: while
the bot runs it holds `caffeinate -s`, which prevents system sleep only on AC power. On
battery, the Mac may sleep normally. A **closed lid** still sleeps — for that they ALSO
need `sudo pmset -a disablesleep 1` (persistent, drains battery; warn them). `tcb doctor`
shows if it's active.

**Use it from the PC terminal** → `tcb tui` (managed) or `npm run tui` (dev). Needs the
bot running. Keys: `j/k` move, `i` compose a prompt (multi-line paste works), `c`
controls, `s` projects (switch/start), `R` recover, `l` logs, `m` machine load, `u`
re-run input, `a` attach to the real session pane, `q` quit, `?` for all keys. Detail: tui.md.

**Check status / "is something wrong?"** → `/dashboard` or `tcb dashboard` (every
session, busy/idle, queue, version); `/sysload` or `tcb sysload` (machine load, heat,
runaway processes); `/logs` or `tcb logs --since 1h --run-id <id>`; `tcb doctor`
(install health).

**Let another local project send notifications** → call `tcb notify` from that
project. It uses the running bot's local control socket and configured Telegram /
Feishu owner targets; the caller does not need chat credentials or SDKs. Example:
`tcb notify --source deploy --level error --title "Deploy failed" --body "api health check failed"`.
Use `--stdin` for multi-line bodies. Use repeatable `--attach <file>` for owner
notification files, for example:
`tcb notify --source radar --title "Radar ready" --body "Daily report attached" --attach report.md --attach report.html`.
When a project has a Feishu/Lark group bound to a bot session, add
`--session <session>` so the notification is delivered to that group instead of
the owner fallback.
For scheduled monitors that should appear in the daily audit, also call
`tcb task report --id <id> --source radar-monitor|article-monitor|external-monitor|launchd
--name <name> --scheduled-at <iso> --status running|success|failed|skipped`.
After repair review, update the same task id with `--repair-status fixed`,
`--repair-status superseded`, `--repair-status not-reproducible`, or
`--repair-status blocked` so the next daily audit does not re-dispatch already
closed failures.

**Schedule recurring Loop Engineering maintenance** → create a Loop config and set
`LOOP_ENGINEERING_CONFIG_FILE=/path/to/loop.yml`. For the automation terminology
map, task-family boundaries, and maintenance checklist, see
`docs/intelligent-automation.md`. Default projects use the
deterministic system runner. For adaptive AI-managed scheduled work, enable the
reserved supervisor with `LOOP_SUPERVISOR_ENABLED=true` and set a project
`runner.kind: agent-supervised`; the bot queues a bounded WorkOrder to the
`tmux_proj_loop-supervisor` session and writes `supervisor.md` /
`supervisor-summary.json`, worker-internal `eval-report.json`, plus resumable
`handoff.md` / `handoff.json` under `loop-runs/<project>/<runId>/`. For projects with
commit/PR settings, the bot also checks the final worktree, switch-back branch,
PR mergeability, and CI rollup after the supervisor reports completion. When
operating an existing install, inspect and pause the top-level loop with
`tcb automation status`, `tcb automation pause loop`, and
`tcb automation resume loop`. Inspect or pause individual configured projects,
workspaces, or repository-wide PR-review entries with
`tcb loop targets list <file>` and `tcb loop targets disable <file> <kind> <id>`
instead of hand-editing YAML.

`pullRequest.autoMerge: true` is set, the bot merges the checked PR and rebases
the local switch-back branch onto origin afterward. Set
`pullRequest.mergeMethod` to `squash`, `merge`, or `rebase` to choose the GitHub
CLI merge mode; the default is `squash`. Use
`pullRequest.githubAccount` when a project must run GitHub CLI commands under a
specific `gh` account; the loop uses a command-local `GH_TOKEN` for `gh api`,
`gh pr`, `gh run`, and related commands instead of the global active `gh`
identity, including security-maintenance runs that only read GitHub alerts. To
run a separate real-bug repair loop, add
`bugFix.enabled: true` with its own `schedule`, `branch`, `maxRounds`, and
`maxBugsPerRound`; the supervisor must prove a functional or reliability bug
before editing, use the bug-fix branch instead of the architecture branch, avoid
feature work and nitpicks, add focused regression coverage where configured, and
stop when no confirmed real bug remains. To raise meaningful test coverage, add
`testCoverage.enabled: true` with its own `schedule`, `branch`, `targetCoverage`
(default 80), and `maxRounds`; the supervisor must inspect the real test stack
and risk paths, avoid metric-padding tests, add unit/integration/smoke/E2E/AI
eval coverage only when justified, and fix real bugs discovered during coverage
work. AI eval coverage must use an existing agent-backed or deterministic eval
surface, not direct model-provider APIs. To run automatic security review and
repair, add `securityMaintenance.enabled: true` with its own `schedule`,
`branch`, and `maxRounds`. The supervisor checks
dependencies, GitHub security findings, static analysis, secrets, auth
boundaries, webhooks, CORS, file/path handling, uploads, command execution,
sensitive logging, CI secrets, and supply-chain risks. It must verify
reachability and severity before editing, avoid blind dependency churn, run the
relevant security check plus local verification, and document impact, fix,
verification, and residual risk in the PR. To review and merge loop-created PRs
on a later schedule, add `pullRequestReview.enabled: true`
with its own `schedule`, `lookbackHours`, `consecutivePasses`, `autoMerge`, and
optional `mergeMethod`;
the supervisor performs repeat review passes focused on bugs, CI, and
mergeability rather than nits.
To run one orchestrated project-health loop instead of several mechanical
maintenance jobs, add `harnessAuto.enabled: true` with its own `schedule`,
`branch`, `maxRounds`, `strategy`, `tasks`, and `stopWhen`. A harness run first
assesses the current project health, then chooses justified enabled subtasks
from architecture, bug-fix, test-coverage, and security-maintenance. It keeps
one run id and one PR branch/PR for the whole run, stops when the configured
health/issue condition is met, and must not run every subtask just because it is
configured.
For code-changing WorkOrders, `cleanupPolicy` controls cleanup risk:
`conservative` is the default, `balanced` removes unsupported stale paths only
with clear evidence, and `aggressive` is for explicit new-feature cleanup where
obsolete compatibility paths, duplicate entry points, transition code, and stale
docs should be removed after review and verification.
To proactively surface new work for owner approval, add
`opportunityDiscovery.enabled: true` with its own `schedule`, `maxSuggestions`,
`minConfidence`, categories, and optional prompt. This job is intentionally
read-only: the supervisor inspects the project, writes `opportunities.json`, and
the bot sends Telegram/Feishu suggestions with `/opportunity` commands. Use
`/opportunity discuss <number|id>` to get a decision prompt, then use Autopilot /
Continue via supervisor for confirmed work. Use `/opportunity dismiss
<number|id>` when it is not worth doing. Feishu commands work in private chat and
in the bound project group that received the suggestion. Feishu opportunity
notifications are interactive cards with readable per-suggestion summaries and
view, discuss, and dismiss actions for each item; bulk discuss/dismiss remains
available for a related batch. Telegram notifications expose per-suggestion
discuss/dismiss buttons when each callback fits Telegram's 64-byte
`callback_data` limit; if an imported or unusual id is too long, Telegram falls
back to the typed `/opportunity` commands in the message. The notification card
keeps discussion and execution separate; after owner approval, use the project
control panel's **Delegate now** button, or **Review plan first** followed by
**Confirm delegation**, or `/autopilot delegate` so all implementation work goes
through the same Loop Supervisor active-delegation pipeline. If all supervisor
sessions are busy, the blocked Autopilot reply exposes a queue view; Lark can
cancel queued/running active-delegated tasks from that queue card, while
scheduled system WorkOrders remain non-cancellable there.
For coordinated frontend/backend or otherwise coupled repositories, add a
`workspaces` entry. Workspace jobs create one scheduled multi-repository
WorkOrder, ask the supervisor to inspect cross-repository contracts when
relevant, and require every repository to end clean on its configured switch-back
branch. Workspace entries support the same task families as projects:
`architecture`, `bugFix`, `testCoverage`, `securityMaintenance`, `harnessAuto`,
`opportunityDiscovery`, and `pullRequestReview`. The internal
`workspace-architecture` job kind is only a compatibility name for architecture
run ids; it is not the workspace feature boundary.

**Hand off a clarified interactive task** → use `/autopilot [requirement]`,
`/autopilot delegate [requirement]`, or `tcb autopilot <project> "[requirement]"`.
This is not a cron fire:
it creates a bounded active WorkOrder from the current project session and sends
it to the reserved Loop Supervisor. If the requirement text is omitted, the
supervisor uses the current session context plus repository state as the source
of truth: live pane, git status, recent commits, existing PRs, and prior
verification output. Telegram/Feishu expose **Delegate now** for immediate
handoff and **Review plan first** for a pre-delegation preview with a
confirmation button. Before substantive execution, the supervisor records a
delegation brief with objective, checklist, acceptance criteria, stop
conditions, non-goals, risks, and verification plan; ambiguous or high-risk work
blocks for clarification instead of guessing. It then drives the target project
agent through implementation, review, relevant tests, coverage review for
touched risk paths, any justified existing agent-backed/deterministic AI eval,
and the configured PR/merge/switch-back policy. The final summary records a plan
review before completion. The command returns a run id immediately; the final
result is written under `loop-runs/...` and sent through Telegram/Feishu
notifications.
For scheduled suggestions, approved implementation uses the same active
delegation pipeline as Autopilot. The opportunity discussion prompt prepares a
delegation brief draft from stored evidence, scope, proposed plan, acceptance
checks, non-goals, risks, and verification expectations; execution begins only
after the owner confirms that scope and invokes Autopilot / Delegate now or the
plan-first confirmation flow.

**Audit yesterday's scheduled work** → enable `TASK_AUDIT_ENABLED=true` and set
`TASK_AUDIT_SCHEDULE` (UTC cron, e.g. `0 2 * * *` for 10:00 Singapore time).
The audit actively discovers tmux-claude-bot-owned macOS launchd jobs and
loop-engineering schedules, merges them with the shared task ledger, and when
`TASK_AUDIT_AUTO_REPAIR=true` queues the Loop Supervisor to repair only
tmux-claude-bot-owned failures on `TASK_AUDIT_REPAIR_BRANCH`. This is the
self-check/self-healing task for the bot's own hosted schedules, not another
project-health loop. After the repair dispatch decision, it sends the final
Telegram/Feishu summary with the repair dispatch result. External scheduled
systems should report through `tcb task report` rather than being inspected
through project-specific adapters.
Use `tcb automation status`, `tcb automation pause task-audit`, and
`tcb automation resume task-audit` for day-to-day operator control.
For an immediate manual check, run `tcb task audit --force` (add `--json` for
machine-readable output). The command goes through the running bot's control
socket, so it uses the same config, notification gateway, and auto-repair path as
the scheduled service.

**Evaluate system prompts** → use `tcb prompts governed list --json` to see every
repo-owned governed prompt, `tcb prompts governed show <promptId>` to inspect
owner and safety metadata, `tcb prompts governed render <promptId>` to inspect
the rendered prompt when a built-in fixture exists, `tcb prompts governed check
--json` for deterministic governance checks, and `tcb prompts governed eval
--all --output /tmp/tcb-prompt-eval.md` to generate an active-agent AI eval
task. The eval command only prints or writes the assessment prompt; it must be
handed to the current Claude Code / Codex surface and must not use direct
model-provider APIs.

**Restart the bot / deploy code changes** → it's a managed service, so restart via the
manager: `tcb service restart` (or `launchctl kickstart -k …` / `systemctl --user
restart tmux-claude-bot`). To pick up SOURCE changes, deploy a fresh build:
`node dist/cli.js install` (rebuilds `dist/` then restarts). Plain restart alone won't
rebuild.

**Recover after a reboot** → agents that were running before a reboot are relaunched
automatically on boot; to do it on demand use `/recover` (chat) / `R` (TUI) / `tcb
recover`. This is host-wide; for one accidentally exited current project use
`/resume`.

---

## Quick reference

- **Chat commands**: organised as Session / Projects / Settings / Diagnostics — full
  table with descriptions in [commands.md](../commands.md). Diagnostics (`/dashboard`,
  `/sysload`, `/logs`, `/doctor`) are owner-only (Feishu: 1:1 chat only).
- **CLI — drive the bot from the shell** (this is what you, the AI, run; the bot must
  be running; project-driving commands take a project by name + `--json`):
  - `tcb sessions` / `tcb projects` — list running sessions / all projects.
  - `tcb notify --title "<title>" --body "<body>" [--attach <file>]...` — send a local
    owner notification through Telegram/Feishu without receiving chat messages.
  - `tcb send <project> "<prompt>"` — send a prompt; **waits for the reply** and prints
    it (`--no-wait` to fire-and-forget, `--timeout <s>`). This is your main verb.
  - `tcb peek <project>` — snapshot its pane · `tcb open <project> [--agent claude|codex]`
    — switch to / start a project, optionally selecting the agent when stopped ·
    `tcb control <project> <esc|enter|resume|restart|…>` — a control key
    (`--yes` is required for dangerous actions in scripts).
- **CLI — admin**: `run` · `setup` / `setup:lark` · `doctor` · `dashboard` · `sysload`
  · `tui` · `recover` · `logs` · `install` ·
  `service <install|uninstall|status|pause|resume|restart|logs>`.
  (`npm run dev|tui|doctor|service:*` for dev.)
- **TUI keys**: see [tui.md](../tui.md).

---

## Interpreting what users see ("what does this mean?")

- **`ctx X% · 5h Y% · 7d Z%`** (dashboard) → Claude subscription usage: `ctx` = context
  window fullness (high → suggest `/compact` or a new session); `5h`/`7d` = the
  5-hour / weekly rate-limit consumed (near 100% → they'll be throttled until reset).
- **"409 conflict" / multiple instances** → two bot processes share one Telegram token;
  there must be exactly one. Identify the managed one and kill the stray.
- **busy `●` (green) / idle `○`** → a session actively working vs not.
- **TUI "can't reach the control socket"** → the bot isn't running; start the service.

---

## When unsure

Point the user to [docs/manual.md](../manual.md) (the comprehensive manual) and have
them run `tcb doctor` — its checklist names the exact problem and the fix command. Do
not invent commands; everything the system exposes is in commands.md / the CLI list
above.

> Kept current: a contract test ties the command surfaces to the docs (see CLAUDE.md
> "User documentation"). If a recipe here ever conflicts with the live commands, trust
> commands.md / `tcb --help` and fix this file.
