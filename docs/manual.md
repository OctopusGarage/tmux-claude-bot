# tmux-claude-bot — User Manual

The single, comprehensive guide to using tmux-claude-bot. It links out to the
detailed references where they exist: the full command table in
[docs/commands.md](commands.md) and the terminal UI in [docs/tui.md](tui.md).

> Kept in sync with the code: a contract test (`tests/docs-contract.test.ts`) fails
> CI if a CLI command or chat command is added without being documented here / in the
> linked references. See "Keeping this in sync" at the bottom.

---

## 1. What it is

tmux-claude-bot runs a coding agent — **Claude Code** or **OpenAI Codex** — inside
managed project sessions on your computer, and lets you **drive it remotely**:

- from **Telegram** and/or **Feishu/Lark** on your phone (text + voice), and
- from a **terminal UI** (`tcb tui`) at the PC.

Each project gets its own session; you can run several in parallel, switch
between them, and the bot survives restarts/reboots without losing your routing.

---

## 2. Install & setup

One-line install (macOS / Linux) — see the README for the canonical command:

```bash
curl -fsSL https://raw.githubusercontent.com/OctopusGarage/tmux-claude-bot/main/install.sh | bash
```

It builds the bundle, registers an auto-restarting service (launchd on macOS,
systemd `--user` on Linux), and runs the **guided setup wizard**:

- pick a chat app (Telegram, Feishu/Lark, or both);
- Telegram: paste a bot token from **@BotFather**, then message the bot once so it
  captures your user id;
- Feishu/Lark: scan a QR code to create the app (or `tcb setup:lark` later);
- choose allowed project directories, the agent start command, voice language, and
  (macOS) whether to keep the Mac awake.

Re-run setup any time with `tcb setup --reconfigure`. Verify the install with
`tcb doctor`.

---

## 3. Daily use from your phone (chat)

The Telegram and Feishu interfaces mirror each other. The **full command list with
descriptions is in [docs/commands.md](commands.md)**; this is the orientation.

### Talking to the agent
- **Send any text** → it's typed into the current session's agent; the reply comes
  back when the agent finishes. **Voice messages** are transcribed and sent as text.
  Optional local prompt translation can be enabled with
  `npm run translate:install` or `/translate_install`, plus `PROMPT_TRANSLATE_MODE=argos`,
  `PROMPT_TRANSLATE_FROM=zh`, and `PROMPT_TRANSLATE_TO=en`; it applies to text,
  voice transcriptions, TUI input, and `tcb send`. Change it at runtime with
  `/prompt_translate status|off|on [from] [to]` in Telegram/Feishu, or
  `tcb prompt-translate status|off|on [from] [to]` for local control input.
- Replies show the agent's output; long output is paged.

### The control panel (buttons)
Every reply carries a control panel (Telegram inline keyboard / Feishu card):
interrupt (esc) · enter · the lifecycle keys (restart / clear / compact / exit) ·
peek · history · projects · queue. It adapts to whether an agent is running.
When the agent is stopped, the idle panel offers **Start** and **Resume**: Start opens
a new agent session, while Resume relaunches the current project's last recorded
agent flavor and conversation id.
Lifecycle buttons that can interrupt work or reset context (`restart`, `clear`,
`compact`, `exit`) ask for confirmation before running.

### Commands, by area (see commands.md for the table)
- **Session**: `/start` `/resume` `/status` `/peek [N]` `/history [N]` `/inputs [N]`
  (recent inputs — tap one to re-run) `/restart` `/clear` `/compact` `/exit`.
- **Projects**: create / switch / remove projects; `/recover` to relaunch agents that
  were running before a reboot.
- **Feishu project groups**: bind a Feishu group to one project so you switch projects
  by switching groups (no `/cd`); works without `@bot`.
- **Settings**: `/lang` (UI language), `/voice_lang`, `/prompt_translate`, status-line install, `/prompts` (browse saved prompts). Telegram and Feishu both surface the voice and translation pickers from the settings controls.
- **Diagnostics**: `/dashboard` (every session at a glance) · `/sysload` (machine
  load / heat / runaway processes) · `/logs` · `/doctor`. Owner-only; on Feishu these
  are 1:1-chat only.

