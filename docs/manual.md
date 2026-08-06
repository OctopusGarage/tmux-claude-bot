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
`tcb doctor`. The installer provisions the isolated Home Operator workspace and
installs the default AI tool surfaces there by default: the Home Operator skill
for Claude/Codex plus MCP profile descriptors. It also removes stale global
skill copies; use `TCB_SKIP_MCP=1` only when you intentionally manage these
surfaces yourself. `TCB_SKIP_AI_TOOLS=1` is the clearer install-time opt-out.
Global Claude/Codex skill installation is explicit: run
`tcb skill install --scope global` only when you want that convenience outside
the operator workspace.

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

### Governed System Prompts (`tcb prompts governed`)

Inspect and evaluate repo-owned automation prompts separately from the external
prompt library:

- `tcb prompts governed list [--json]` — list governed prompt metadata.
- `tcb prompts governed show <promptId> [--json]` — show owner, action scope,
  risk, eval expectation, and task-kind mapping for one governed prompt.
- `tcb prompts governed render <promptId> [--fixture default] [--json]` —
  render a supported governed prompt with a built-in fixture so prompt prose can
  be reviewed without hand-writing a full WorkOrder JSON.
- `tcb prompts governed check [--json]` — run deterministic prompt-governance
  metadata checks.
- `tcb prompts governed eval (--all|<promptId>) [--output <file>]` — generate an
  active-agent AI eval task prompt. This command does not call model-provider
  APIs; send the generated task to the current Claude Code / Codex agent surface.

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

For the complete maintained CLI command and option surface, see
[docs/cli-reference.md](cli-reference.md). For MCP profile setup, see
[docs/mcp.md](mcp.md).

| Command | What it does |
|---------|--------------|
| `tcb run` | run the bot in the foreground (what the service runs) |
| `tcb setup` / `tcb setup:lark` | guided setup wizard / add Feishu via QR |
| `tcb doctor` | health checks against the install |
| `tcb config list\|get\|set` | inspect personal `.env` configuration with secrets redacted, and edit allowlisted non-secret keys |
| `tcb automation status\|pause\|resume` | inspect or toggle high-cost background automation: Loop Engineering, Daily Task Audit, Runtime Guardian, and Batch Scheduler |
| `tcb dashboard` | global status snapshot of all sessions (`--json` for raw) |
| `tcb autopilot <project> [delegate [requirement]\|cancel]` | delegate clarified current work to the Loop Supervisor, or cancel active delegated work (`--json` for raw usage/result) |
| `tcb batch <load\|export\|start\|status\|report\|pause\|resume\|stop>` | manage batch scheduler plans and runs |
| `tcb loop validate\|tick\|run <file>` / `tcb loop targets\|reports\|backlog\|skills …` | validate a Loop Engineering config, check due projects, pause/resume configured targets, run command-backed projects, list reports/backlog, refresh catalog skills to pinned refs, or reconcile approved skills (`--json` for raw; `tick` also supports `--now`) |
| `tcb sysload` | machine load, thermal state, top CPU, runaway shells |
| `tcb tui` | the terminal control panel (needs the bot running) |
| `tcb recover` | relaunch agents that were running before a reboot |
| `tcb logs` | query structured logs; use `--since 30m`, `--component <prefix>`, `--run-id <id>`, `--grep <text>`, and `-n <count>` to keep current-run diagnostics quiet |
| `tcb install` | provision the managed service into the stable dir |
| `tcb service <install\|uninstall\|status\|pause\|resume\|restart\|logs>` | manage the auto-restarting service |

**Drive the bot from the shell** (one-shot control-socket clients — for scripts or an
AI agent; need the bot running, all accept a project by name and `--json`):

