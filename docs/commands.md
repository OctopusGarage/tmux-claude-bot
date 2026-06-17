# tmux-claude-bot Bot Command Reference

The authoritative command list is `BOT_COMMANDS` in `src/core/action-registry.ts`
(registered to the Telegram menu at startup; the Lark help card mirrors it).
`tests/docs-contract.test.ts` asserts every command below stays documented.

## Telegram Menu Commands

| Command | Description |
|---------|-------------|
| `help` | Show all commands |
| `start` | Start the agent |
| `status` | Check agent status |
| `peek` | Capture tmux pane |
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
| `restart` | Restart the agent (Claude `--continue` / Codex `resume --last`) |
| `list_alive_projects` | List alive projects |
| `list_recent_projects` | List recent projects |
| `current_project` | Show current project |
| `add_project` | Add a new project: `add_project <path>` creates it directly; with no path, opens a tap-to-navigate directory browser |
| `new_free` | Create a free (parallel) project: `new_free [label]` opens a bare tmux session decoupled from any path, so multiple agents can run in the same directory |
| `adopt` | Take over an agent (Claude or Codex) running outside tmux |
| `status_install` | Install usage reporting (statusLine snapshot) for /status |
| `queue_status` | Show message queue status |
| `history` | Show recent conversation history (`/history N` for the Nth recent round) |
| `sessions` | List resumable sessions for the current project's agent (tap one to resume) |
| `doctor` | Run install health checks (same checks as `npm run doctor`, redacted for chat) |
| `voice_install` | Install voice transcription (Apple Silicon) |
| `voice_lang` | Set voice recognition language (zh/en/yue/ja/es/auto) |
| `lang` | Set interface language (en/zh/zh-TW/yue/ja/es) |

## Feishu/Lark Group-Binding Commands

These commands manage **project groups** — each Feishu/Lark group is permanently bound
to one workspace so you can type without `@`-mentioning the bot.

| Command | Where | Description |
|---------|-------|-------------|
| `/newgroup <path\|name>` | Private chat (p2p) | Auto-create a private Feishu group bound to the given workspace (path or saved workspace name). Requires the `im:chat` scope; without it a friendly error is shown and `/bind` can be used instead after manually creating the group. |
| `/newfreegroup <path\|name>` | Private chat (p2p) | Like `/newgroup`, but binds the new group to a fresh free session (`tmux_proj_free_<n>`) so it can sit on a directory that already has a group — multiple parallel agents on one workspace. Typed-path counterpart of the 🆓 Parallel group button (which is limited to recent projects). |
| `/bind <path\|name>` | Inside a group | Bind the current group to a workspace (for manually-created groups). |
| `/rebind <path\|name>` | Inside a group | Change an existing group's binding to a new workspace. |
| `/unbind` | Inside a group | Remove this group's binding (group messages are ignored afterwards). |
| `/restore` | Inside a group | Manually trigger re-anchoring: re-asserts the binding's session pointer and recreates the tmux session if it died. |

No typing needed: the help card's **🗂 Project groups** button opens a context-aware menu — in a private chat it lists recent projects (tap to create a bound group); inside a bound group it offers **Restore / Rebind / Unbind**.

The help card's **🆓 Parallel group** button (private chat) creates a *second* group on a recent project, bound to a fresh free session (`tmux_proj_free_<n>`). This is the free-projects counterpart for Feishu: it bypasses the one-workspace-one-group rule so the same directory can host multiple parallel agents, one per group.

**Required Feishu app scopes** for group-binding:
- `im:message.group_msg` — "获取群组中所有消息" (a *sensitive* scope) — receive **all** messages in a bound project group, enabling no-`@` typing. Without it the bot only receives `@`-mentions in groups (`im:message.group_at_msg:readonly`), so a bound group would require `@bot` on every message.
- `im:chat` — let `/newgroup` auto-create the bound private group. Optional: without it `/newgroup` fails gracefully and you use `/bind` instead.

> Note: after adding a scope in 权限管理 you must publish a new version (版本管理与发布) for it to take effect. `im:message.group_msg` is a sensitive scope and may require an extra approval step.

## Non-Command Special Handling

| Message | Condition | Implementation |
|---------|-----------|----------------|
| `/switch_<id>` | `<id>` = 6-char session short id | Resolve alive session by short id → switch current project |
| Any text | Agent **running** | Send to tmux → `waitUntilDone()` rounds (one-time "still running" notice past `MAX_WAIT_DONE_MS`, give up at `MAX_WAIT_DONE_TOTAL_MS`) → clean and reply |

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
