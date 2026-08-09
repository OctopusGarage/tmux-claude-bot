# tmux-claude-bot Bot Command Reference

The authoritative command list is `BOT_COMMANDS` in `src/core/command/action-registry.ts`
(registered to the Telegram menu at startup; the Lark help card mirrors it).
`tests/docs-contract.test.ts` asserts every command below stays documented.

## Telegram Menu Commands

| Command | Description |
|---------|-------------|
| `help` | Show all commands |
| `start` | Start the agent |
| `resume` | Resume the last recorded agent session for the current project |
| `status` | Check agent status |
| `peek` | Capture the session pane |
| `esc` | Send Escape key |
| `interrupt` | Send Ctrl-C |
| `clear` | Send /clear command |
| `compact` | Send /compact command |
| `enter` | Send Enter key |
| `up` | Send Up arrow |
| `down` | Send Down arrow |
| `left` | Send Left arrow |
| `right` | Send Right arrow |
| `tab` | Send Tab key |
| `exit` | Exit the agent |
| `restart` | Restart the running agent in-place (Claude `--continue` / Codex `resume --last`) |
| `list_alive_projects` | List alive projects |
| `list_recent_projects` | List recent projects |
| `current_project` | Show current session |
| `add_project` | Add a new project: `add_project <path>` creates it directly; with no path, opens a tap-to-navigate directory browser |
| `new_free` | Create an independent session: `new_free [label]` opens a bare project session decoupled from any path, so multiple agents can run in the same directory |
| `adopt` | Take over an unmanaged agent (Claude or Codex) |
| `recover` | Manually recover all rostered projects after a reboot: recreate each project session + relaunch its agent, resuming the conversation. Automatic boot recovery only resumes unfinished bot-dispatched prompts. Previews then confirms |
| `status_install` | Install usage reporting (statusLine snapshot) for /status |
| `queue_status` | Show message queue status |
| `history` | Show recent conversation history (`/history N` for the Nth recent round) |
| `inputs` | List your recent inputs (`/inputs N` for the last N) — tap one to fetch & edit it |
| `sessions` | List resumable conversations for the current session's agent (tap one to resume) |
| `logs` | Show current-session WARN/ERROR logs from the last hour; `/logs <traceId>` filters to one trace, `/logs N` shows the last N. Owner-only (Lark: 1:1 chat only). |
| `autopilot` | Delegate the current confirmed work to the Loop Supervisor: `/autopilot [requirement]` or `/autopilot delegate [requirement]`. It drives implementation, review, tests, coverage review, configured PR/merge/switch-back gates, and final notification. The chat control panel exposes **Delegate now**, **Review plan first** with **Confirm delegation**, and a supervisor queue view for active work; a queue view is shown only when all Supervisor sessions are occupied. Lark can cancel active-delegated queue items from that queue card. |
| `opportunity` | Review proactive Loop Engineering suggestions: `/opportunity [list\|show\|discuss\|dismiss\|snooze <number\|id>]`; `discuss` opens project-agent discussion. Suggestion cards keep each item readable and offer per-item show/discuss/dismiss actions plus batch actions. After approval, use Autopilot's Continue via supervisor action so execution goes through the same active-delegation pipeline. Owner-only in private chat; Lark also works in a bound project group. |
| `batch` | Batch scheduler status and control. `/batch` → current run status; `/batch start <planId>` → start a plan; `/batch pause\|resume\|stop` → control the active run; `/batch report` → summary. Owner-only (Lark: 1:1 chat only). |
| `dashboard` | Show the global dashboard: every live session plus bot-level totals (version, uptime, queue depth). Owner-only (Lark: 1:1 chat only). |
| `sysload` | Show machine load, thermal state, top CPU, runaway/orphan shells (with a `kill -9` hint), and the current Resource Guardian state. Owner-only (Lark: 1:1 chat only). Guardian control remains the local `tcb resource` CLI surface; no chat button is added. |
| `doctor` | Run install health checks (same checks as `npm run doctor`, redacted for chat) |
| `voice_install` | Install voice transcription (Apple Silicon) |
| `voice_lang` | Set voice recognition language (zh/en/yue/ja/es/auto) |
| `prompt_translate` | Set prompt translation for this source: `/prompt_translate status\|off\|on [from] [to]` |
| `translate_install` | Install local prompt translation dependencies (Argos Translate) |
| `home` | Switch to the home operator session (the default target when no project is selected). Owner-only. |
| `lang` | Set interface language (en/zh/zh-TW/yue/ja/es) |
| `prompts` | Browse saved prompts (read-only; needs PROMPT_MCP_* configured). Owner-only (private chat only). |

## Feishu/Lark Group-Binding Commands

These commands manage **project groups** — each Feishu/Lark group is permanently bound
to one workspace so you can type without `@`-mentioning the bot.