### Prompt Library (`/prompts`)

Browse and copy prompts saved in a configured MCP prompt server.

- `/prompts` — list all prompts with tag filters and paging
- `/prompts <keyword>` — search by keyword

Requires `PROMPT_MCP_COMMAND` (and optionally `PROMPT_MCP_ARGS`, `PROMPT_MCP_CWD`) in `.env`. Works with any MCP server that implements `search_prompts`, `get_prompt`, and `list_prompt_tags`. Owner-only (private chat only).

---

## 4. Terminal UI — `tcb tui`

A keyboard-driven control panel at the PC, the local sibling of the chat clients (it
drives the **same** bot, so it can't race your phone). See **[docs/tui.md](tui.md)**
for the full guide. In brief:

```bash
tcb tui        # managed install
npm run tui    # dev
```

Sessions list + live peek; `i` compose a prompt (multi-line paste works), `c`
controls, `s` projects (switch/start), `R` recover, `l` logs, `m` load, `u` re-run a
recent input, `a` attach into the real session pane, `q` quit. Press `?` for all keys.

---

## 5. Keeping the Mac awake

A sleeping Mac drops the bot off your phone (nothing can wake an outbound long-poll).
Opt in during setup (or `tcb setup --reconfigure`): while the bot runs it holds a
`caffeinate -s` assertion, which prevents system sleep only while the Mac is on AC
power. It does **not** keep the Mac awake on battery power and does **not** cover a
closed lid — for that also run `sudo pmset -a disablesleep 1`. `tcb doctor` reports
whether keep-awake is on and active, **and** reads the actual lid state — if the lid is
closed while `pmset disablesleep` is off (so the Mac will sleep and drop the bot) it
fails the check with the fix command.

---

## 6. CLI reference (`tcb …`)

The installer drops global launchers in `~/.local/bin`, so `tcb …` (and the full
`tmux-claude-bot …`) work from anywhere — e.g. `tcb tui`, `tcb dashboard`. (If
`~/.local/bin` isn't on your `PATH`, add it; or run `node dist/cli.js …` from the
install dir.)

| Command | What it does |
|---------|--------------|
| `tcb run` | run the bot in the foreground (what the service runs) |
| `tcb setup` / `tcb setup:lark` | guided setup wizard / add Feishu via QR |
| `tcb doctor` | health checks against the install |
| `tcb dashboard` | global status snapshot of all sessions (`--json` for raw) |
| `tcb autopilot` | autopilot status across all sessions (`--json` for raw) |
| `tcb batch <load\|export\|start\|status\|report\|pause\|resume\|stop>` | manage batch scheduler plans and runs |
| `tcb loop validate\|tick\|run <file>` / `tcb loop reports\|backlog\|skills …` | validate a Loop Engineering config, check due projects, run command-backed projects, list reports/backlog, refresh catalog skills to pinned refs, or reconcile approved skills (`--json` for raw; `tick` also supports `--now`) |
| `tcb sysload` | machine load, thermal state, top CPU, runaway shells |
| `tcb tui` | the terminal control panel (needs the bot running) |
| `tcb recover` | relaunch agents that were running before a reboot |
| `tcb logs` | query the structured logs |
| `tcb install` | provision the managed service into the stable dir |
| `tcb service <install\|uninstall\|status\|pause\|resume\|restart\|logs>` | manage the auto-restarting service |

**Drive the bot from the shell** (one-shot control-socket clients — for scripts or an
AI agent; need the bot running, all accept a project by name and `--json`):

| Command | What it does |
|---------|--------------|
| `tcb sessions` | list the running sessions |
| `tcb projects` | list projects (live + recent); `tcb open <name>` to start one |
| `tcb notify [text...]` | send a local send-only notification through the configured Telegram/Feishu bot; use `--title`, `--body` or `--stdin`, `--channel telegram\|lark\|both`, `--level info\|success\|warning\|error`, `--source <name>`, and repeatable `--attach <file>` |
| `tcb task report --id <id> --source <source> --name <name> --scheduled-at <time> --status <status>` | record an external scheduled task in the shared daily task ledger; add `--repair-status fixed\|superseded\|not-reproducible\|blocked` after repair review |
| `tcb send <project> "<prompt>"` | send a prompt to a project's agent; **waits for the reply** (`--no-wait` / `--timeout <s>`) |
| `tcb peek <project>` | print a snapshot of its session pane |
| `tcb open <project> [--agent claude\|codex]` | switch to / start a project; `--agent` selects the start command when the project is stopped |
| `tcb adopt [pid]` | list unmanaged claude/codex processes, or adopt one by PID (stops it, resumes under management) |
| `tcb control <project> <esc\|enter\|resume\|restart\|…>` | send a control action; `restart` / `clear` / `compact` / `exit` prompt for confirmation (`--yes` for scripts) |
| `tcb attach <file...>` | send an image/file to the session's chat; defaults to the current session (`--to <project>`, `--caption <text>`) |
| `tcb skill install` | install the AI operating skill into Claude Code / Codex (`--tool` for one) |

`tcb notify` is for other local projects that need outbound alerts but do not need
to receive chat messages. It talks to the already-running bot over the local control
socket, so those projects do not need Telegram tokens, Feishu credentials, chat ids,
or SDK dependencies. It sends to the configured owner targets only. Attachments are
uploaded by the active Telegram/Feishu adapter, for example:

```bash
tcb notify --channel lark --title "Radar ready" --body "Daily report attached" \
  --attach report.md --attach report.html
```

Use `tcb notify --attach` for owner/background notifications. Use `tcb attach`
when a chat-originated project session should receive a file reply in that same
chat context.

External scheduled monitors can report their status into the bot's daily task
ledger without linking to bot internals:

```bash
tcb task report --id "radar:daily:2026-07-27" --source radar-monitor \
  --name "daily radar monitor" --scheduled-at "2026-07-27T03:00:00Z" \
  --status failed --error "report file was not generated"
```

After the daily audit repair pass verifies a failed task, report the repair
outcome against the same task id instead of creating a new ad hoc record:

```bash
tcb task report --id "radar:daily:2026-07-27" --source radar-monitor \
  --name "daily radar monitor" --scheduled-at "2026-07-27T03:00:00Z" \
  --status failed --repair-status fixed \
  --summary "fixed and verified on dev"
```

This is what the **AI skill** (`skills/tmux-claude-bot/SKILL.md`, the AI-facing
companion to [docs/agents/usage-guide.md](agents/usage-guide.md)) drives — so an agent
in Claude Code / Codex can operate the system in natural language. The installer runs
`tcb skill install` by default (opt out with `TCB_SKIP_SKILL=1`); re-run it any time to
refresh the skill. It lands at `~/.claude/skills/tmux-claude-bot/SKILL.md` and
`~/.codex/prompts/tmux-claude-bot.md`.

`npm run <dev\|tui\|doctor\|service:*>` are the dev-profile equivalents.

---

## 7. Autopilot

Autopilot keeps an agent running hands-free: it detects idle, nudges it with a
continuation prompt, recovers from errors, and stops on a user-defined condition.
Start it from chat with `/autopilot on` (keep-alive, no exit condition) or
`/autopilot goal <id>` (run to a goal); `/autopilot off` (or `stop`) ends it for a
session. Check status across all sessions with `tcb autopilot`. It is **off by
default** and opt-in per session.

To manage **every** session without enabling each one, run `/autopilot global on`
(persisted in `AUTOPILOT_GLOBAL_KEEPALIVE`): live sessions are auto-kept-alive;
`/autopilot off` opts one out, and `/autopilot global off` un-enrolls them.

> Autopilot's drive-loop is descended from **[ForgeFlow](https://github.com/Kingson4Wu/ForgeFlow)** —
> see [Acknowledgements](#acknowledgements).

### Telegram button controls

Autopilot is also fully button-drivable from Telegram. Open the inline control
panel (the keyboard under any reply, or via the control buttons), then tap
`✈️ Autopilot` to enter the autopilot panel. From there you can enable or disable
autopilot for the current session, open the goal picker to select one or more goals
with a multi-select list and set the number of rounds, then start the cycle — or
toggle the global keep-alive on/off for all sessions, or stop autopilot outright.
When a goal reaches a `humanGate` phase, the owner notification itself carries
✅确认 and ▶️继续 buttons so you can confirm or continue without typing a command.

### Terminal TUI controls

Autopilot is also fully drivable from `tcb tui`. Press `A` to open the autopilot panel: enable or disable autopilot for the current session, pick one or more goal-cycles (multi-select + rounds) and start the cycle, toggle the global keep-alive, or stop autopilot. When a goal pauses at a `humanGate` phase, a banner appears in the TUI — press `A` again to confirm and continue in-place.

### Lark/Feishu button controls

Autopilot is also fully button-drivable from Lark/Feishu. In a private chat (p2p)
the control card includes a `✈️ Autopilot` button that opens the autopilot panel
card. From there you can enable or disable autopilot for the current session, open
the goal picker to select one or more goals with a multi-select list and set the
number of rounds, then start the cycle — or stop autopilot outright. The
host-wide global keep-alive toggle is available in the panel when opened from a
private chat; it is omitted in bound group chats. You can also open the panel
directly with `/autopilot`. When a goal reaches a `humanGate` phase, the owner
receives an interactive card with ✅确认 and ▶️继续 buttons.

### Goals

A **goal** is a named preset that tells autopilot what to do each phase and when to
stop. Built-in goal ids (`test-coverage`, `fix-tests`, `code-review`, `add-feature`,
`refactor-elegant`, `ui-polish`) are always available. You can also drop your own
goal files into the goals directory.

Goal phases may use plain prompts or skill intents. Skill metadata is shared with
Loop Engineering through the agent capability registry (`skills.catalog` and
`skills.approved`), so the same approved skill set can support interactive
Autopilot goals and scheduled project maintenance.

**User-defined goals** — create a `.json` file in `AUTOPILOT_GOALS_DIR` (default
`~/.tmux-claude-bot/state/autopilot-goals`). Any `.json` file placed there appears
in `/goals` and can be started with `/autopilot goal <id>`. Built-in ids take
precedence — a user file with a conflicting id is ignored.

Minimal goal schema:

```json
{
  "id": "my-goal",
  "titleKey": "My goal",
  "phases": [
    {
      "id": "p1",
      "intent": { "kind": "prompt", "text": "…" },
      "done": { "kind": "sentinel", "marker": "GOAL_DONE" }
    }
  ]
}
```

`id` must be unique and not collide with a built-in (non-empty string). `titleKey`
is a short label (any non-empty string). Each phase needs an `intent` — either
`{ "kind": "prompt", "text": "…" }` or `{ "kind": "skill", "name": "…", "fallback": "…" }`
— and a `done` condition. The `done` kinds are: `sentinel` (watch the output for a
literal `[MARKER]`), `check` (run a shell command — done on exit 0), `humanGate`
(pause and wait for `/autopilot confirm`), and `all` / `seq` to compose them
(`{ "kind": "all", "of": [ … ] }`). Edits to a goal file are picked up when a file is
added/removed in the directory or the bot restarts.

### Goal cycling

`/autopilot goals a,b rounds N` runs the listed goals in rotation for N rounds, pausing at each `humanGate` phase for `/autopilot confirm` before continuing to the next goal. Omit `rounds` to run one round.

### Completion-aware keep-alive

`/autopilot on` drives the current task to completion: when the agent emits `[TASK_DONE]` in its output, autopilot stops automatically instead of nudging indefinitely.

### Between-goals context reset

Set `AUTOPILOT_BETWEEN_GOALS` (`none | compact | clear`, default `compact`) to
control what autopilot does between goals in a cycle. With `compact` (the
default), autopilot runs `/compact` on the agent before the next goal's first
prompt to free up context. Use `clear` to run `/clear` instead (full reset), or
`none` to skip the reset entirely.

### Usage gate

Set `AUTOPILOT_USAGE_PAUSE_PCT` (default `0`, disabled) to a percent threshold
(e.g. `90`). When an active goal detects that the agent's context or rate-limit
usage has reached that percent, autopilot pauses and notifies you — so it won't
burn through your quota unattended. Resume with `/autopilot on` or
`/autopilot goal <id>` once you are ready to continue.

---

## 8. Loop Engineering

Loop Engineering runs recurring maintenance work from a YAML config. It is off by
default; enable it by setting:

```bash
LOOP_ENGINEERING_CONFIG_FILE=/path/to/loop.yml
LOOP_ENGINEERING_TICK_MS=300000   # 0 disables the managed loop
```

Each scheduled project chooses a runner:

- `runner.kind: system` (default) runs deterministic local commands, optional queued
  agent tasks, verification, eval, commit, and writes `report.md` / `summary.json`.
  Before each selected optimization round, the managed loop queues `/compact` for
  the project agent session, then sends the round task.
- `runner.kind: agent-supervised` sends a bounded WorkOrder to a reserved Loop
  Supervisor agent. The supervisor can inspect failures, adapt the next action, and
  finish with a required marker + JSON summary. Reports are written as
  `supervisor.md` / `supervisor-summary.json`. When commit or PR publishing is
  enabled, the managed loop still performs final system gates after the supervisor
  reports completion: clean worktree, expected switch-back branch, PR lookup,
  mergeability, and completed successful/neutral/skipped CI checks. If
  `pullRequest.autoMerge: true` is configured, the system gate merges the PR after
  those checks pass, switches to `pullRequest.switchBack`, and fast-forwards it
  from `origin`. Set `pullRequest.githubAccount` when the repository needs a
  specific GitHub CLI identity; PR create/view/merge commands then use a
  command-local `GH_TOKEN` from `gh auth token --user <account>` instead of the
  global active `gh` account. If the supervisor response misses the required final marker, the
  loop treats the scheduled fire as unfinished and retries it on a later tick
  instead of marking it complete. The WorkOrder instructs the supervisor to run
  `tcb control <project> compact --yes` before each delegated optimization round.
  When the supervisor reports completion but the bot's system gate finds a
  recoverable validation failure, such as a dirty worktree, wrong switch-back
  branch, missing PR cleanup, pending/failing PR checks, or PR hygiene issue, the
  same WorkOrder stays owned by the supervisor. The bot sends a bounded revision
  prompt with the exact validation failures and re-runs the system gate after the
  supervisor responds. Non-recoverable platform failures, such as missing GitHub
  write permission or missing system adapters, fail directly with the concrete
  blocker instead of looping.
  A project can also define `bugFix` with its own cron schedule. That job is
  separate from architecture improvement: it asks the supervisor to find and fix
  only proven functional or reliability bugs, to skip style nits and speculative
  concerns, and to stop when a round finds no confirmed real bugs. `bugFix`
  reuses the same commit, PR, verification, and system-gate policy as the
  project.
  `testCoverage` is a third separate cron job for raising meaningful test
  coverage. Its default target is 80%, but the supervisor must first inspect the
  project test stack, coverage command/report, uncovered behavior, and risk
  paths. It should prefer focused unit tests, add integration, smoke, E2E, or AI
  eval tests only when the project context justifies them, and may make small
  refactors for testability. It must not add import-only tests, empty assertions,
  mock-implementation tests, snapshot padding, fixture churn, or any other tests
  whose only purpose is increasing a metric. If coverage work exposes a real bug,
  vulnerability, flaky behavior, broken harness, or incorrect existing test, the
  supervisor should confirm it, fix it narrowly, and add regression coverage when
  practical. AI eval coverage must use an existing agent-backed or deterministic
  eval surface; do not add direct model-provider SDKs, model API keys, or HTTP
  model calls for this task.
  `securityMaintenance` is a separate cron job for automatic security review and
  repair. It checks dependency advisories, GitHub security findings, static
  analysis, secret exposure, auth/permission boundaries, webhook verification,
  CORS, file/path handling, uploads, command execution, sensitive logging, CI
  secret handling, and supply-chain risks. Before editing, the supervisor must
  decide whether the finding is real or plausibly reachable in the project,
  record severity/reachability evidence, and avoid dependency churn or cosmetic
  hardening just to quiet a scanner. Confirmed fixes use the security branch,
  run the relevant security check plus normal local verification, and describe
  source, impact, fix, verification, and residual risk in the PR.
  `pullRequestReview` is another separate cron job. It reuses the same project
  session and supervisor, reviews loop-created PRs from the configured lookback
  window, requires the configured number of clean review passes, and only
  auto-merges when CI/status checks and mergeability are acceptable. It is
  intended to catch introduced bugs and operational risks, not to block on style
  nits.
- `workspaces` define coordinated multi-repository architecture jobs. Use this
  when repositories should be evaluated together, such as a frontend/backend pair
  in the same product directory. A workspace architecture job is one scheduled
  WorkOrder with one run id, but each repository keeps its own branch and PR. The
  supervisor must inspect cross-repository contracts, change only the repositories
  that need changes, link related PRs, and verify every repository is clean and
  back on its configured switch-back branch before finalizing.

Enable the supervisor only when at least one project uses `agent-supervised`:

```bash
LOOP_SUPERVISOR_ENABLED=true
LOOP_SUPERVISOR_AGENT=codex       # codex (default) or claude
LOOP_SUPERVISOR_DIR=              # blank -> <state-dir>/loop-supervisor
LOOP_SUPERVISOR_POOL_SIZE=1       # >1 starts tmux_proj_loop-supervisor-1/-2/...
LOOP_SUPERVISOR_RESET_BEFORE_WORK_ORDER=clear
TCB_LOOP_SUPERVISOR_REVISION_MAX_ATTEMPTS=3
```

Example project:

```yaml
projects:
  - id: datavibe-backend
    name: Datavibe Backend
    path: /path/to/datavibe-backend
    agent: codex
    schedule: "30 5 * * *"
    runner:
      kind: agent-supervised
      timeoutMs: 7200000
      maxTurns: 20
      requireConfirmation: false
    goal: Improve architecture in small verified slices and commit each round.
    maxRounds: 3
    targetScore: 90
    assessment:
      command: npm run assess
    execution:
      agent: true
    commit:
      enabled: true
      branch: loop/datavibe-backend/architecture
    pullRequest:
      enabled: true
      base: main
      switchBack: main
      autoMerge: false
      githubAccount: Kingson4Wu
    bugFix:
      enabled: true
      schedule: "45 10 * * *"
      branch: loop/tmux-claude-bot/bug-fix
      maxRounds: 3
      maxBugsPerRound: 2
      requireRegressionTest: true
      prompt: >
        Find and fix only real functional or reliability bugs. Do not nitpick
        style, do not add features, and stop when no confirmed real bug remains.
    testCoverage:
      enabled: true
      schedule: "20 14 * * *"
      branch: loop/datavibe-backend/test-coverage
      targetCoverage: 80
      maxRounds: 5
      requireMeaningfulTests: true
      allowIntegrationTests: true
      allowSmokeTests: true
      allowE2ETests: true
      allowAiEvalTests: false
      prompt: >
        Raise meaningful test coverage to at least 80%. Do not add weak tests
        purely to move the metric; prioritize real behavior, critical paths, and
        regressions found while testing.
    securityMaintenance:
      enabled: true
      schedule: "10 16 * * *"
      branch: loop/datavibe-backend/security-maintenance
      maxRounds: 3
      allowDependencyUpdates: true
      allowConfigHardening: true
      allowStaticAnalysisFixes: true
      prompt: >
        Check and fix confirmed security risks. Include dependencies, GitHub
        security findings, static analysis, secrets, auth boundaries, webhooks,
        CORS, file/path handling, uploads, command execution, sensitive logging,
        CI secrets, and supply-chain issues. Do not blindly upgrade dependencies
        or harden config unless the risk is real or plausibly reachable.
    pullRequestReview:
      enabled: true
      schedule: "0 1 * * *"
      lookbackHours: 48
      consecutivePasses: 2
      autoMerge: true
      prompt: >
        Review loop-created PRs from the previous day. Do not nitpick; focus on
        introduced bugs, broken tests, CI failures, mergeability, data loss,
        security, migrations, and user-visible regressions.
    allowedActions: [tests, docs, small-refactor]
    blockedActions: [direct-model-api, broad-rewrite]
```

Example workspace:

```yaml
workspaces:
  - id: geo
    name: Geo Workspace
    root: /path/to/realestate
    agent: codex
    repositories:
      - id: geo-backend
        name: Geo Backend
        path: /path/to/realestate/geo-backend
        role: backend
        pullRequest:
          enabled: true
          base: main
          switchBack: main
      - id: geo-frontend
        name: Geo Frontend
        path: /path/to/realestate/geo-frontend
        role: frontend
        pullRequest:
          enabled: true
          base: main
          switchBack: main
    architecture:
      enabled: true
      schedule: "10 11 * * *"
      goal: Improve frontend/backend architecture together.
      maxRounds: 3
      targetScore: 95
      runner:
        kind: agent-supervised
```

Supervisor dispatch still uses this bot's managed Claude Code / Codex sessions. It
does not call model-provider APIs directly. If the supervisor session is missing or
the queue cannot accept the WorkOrder, the scheduler keeps the fire eligible for a
later retry instead of consuming that cron occurrence.

Useful commands:

- `tcb loop validate <file> [--json]`
- `tcb loop tick <file> [--now <iso>] [--json]`
- `tcb loop run <file> <projectId> [--json]` for command-backed/manual runs
- `tcb loop reports list [--json]`
- `tcb loop backlog list [--all] [--json]`
- `tcb loop skills refresh <file> [--write] [--json]`

## 9. Home operator

When `HOME_OPERATOR_ENABLED=true`, the bot auto-starts a dedicated agent session
(Claude Code or Codex) in a fixed home directory. That session becomes the default
chat target whenever no project is selected — so you can manage the whole fleet by
talking to it directly: it drives `tcb send`, `tcb open`, and the rest of the CLI,
plus the `tmux-claude-bot` AI skill.

**Enable it** during setup (the wizard asks, default no) or manually:

```bash
HOME_OPERATOR_ENABLED=true    # enable
HOME_OPERATOR_AGENT=claude    # claude (default) or codex
HOME_OPERATOR_DIR=            # blank → <state-dir>/home (auto-created)
```

**Usage notes:**

- `/home` — switch a Telegram or Feishu/Lark channel back to the operator at any time.
- The operator runs `--dangerously-skip-permissions` (it can't respond to interactive
  prompts — messages to it go straight to the agent).
- It is excluded from autopilot and the global keep-alive scheduler; `tcb send`
  and relay commands refuse it as a target to avoid loops.
- The dashboard shows it as "home operator", not a work project.

---

## 10. Batch scheduler

Run a set of agent tasks across multiple projects on a schedule (cron, one-shot, or immediate).

**Quick start:**

1. Define a YAML plan file (see `docs/batch-plan.example.yml` for the full schema).
2. `tcb batch load <file>` — parse, validate, and save the plan.
3. `tcb batch start <id>` — materialise and activate a run immediately.
4. `tcb batch status` — print the live task table for the active run.
5. `tcb batch report` — print a completion summary (done/failed/skipped counts).

**Other controls:**

| Command | Effect |
|---------|--------|
| `tcb batch export <id> [file]` | dump the saved plan back to YAML |
| `tcb batch pause` | pause the active run (tasks already in flight continue) |
| `tcb batch resume` | resume a paused run |
| `tcb batch stop` | cancel and clear the active run |

**Cron notes:** schedule expressions are five fields (`min hour dom month dow`), matched in **UTC**. Both `dom` and `dow` must match (they are ANDed, not ORed — non-standard vs. vixie cron).

---

## 11. Daily task audit

The daily task audit checks the previous Singapore calendar day for actively
discovered scheduled tasks and explicit task records, can ask the Loop
Supervisor to repair bot-owned failures on a configured branch, then sends the
final success/failure/missing summary with the repair dispatch result to
Telegram and/or Feishu.

```bash
TASK_AUDIT_ENABLED=true
TASK_AUDIT_SCHEDULE=0 2 * * *     # UTC; 10:00 Singapore time
TASK_AUDIT_TICK_MS=300000
TASK_AUDIT_CHANNEL=both           # telegram | lark | both
TASK_AUDIT_AUTO_REPAIR=true
TASK_AUDIT_REPAIR_BRANCH=dev
```

The audit actively discovers tmux-claude-bot-owned launchd jobs and
loop-engineering schedules, then merges that expected-task list with the shared
ledger. Loop Engineering and the batch scheduler write to the ledger
automatically. Article monitors, radar monitors, and other local jobs should
call `tcb task report` from their own scheduler or status exporter because their
domain-specific health rules belong in the owning project. Auto-repair is
deliberately scoped: the supervisor must inspect evidence, classify each
failure, fix only tmux-claude-bot bugs on the repair branch, run
`npm run verify:local`, review the diff, and commit verified fixes.
Target-project failures and external service, auth, or network failures are
reported as blockers rather than patched blindly.

---

## 12. Managing the service

The bot is a managed, auto-restarting service. **Restart via the service manager**,
not the dev scripts (the manager respawns it):

```bash
# macOS (launchd)
launchctl kickstart -k "gui/$(id -u)/com.octopusgarage.tmux-claude-bot"
# Linux (systemd --user)
systemctl --user restart tmux-claude-bot
# either OS, via the CLI
tcb service restart
```

To pick up source changes, deploy a fresh build: `node dist/cli.js install` (or
re-run `install.sh`), which rebuilds `dist/` before restarting.

---

## 12. Troubleshooting

- **Bot not responding** → `tcb doctor`; check exactly one bot process is running
  (multiple cause a Telegram 409); check network/proxy reachability.
- **"No session" / can't talk to a project** → `/resume` if it was accidentally
  exited, `/start` for a new agent session, or switch/open the project.
- **Mac keeps sleeping** → enable keep-awake (§5); lid-closed needs `pmset disablesleep`.
- **TUI says "can't reach the control socket"** → the bot isn't running; start the
  service.
- **Machine warm / slow** → `/sysload` or `tcb sysload` to spot a runaway process.
- **Logs** → `tcb logs` (CLI) or `/logs` (chat, owner-only).
- **After `tcb adopt`, typing prints raw escape sequences** (e.g. `d0;1:3u`, `s5;1:3u`)
  → the orphaned claude/codex process was killed by signal before it could reset the
  terminal's enhanced keyboard mode. Run one of these in the affected terminal:
  - `reset` (fastest, clears the screen)
  - `printf '\033[<u\033[<u\033[<u\033[>4;0m\033[?1004l\033[?2004l'` then press Enter
    (resets the mode without clearing the screen)
  - or close the terminal window and open a new one. Current bot versions reset the
    orphan's terminal automatically during takeover, so this only affects sessions
    adopted before the fix.

---

## Acknowledgements

Autopilot's core idea — engineering a feedback loop that watches a coding agent in
its session pane and keeps nudging it forward so it never stalls mid-task — is owed to
**[ForgeFlow](https://github.com/Kingson4Wu/ForgeFlow)**, an earlier project that
pioneered exactly this feedback loop: observe the pane → decide by rules →
recover from stalls → repeat, driving an AI CLI (Claude / Gemini / Codex) through
long programming tasks unattended.

ForgeFlow runs that loop **locally** — one session, in the foreground, at the
machine. tmux-claude-bot carries the same idea to its **remote** form: the loop
becomes a long-running service you start, observe, and steer from anywhere —
Telegram, Feishu/Lark, or a terminal UI — across many projects at once, surviving
restarts, and grown with goal cycling, completion sentinels, human-in-the-loop
gates, usage and wall-clock budgets, and a safety governor. Where ForgeFlow is the
local origin of the loop, this is its remote, chat-native evolution. With thanks.

---

## Keeping this in sync

This manual is the canonical user-facing doc and **must track the features**. When
you add or change a user-facing command or feature:

1. update this file (and the linked [commands.md](commands.md) / [tui.md](tui.md));
2. `tests/docs-contract.test.ts` enforces the enumerable surfaces — every CLI command
   (`tcb …`) must be named here, every chat command must be in commands.md, and this
   manual must link the references — so drift fails CI rather than rotting silently.