| Command | What it does |
|---------|--------------|
| `tcb sessions` | list the running sessions |
| `tcb projects` | list projects (live + recent); `tcb open <name>` to start one |
| `tcb notify [text...]` | send a local send-only notification through the configured Telegram/Feishu bot; use `--title`, `--body` or `--stdin`, `--channel telegram\|lark\|both`, `--level info\|success\|warning\|error`, `--source <name>`, optional `--session <session>` for project-bound Feishu routing, and repeatable `--attach <file>` |
| `tcb task report --id <id> --source <source> --name <name> --scheduled-at <time> --status <status>` | record an external scheduled task in the shared daily task ledger; add `--repair-status fixed\|superseded\|not-reproducible\|blocked` after repair review |
| `tcb send <project> "<prompt>"` | send a prompt to a project's agent; **waits for the reply** (`--no-wait` / `--timeout <s>`) |
| `tcb peek <project>` | print a snapshot of its session pane |
| `tcb open <project> [--agent claude\|codex]` | switch to / start a project; `--agent` selects the start command when the project is stopped |
| `tcb open-worker <session> <path> [--agent claude\|codex]` | start an isolated automation worker at a project path without switching the human current project; session must be named `<projectSessionPrefix>loop-worker-*`; intended for Loop Supervisor / recovery scripts |
| `tcb adopt [pid]` | list unmanaged claude/codex processes, or adopt one by PID (stops it, resumes under management) |
| `tcb control <project> <esc\|enter\|resume\|restart\|…>` | send a control action; `restart` / `clear` / `compact` / `exit` prompt for confirmation (`--yes` for scripts) |
| `tcb attach <file...>` | send an image/file to the session's chat; defaults to the current session (`--to <project>`, `--caption <text>`) |
| `tcb ai-tools install\|status` | install or inspect default role-scoped AI tool surfaces in the Home Operator workspace; install also removes stale global skill copies |
| `tcb capabilities list\|status\|install\|update` | inspect curated external skill/tool dependencies used by task families; `install --default` prints the approved skill plan and `update --default` prints the refresh/sync path |
| `tcb skill install\|status\|uninstall` | manage Home Operator skill scopes: default `operator-home`, optional `--scope global`, `--scope all`, and `--tool` for one agent |
| `tcb mcp <observer\|home>` | run a role-scoped MCP server over stdio |
| `tcb mcp install [--profile observer\|home]` | generate MCP profile descriptors in the Home Operator workspace |

`tcb notify` is for other local projects that need outbound alerts but do not need
to receive chat messages. It talks to the already-running bot over the local control
socket, so those projects do not need Telegram tokens, Feishu credentials, chat ids,
or SDK dependencies. It sends to the configured owner targets only. Attachments are
uploaded by the active Telegram/Feishu adapter, for example:

```bash
tcb notify --channel lark --title "Radar ready" --body "Daily report attached" \
  --attach report.md --attach report.html
```

Use `tcb config list --json` before editing `.env` by hand. It redacts tokens
and app secrets, and `tcb config set <key> <value>` only accepts allowlisted
non-secret keys. Use `tcb setup --reconfigure` or `tcb setup:lark` for Telegram
tokens, Feishu/Lark app credentials, and owner identifiers.

Use `tcb automation status` to see the expensive background loops at a glance.
`tcb automation pause loop` sets `LOOP_ENGINEERING_TICK_MS=0` and records the
previous cadence in state; `tcb automation resume loop` restores it. The same
pattern works for `task-audit`, `runtime-guardian`, and `batch`.

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

This is what the **Home Operator skill** drives, so an agent in Claude Code /
Codex can operate the system in natural language. The bundled source lives at
`skills/tcb-home-operator/SKILL.md`. Managed install does not publish it into
global Claude/Codex discovery by default; the default operator context is the
isolated Home Operator workspace. Run `tcb ai-tools install` to refresh the
default operator-home skill and MCP descriptors together, or
`tcb skill install --scope global` only when you
explicitly want the global convenience copy at
`~/.claude/skills/tcb-home-operator/SKILL.md` and
`~/.codex/prompts/tcb-home-operator.md`. Use `tcb skill status` to inspect the
operator-home and global copies, and `tcb skill uninstall --scope global` to
remove both current and legacy global skill names.

`npm run <dev\|tui\|doctor\|service:*>` are the dev-profile equivalents.

**Observer MCP server.** `tcb mcp observer` exposes read-only tools for AI clients
that support local stdio MCP servers:

- `tcb.observer.status`
- `tcb.observer.projects`
- `tcb.observer.sessions`
- `tcb.observer.queue`
- `tcb.observer.logs_query`
- `tcb.observer.loop_reports_list`
- `tcb.observer.daily_task_audit`
- `tcb.observer.runtime_guardian_findings`

These tools do not send prompts, delegate work, repair code, merge PRs, or
modify state. They read through the local control socket or persisted Loop report
state and return structured `ok`, `role`, `capability`, `data`, `evidence`, and
`blockedReason` fields.