| Command | Where | Description |
|---------|-------|-------------|
| `/newgroup <path\|name>` | Private chat (p2p) | Auto-create a private Feishu group bound to the given workspace (path or saved workspace name). Requires the `im:chat` scope; without it a friendly error is shown and `/bind` can be used instead after manually creating the group. |
| `/newfreegroup <path\|name>` | Private chat (p2p) | Like `/newgroup`, but binds the new group to a fresh numbered independent session so it can sit on a directory that already has a group — multiple parallel agents on one workspace. Typed-path counterpart of the 🧩 Parallel group button (which is limited to recent projects). |
| `/bind <path\|name>` | Inside a group | Bind the current group to a workspace (for manually-created groups). |
| `/rebind <path\|name>` | Inside a group | Change an existing group's binding to a new workspace. |
| `/unbind` | Inside a group | Remove this group's binding (group messages are ignored afterwards). |
| `/restore` | Inside a group | Manually trigger re-anchoring: re-asserts the binding's session pointer and recreates the project session if it died. |

No typing needed: the help card's **🗂 Project groups** button opens a context-aware menu — in a private chat it lists recent projects (tap to create a bound group); inside a bound group it offers **Restore / Rebind / Unbind**.

The help card's **🧩 Parallel group** button (private chat) creates a *second* group on a recent project, bound to a fresh numbered independent session. This bypasses the one-workspace-one-group rule so the same directory can host multiple parallel agents, one per group.

**Required Feishu app scopes** for group-binding:
- `im:message.group_msg` — receive **all** messages in a bound project group,
  enabling no-`@` typing. This is a sensitive scope. Without it the bot only
  receives `@`-mentions in groups (`im:message.group_at_msg:readonly`), so a
  bound group would require `@bot` on every message.
- `im:chat` — let `/newgroup` auto-create the bound private group. Optional: without it `/newgroup` fails gracefully and you use `/bind` instead.

> Note: after adding a scope in the Feishu/Lark developer console, publish a new
> app version for it to take effect. `im:message.group_msg` is a sensitive scope
> and may require an extra approval step.

## Non-Command Special Handling

| Message | Condition | Implementation |
|---------|-----------|----------------|
| `/switch_<id>` | `<id>` = 6-char session short id | Resolve alive session by short id → switch the current session |
| Any text | Agent **running** | Send to the session → `waitUntilDone()` rounds (one-time "still running" notice past `MAX_WAIT_DONE_MS`, give up at `MAX_WAIT_DONE_TOTAL_MS`) → clean and reply |

`/resume` is per-session: use it when the current project's agent was accidentally
exited and you want the same recorded agent flavor and conversation id relaunched.
`/recover` is host-wide: use it after a reboot to restore every project that was
running before.

## Local Send-Only Notifications

Other local projects can send outbound Telegram/Feishu notifications through the
running bot without owning chat credentials:

```bash
tcb notify --source deploy --level error --title "Deploy failed" --body "api health check failed"
printf '%s\n' "line 1" "line 2" | tcb notify --title "Nightly report" --stdin
```

`tcb notify` uses the existing local control socket, targets the configured owner
recipient(s), and does not subscribe the caller to incoming chat messages. Add
`--session <session>` for project-bound Feishu/Lark group routing when a session
is known.

## Local Scheduled Task Reporting

External cron jobs, launchd jobs, article monitors, and radar monitors can report
their run result into the shared daily task ledger:

```bash
tcb task report --id "radar:daily:2026-07-27" --source radar-monitor \
  --name "daily radar monitor" --scheduled-at "2026-07-27T03:00:00Z" \
  --status failed --error "report file was not generated"
```

The daily audit service actively discovers tmux-claude-bot-owned launchd jobs
and loop-engineering schedules, merges that expected-task list with this ledger
for the previous Singapore day, notifies Telegram/Feishu with the success and
failure list, then queues agent-supervised repair for failed, missing, or
timed-out tasks when auto-repair is enabled. External scheduled systems should
use `tcb task report` from their own scheduler or status exporter.
Use `tcb task audit --force` to run the same audit immediately through the
running bot's control socket; add `--json` when another script needs the fired /
failure counts.
Repair agents should update the same task id after verification with
`--repair-status fixed`, `--repair-status superseded`,
`--repair-status not-reproducible`, or `--repair-status blocked`.

Button and TUI shortcuts ask for confirmation before `exit`, `restart`, `clear`, or
`compact`. Known typed slash commands are treated as explicit bot intent and run
directly. Unknown slash-prefixed text is forwarded to the running agent, so agent
built-ins such as Codex `/goal ...` continue to work through chat.

## Agent Running Detection

`checkIfRunning()` is process-based: it asks tmux for the pane's process tree
and looks for the live agent process — `claude` or `codex` (`configResolver`'s
`isClaudeRunning` / `isCodexRunning`, routed by the live-detected kind). Screen
scraping for prompts/spinners was removed — it was theme-dependent and gave
false positives.

## sendKeys Behavior

Messages sent to tmux split by newline:
- Each line sent separately (no Enter)
- Only last line gets Enter after it

Example sending `line1\nline2\nline3`:
1. Send `line1` (no Enter)
2. Send `line2` (no Enter)
3. Send `line3` + Enter

## TmuxBridge Core Methods

| Method | Implementation |
|--------|----------------|
| `sendKeys(text)` | `tmux send-keys -t target text Enter` (split by line, Enter on last) |
| `sendRawKey(key)` | `tmux send-keys -t target key` |
| `sendExit()` | `C-c` -> 300ms -> `/exit` + Enter |
| `capturePane()` | `tmux capture-pane -p -J -t target` |
