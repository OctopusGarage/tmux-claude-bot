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
runaway processes); `/logs` or `tcb logs`; `tcb doctor` (install health).

**Let another local project send notifications** → call `tcb notify` from that
project. It uses the running bot's local control socket and configured Telegram /
Feishu owner targets; the caller does not need chat credentials or SDKs. Example:
`tcb notify --source deploy --level error --title "Deploy failed" --body "api health check failed"`.
Use `--stdin` for multi-line bodies. Use repeatable `--attach <file>` for owner
notification files, for example:
`tcb notify --source radar --title "Radar ready" --body "Daily report attached" --attach report.md --attach report.html`.
For scheduled monitors that should appear in the daily audit, also call
`tcb task report --id <id> --source radar-monitor|article-monitor|external-monitor|launchd
--name <name> --scheduled-at <iso> --status running|success|failed|skipped`.
After repair review, update the same task id with `--repair-status fixed`,
`--repair-status superseded`, `--repair-status not-reproducible`, or
`--repair-status blocked` so the next daily audit does not re-dispatch already
closed failures.

**Schedule recurring Loop Engineering maintenance** → create a Loop config and set
`LOOP_ENGINEERING_CONFIG_FILE=/path/to/loop.yml`. Default projects use the
deterministic system runner. For adaptive AI-managed scheduled work, enable the
reserved supervisor with `LOOP_SUPERVISOR_ENABLED=true` and set a project
`runner.kind: agent-supervised`; the bot queues a bounded WorkOrder to the
`tmux_proj_loop-supervisor` session and writes `supervisor.md` /
`supervisor-summary.json` under `loop-runs/<project>/<runId>/`. For projects with
commit/PR settings, the bot also checks the final worktree, switch-back branch,
PR mergeability, and CI rollup after the supervisor reports completion. When
`pullRequest.autoMerge: true` is set, the bot merges the checked PR and
fast-forwards the local switch-back branch afterward. Use
`pullRequest.githubAccount` when PR commands must run under a specific `gh`
account; the loop uses a command-local `GH_TOKEN` for that account instead of the
global active `gh` identity. To run a separate real-bug repair loop, add
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
with its own `schedule`, `lookbackHours`, `consecutivePasses`, and `autoMerge`;
the supervisor performs repeat review passes focused on bugs, CI, and
mergeability rather than nits.
For coordinated frontend/backend or otherwise coupled repositories, add a
`workspaces` entry with `architecture.enabled: true`; that creates one scheduled
multi-repository WorkOrder, asks the supervisor to inspect cross-repository
contracts, and requires every repository to end clean on its configured
switch-back branch.

**Audit yesterday's scheduled work** → enable `TASK_AUDIT_ENABLED=true` and set
`TASK_AUDIT_SCHEDULE` (UTC cron, e.g. `0 2 * * *` for 10:00 Singapore time).
The audit actively discovers tmux-claude-bot-owned macOS launchd jobs and
loop-engineering schedules, merges them with the shared task ledger, and when
`TASK_AUDIT_AUTO_REPAIR=true` queues the Loop Supervisor to repair only
tmux-claude-bot-owned failures on `TASK_AUDIT_REPAIR_BRANCH`. After that
dispatch decision, it sends the final Telegram/Feishu summary with the repair
dispatch result. External scheduled systems should report through `tcb task
report` rather than being inspected through project-specific adapters.

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