**Home MCP server.** `tcb mcp home` exposes the Observer tools plus controlled
Home Operator tools:

- `tcb.home.send_prompt`
- `tcb.home.delegate_autopilot`

These Home tools require an explicit target session and call the existing
control socket operations. They do not expose arbitrary shell execution, direct
file edits, PR merge operations, or WorkOrder internals.

Run `tcb ai-tools install` to refresh both default skill and MCP files, or
`tcb mcp install` to generate only profile descriptor files under the Home
Operator workspace. The installer does not edit private global client
configuration files; point Claude Code, Codex, or another MCP client at the
generated descriptor explicitly.

---

## 7. Autopilot

Autopilot means **supervisor-backed delegation**. After a task has been clarified
in a project session, use `/autopilot [requirement]`,
`/autopilot delegate [requirement]`, `tcb autopilot <project> [requirement]`, or
the Autopilot buttons to hand the work to the reserved Loop Supervisor.

If the requirement is omitted, the supervisor treats the current session context
and repository state as the source of truth: live pane, git status, recent
commits, existing PRs, and prior verification output. Before substantive
execution, the supervisor records a delegation brief with the objective,
checklist, acceptance criteria, stop conditions, non-goals, risks, and
verification plan. Clear bounded work proceeds from that brief; broad,
ambiguous, or high-risk work blocks or asks for clarification instead of
guessing.

It then drives the target project agent until the implementation is complete or
a real blocker is proven. Before finalizing, it must review the diff, run
relevant verification, assess coverage for touched risk paths, use existing
deterministic or agent-backed evals when justified, record a final plan review,
and follow the configured PR/merge/switch-back policy.

The old Autopilot keep-alive and goal-cycle implementation has been removed.
The bot does not expose enable/disable, goal picker, global keep-alive, or
human-gate controls.

### Telegram button controls

Open the inline control panel and use one of the Autopilot buttons:
**Delegate now** starts the supervisor WorkOrder immediately, while
**Review plan first** shows the objective, checklist, acceptance criteria, stop
conditions, non-goals, risks, and verification plan with a **Confirm
delegation** button. Once confirmed, the command returns a run id immediately;
final status is written under `loop-runs/...` and sent through the configured
Telegram/Feishu notification route. If no supervisor session is available, the
blocked reply includes a supervisor queue view so the owner can see active
WorkOrders; Lark queue cards can cancel active-delegated tasks, but do not expose
cancellation for scheduled system WorkOrders.

### Terminal TUI controls

Use `tcb autopilot <project> [requirement]` from the shell. This uses the same
control socket as the chat adapters and queues the same supervisor WorkOrder.

### Lark/Feishu button controls

In a project-bound group or private chat, tap **Delegate now**, tap **Review
plan first** and then **Confirm delegation**, or send `/autopilot [requirement]`.
Feishu notifications are routed to the bound project group when one exists,
otherwise to the owner fallback configured for the bot.

---

## 8. Loop Engineering

For the intelligent automation terminology map and maintenance boundaries, see
`docs/intelligent-automation.md`.

Loop Engineering runs recurring maintenance work from a YAML config. It is off by
default; enable it by setting:

```bash
LOOP_ENGINEERING_CONFIG_FILE=/path/to/loop.yml
LOOP_ENGINEERING_TICK_MS=300000   # 0 disables the managed loop
```

Set `enabled: false` on a project, workspace, or `prReview.repositories` entry
to pause all schedules for that configured target while preserving its schedule,
GitHub account, branch, prompt, and repair policy for later re-enable.

Each scheduled project chooses a runner:

- `runner.kind: system` (default) runs deterministic local commands, optional queued
  agent tasks, verification, eval, commit, and writes `report.md` / `summary.json`.
  Before each selected optimization round, the managed loop queues `/compact` for
  the project agent session, then sends the round task.
