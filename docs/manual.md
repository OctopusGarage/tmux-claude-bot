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
**tmux** sessions on your computer, and lets you **drive it remotely**:

- from **Telegram** and/or **Feishu/Lark** on your phone (text + voice), and
- from a **terminal UI** (`tcb tui`) at the PC.

Each project gets its own tmux session; you can run several in parallel, switch
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
- **Send any text** → it's typed into the current project's agent; the reply comes
  back when the agent finishes. **Voice messages** are transcribed and sent as text.
- Replies show the agent's output; long output is paged.

### The control panel (buttons)
Every reply carries a control panel (Telegram inline keyboard / Feishu card):
interrupt (esc) · enter · the lifecycle keys (restart / clear / compact / exit) ·
peek · history · projects · queue. It adapts to whether an agent is running.

### Commands, by area (see commands.md for the table)
- **Session**: `/start` `/status` `/peek [N]` `/history [N]` `/inputs [N]` (recent
  inputs — tap one to re-run) `/restart` `/clear` `/compact` `/exit`.
- **Projects**: create / switch / remove projects; `/recover` to relaunch agents that
  were running before a reboot.
- **Feishu project groups**: bind a Feishu group to one project so you switch projects
  by switching groups (no `/cd`); works without `@bot`.
- **Settings**: `/lang` (UI language), voice language, status-line install.
- **Diagnostics**: `/dashboard` (every session at a glance) · `/sysload` (machine
  load / heat / runaway processes) · `/logs` · `/doctor`. Owner-only; on Feishu these
  are 1:1-chat only.

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
recent input, `a` attach into the real tmux pane, `q` quit. Press `?` for all keys.

---

## 5. Keeping the Mac awake

A sleeping Mac drops the bot off your phone (nothing can wake an outbound long-poll).
Opt in during setup (or `tcb setup --reconfigure`): while the bot runs it holds a
`caffeinate -i -s` assertion (idle-sleep blocked, pinned on AC). It does **not** cover
a closed lid — for that also run `sudo pmset -a disablesleep 1`. `tcb doctor` reports
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
| `tcb send <project> "<prompt>"` | send a prompt to a project's agent; **waits for the reply** (`--no-wait` / `--timeout <s>`) |
| `tcb peek <project>` | print a snapshot of its tmux pane |
| `tcb open <project>` | switch to / start a project (incl. stopped ones) |
| `tcb control <project> <esc\|enter\|restart\|…>` | send a control action |
| `tcb skill install` | install the AI operating skill into Claude Code / Codex (`--tool` for one) |

This is what the **AI skill** (`skills/tmux-claude-bot/SKILL.md`, the AI-facing
companion to [docs/agents/usage-guide.md](agents/usage-guide.md)) drives — so an agent
in Claude Code / Codex can operate the system in natural language. The installer runs
`tcb skill install` by default (opt out with `TCB_SKIP_SKILL=1`); re-run it any time to
refresh the skill. It lands at `~/.claude/skills/tmux-claude-bot/SKILL.md` and
`~/.codex/prompts/tmux-claude-bot.md`.

`npm run <dev\|tui\|doctor\|service:*>` are the dev-profile equivalents.

---

## 7. Managing the service

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

## 8. Troubleshooting

- **Bot not responding** → `tcb doctor`; check exactly one bot process is running
  (multiple cause a Telegram 409); check network/proxy reachability.
- **"No session" / can't talk to a project** → `/start`, or switch/open the project.
- **Mac keeps sleeping** → enable keep-awake (§5); lid-closed needs `pmset disablesleep`.
- **TUI says "can't reach the control socket"** → the bot isn't running; start the
  service.
- **Machine warm / slow** → `/sysload` or `tcb sysload` to spot a runaway process.
- **Logs** → `tcb logs` (CLI) or `/logs` (chat, owner-only).

---

## Keeping this in sync

This manual is the canonical user-facing doc and **must track the features**. When
you add or change a user-facing command or feature:

1. update this file (and the linked [commands.md](commands.md) / [tui.md](tui.md));
2. `tests/docs-contract.test.ts` enforces the enumerable surfaces — every CLI command
   (`tcb …`) must be named here, every chat command must be in commands.md, and this
   manual must link the references — so drift fails CI rather than rotting silently.