- `runner.kind: agent-supervised` sends a bounded WorkOrder to a reserved Loop
  Supervisor agent. The supervisor can inspect failures, adapt the next action, and
  finish with a required marker + JSON summary. Reports are written as
  `supervisor.md` / `supervisor-summary.json`, worker-internal `eval-report.json`,
  with `handoff.md` / `handoff.json` for resumable next-round state. When commit or PR publishing is
  enabled, the managed loop still performs final system gates after the supervisor
  reports completion: clean worktree, expected switch-back branch, PR lookup,
  mergeability, and completed successful/neutral/skipped CI checks. If
  `pullRequest.autoMerge: true` is configured, the system gate merges the PR after
  those checks pass, using `pullRequest.mergeMethod` (`squash`, `merge`, or
  `rebase`; default `squash`), switches to `pullRequest.switchBack`, and
  rebases it onto `origin`. Set `pullRequest.githubAccount` when the repository needs a
  specific GitHub CLI identity; every GitHub CLI command for that WorkOrder,
  including `gh api` security-alert checks and PR create/view/merge commands,
  uses a command-local `GH_TOKEN` from `gh auth token --user <account>` instead
  of the global active `gh` account. If the supervisor response misses the
  required final marker, the loop treats the scheduled fire as unfinished and
  retries it on a later tick instead of marking it complete. The WorkOrder
  instructs the supervisor to use `tcb open-worker <session> <path>` and then
  run `tcb control <worker-session> compact --yes` before each delegated
  optimization round. These loop worker sessions are reserved automation
  infrastructure and do not replace or receive prompts from the ordinary human
  project chat session. When the WorkOrder reaches accepted `completed` state,
  the worker tmux session is killed immediately because it is no longer reusable.
  Workers without accepted completion evidence are reclaimed by the session idle
  reaper after `SESSION_IDLE_REAPER_LOOP_WORKER_MAX_IDLE_MS` (default 6 hours)
  instead of the ordinary project-agent threshold.
  When the supervisor reports completion but the bot's system gate finds a
  recoverable validation failure, such as a dirty worktree, wrong switch-back
  branch, missing PR cleanup, pending/failing PR checks, or PR hygiene issue, the
  same WorkOrder stays owned by the supervisor. The bot sends a bounded revision
  prompt with the exact validation failures and re-runs the system gate after the
  supervisor responds. Non-recoverable platform failures, such as missing GitHub
  write permission or missing system adapters, fail directly with the concrete
  blocker instead of looping.
  `tcb loop reports list --json` includes the parsed eval outcome when the report
  artifact exists, and the text report list shows `eval=<status>`. Rejected eval
  outcomes are also visible to Daily Task Audit and Runtime Guardian through the
  persisted `system-gate.json` evidence.
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
  `pullRequestReview` is a project-scoped cron job. It reuses that project's
  session and supervisor, reviews loop-created PRs for that project from the
  configured lookback window, requires the configured number of clean review
  passes, and only auto-merges when CI/status checks and mergeability are
  acceptable. Set `mergeMethod` to `squash`, `merge`, or `rebase` to choose the
  GitHub CLI merge mode; the default is `squash`. It is intended to catch
  introduced bugs and operational risks, not to block on style nits.
  `prReview.repositories` is the repository-scoped all-open-PR processor. It is
  configured outside `projects` and can review every open PR in a GitHub
  repository, optionally repair small same-repository PR branch issues, then
  merge eligible PRs using its configured `mergeMethod` (`squash`, `merge`, or
  `rebase`; default `squash`). Use `pullRequestReview` for loop-created PRs
  belonging to a configured project or workspace; use `prReview.repositories`
  when the desired target is a repository's complete open PR queue.
  `harnessAuto` is a higher-level project-health orchestration job. It has one
  schedule and one run id, then chooses from enabled subtasks such as
  architecture, bug-fix, test-coverage, and security-maintenance after assessing
  the current project state. Use it when you want one periodic health loop and
  one PR instead of several independent PRs. The supervisor must record the
  health signals it checked, selected and skipped subtasks, verification, and
  stop condition. It must not run every configured subtask mechanically or keep
  optimizing after the configured health score / no-confirmed-issues condition
  is met.
  Code-changing WorkOrders also support `cleanupPolicy`:
  `conservative` (default) fixes only confirmed issues and directly related dead
  code; `balanced` may remove unsupported stale paths that create real
  maintenance confusion; `aggressive` may remove obsolete compatibility paths,
  duplicate entry points, transition code, and stale docs after evidence and
  verification. Set it at the project/workspace level or override it under
  `bugFix`, `testCoverage`, `securityMaintenance`, `harnessAuto`, or workspace
  `architecture`.
  `opportunityDiscovery` is a read-only proposal job. It asks the supervisor to
  inspect concrete project evidence, find a small number of high-value feature or
  optimization opportunities, and write `opportunities.json`; it must not edit
  files, create branches, commit, push, or open PRs. The bot stores and dedupes
  suggestions, then sends Telegram/Feishu messages with `/opportunity` commands.
  Use `/opportunity discuss <id>` to prepare a decision conversation and a
  delegation brief draft with acceptance criteria, non-goals, risks, stop
  conditions, and verification plan. Then use Autopilot / Continue via
  supervisor to hand confirmed work to the Loop Supervisor. Use `/opportunity
  dismiss <id>` when it should not be pursued.
  Feishu/Lark suggestion cards include readable per-item problem, value, and
  approach summaries plus view, discuss, and dismiss actions for each
  suggestion. Telegram uses per-suggestion discuss/dismiss buttons only while
  each callback payload fits Telegram's 64-byte `callback_data` limit; otherwise
  use the typed `/opportunity` commands shown in the message.
- `workspaces` define coordinated multi-repository jobs. Use this when
  repositories should be evaluated together, such as a frontend/backend pair in
  the same product directory. A workspace job is one scheduled WorkOrder with one
  run id, but each repository keeps its own branch and PR. The supervisor must
  inspect cross-repository contracts, change only the repositories that need
  changes, link related PRs, and verify every repository is clean and back on its
  configured switch-back branch before finalizing. Workspaces can define the same
  maintenance task families as projects: `architecture`, `bugFix`,
  `testCoverage`, `securityMaintenance`, `harnessAuto`, `opportunityDiscovery`,
  and `pullRequestReview`. The internal job kind `workspace-architecture` exists
  only for historical run-id compatibility; it does not mean workspace support is
  limited to architecture.

Enable the supervisor only when at least one project uses `agent-supervised`:

```bash
LOOP_SUPERVISOR_ENABLED=true
LOOP_SUPERVISOR_AGENT=codex       # codex (default) or claude
LOOP_SUPERVISOR_DIR=              # blank -> <state-dir>/loop-supervisor
LOOP_SUPERVISOR_POOL_SIZE=1       # >1 starts tmux_proj_loop-supervisor-1/-2/...
LOOP_SUPERVISOR_RESET_BEFORE_WORK_ORDER=clear
LOOP_SUPERVISOR_WORKTREE_ISOLATION=isolated # isolated | source | auto
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
    cleanupPolicy: conservative
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
      githubAccount: example-user
    bugFix:
      enabled: true
      schedule: "45 10 * * *"
      branch: loop/tmux-claude-bot/bug-fix
      cleanupPolicy: conservative
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
    harnessAuto:
      enabled: true
      schedule: "50 16 * * *"
      branch: loop/datavibe-backend/harness-auto
      cleanupPolicy: balanced
      maxRounds: 4
      strategy: health-first
      tasks:
        - kind: bug-fix
          enabled: true
          weight: 40
        - kind: security-maintenance
          enabled: true
          weight: 30
        - kind: test-coverage
          enabled: true
          weight: 20
        - kind: architecture
          enabled: true
          weight: 10
      stopWhen:
        healthScoreAtLeast: 95
        noConfirmedIssues: true
      prompt: >
        Assess current project health first, then choose only justified
        subtasks. Keep the run in one PR and stop when the configured health
        condition is met.
    opportunityDiscovery:
      enabled: true
      schedule: "20 10 * * *"
      scheduleJitterMinutes: 15
      maxSuggestions: 3
      minConfidence: medium
      categories:
        - product-feature
        - workflow-automation
        - developer-experience
        - reliability
      cooldownDays: 14
      requireEvidence: true
      prompt: >
        Propose only grounded work with clear owner value. Include evidence,
        risks, acceptance checks, and a concise implementation approach.
    pullRequestReview:
      enabled: true
      schedule: "0 1 * * *"
      lookbackHours: 48
      consecutivePasses: 2
      autoMerge: true
      mergeMethod: squash
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
    runner:
      kind: agent-supervised
    cleanupPolicy: conservative
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
    harnessAuto:
      enabled: true
      schedule: "50 16 * * *"
      maxRounds: 4
      strategy: health-first
      stopWhen:
        healthScoreAtLeast: 95
        noConfirmedIssues: true
    opportunityDiscovery:
      enabled: true
      schedule: "20 10 * * *"
      maxSuggestions: 3
      minConfidence: medium
      categories: [product-feature, workflow-automation, developer-experience]
      cooldownDays: 14
    pullRequestReview:
      enabled: true
      schedule: "0 9 * * *"
      lookbackHours: 36
      consecutivePasses: 2
      autoMerge: false
```

Supervisor dispatch still uses this bot's managed Claude Code / Codex sessions. It
does not call model-provider APIs directly. If the supervisor session is missing or
the queue cannot accept the WorkOrder, the scheduler keeps the fire eligible for a
later retry instead of consuming that cron occurrence.

Workspace scheduling is controlled by the top-level `workspace.runner`; the
legacy `architecture.runner` field is retained only for architecture-job
compatibility. Non-architecture workspace tasks such as `bugFix`,
`testCoverage`, `securityMaintenance`, `harnessAuto`, `opportunityDiscovery`,
and `pullRequestReview` inherit the workspace runner and are not architecture
subfeatures.

Useful commands:

- `tcb loop validate <file> [--json]`
- `tcb loop tick <file> [--now <iso>] [--json]`
- `tcb loop targets list <file> [--json]`
- `tcb loop targets disable <file> <project|workspace|repo> <id> [--json]`
- `tcb loop targets enable <file> <project|workspace|repo> <id> [--json]`
- `tcb loop run <file> <projectId> [--json]` for command-backed/manual runs
- `tcb loop reports list [--json]` for command-backed reports and supervisor reports
- `tcb loop backlog list [--all] [--json]`
- `tcb loop skills refresh <file> [--write] [--json]`
- `tcb capabilities status --task architecture [--json]` to see the external
  skills/tools a task family expects
- `tcb capabilities install --default [--json]` to print the curated approved
  skill plan before running `tcb loop skills sync <file>`
- `tcb capabilities update --default [--json]` to print the refresh path before
  running `tcb loop skills refresh <file> --write`

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
- It is excluded from project work targets; `tcb send` and relay commands refuse
  it as a target to avoid loops.
- The dashboard shows it as "home operator", not a work project.

---

## 10. Batch scheduler

Run a set of agent tasks across multiple projects on a schedule (cron, one-shot, or immediate).
Use `BATCH_SCHEDULER_TICK_MS`, `BATCH_SCHEDULER_QUOTA_PCT`, and
`BATCH_SCHEDULER_REPROBE_MS` for runtime tuning.

**Quick start:**

1. Define a YAML plan file (see `docs/examples/batch-plan.example.yml` for the full schema).
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
discovered scheduled tasks and explicit task records. It is the bot's
self-check/self-healing task for hosted schedules: launchd service health, Loop
Engineering jobs, and local monitors that report through `tcb task report`. It
can ask the Loop Supervisor to repair bot-owned failures on a configured branch,
then sends the final success/failure/missing summary with the repair dispatch
result to Telegram and/or Feishu.

```bash
TASK_AUDIT_ENABLED=true
TASK_AUDIT_SCHEDULE=0 2 * * *     # UTC; 10:00 Singapore time
TASK_AUDIT_TICK_MS=300000
TASK_AUDIT_CHANNEL=both           # telegram | lark | both
TASK_AUDIT_AUTO_REPAIR=true
TASK_AUDIT_REPO_PATH=/path/to/tmux-claude-bot
TASK_AUDIT_REPAIR_BRANCH=dev
TASK_AUDIT_REPAIR_WORKTREE_ISOLATION=isolated
```

Run the same audit immediately through the running bot:

```bash
tcb task audit --force
tcb task audit --force --json
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

The audit also checks its own previous execution. If the previous daily audit
failed, timed out, could not dispatch auto-repair, or only partially delivered
its final notification, the next audit records a `daily-audit:self:<scheduledAt>`
self-repair item and routes it through the same auto-repair pipeline. Active
self-repair items are not re-dispatched while their repair status is `running`,
which prevents recursive repair storms.

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
- **Logs** → `tcb logs --since 1h --run-id <id>` (CLI) or `/logs` (chat,
  owner-only). Chat `/logs` defaults to current-session WARN/ERROR records from
  the last hour; use `/logs N` for the last N current-session records or
  `/logs t_<trace>` for one trace.
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
