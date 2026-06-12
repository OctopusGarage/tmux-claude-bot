# tmux-claude-bot Bot Command Reference

The authoritative command list is `BOT_COMMANDS` in `src/core/action-registry.ts`
(registered to the Telegram menu at startup; the Lark help card mirrors it).
`tests/docs-contract.test.ts` asserts every command below stays documented.

## Telegram Menu Commands

| Command | Description |
|---------|-------------|
| `help` | Show all commands |
| `start` | Start Claude |
| `status` | Check Claude status |
| `peek` | Capture tmux pane |
| `esc` | Send Escape key |
| `interrupt` | Send Ctrl-C |
| `clear` | Send /clear command |
| `compact` | Send /compact command |
| `enter` | Send Enter key |
| `up` | Send Up arrow |
| `down` | Send Down arrow |
| `tab` | Send Tab key |
| `exit` | Exit Claude |
| `restart` | Restart Claude with --continue |
| `list_alive_projects` | List alive projects |
| `list_recent_projects` | List recent projects |
| `current_project` | Show current project |
| `add_project` | Add a new project |
| `queue_status` | Show message queue status |
| `history` | Show recent conversation history (`/history N` for the Nth recent round) |
| `doctor` | Run install health checks (same checks as `npm run doctor`, redacted for chat) |
| `voice_install` | Install voice transcription (Apple Silicon) |
| `voice_lang` | Set voice recognition language (zh/en/auto) |
| `lang` | Set interface language (zh/en/yue) |

## Feishu/Lark Group-Binding Commands

These commands manage **project groups** — each Feishu/Lark group is permanently bound
to one workspace so you can type without `@`-mentioning the bot.

| Command | Where | Description |
|---------|-------|-------------|
| `/newgroup <path\|name>` | Private chat (p2p) | Auto-create a private Feishu group bound to the given workspace (path or saved workspace name). Requires the `im:chat` scope; without it a friendly error is shown and `/bind` can be used instead after manually creating the group. |
| `/bind <path\|name>` | Inside a group | Bind the current group to a workspace (for manually-created groups). |
| `/rebind <path\|name>` | Inside a group | Change an existing group's binding to a new workspace. |
| `/unbind` | Inside a group | Remove this group's binding (group messages are ignored afterwards). |
| `/restore` | Inside a group | Manually trigger re-anchoring: re-asserts the binding's session pointer and recreates the tmux session if it died. |

**Required Feishu app scopes** for group-binding:
- `im:message.group_msg:readonly` — receive all messages in a bound project group (enables no-`@` typing).
- `im:chat` — let `/newgroup` auto-create the bound private group. Optional: without it `/newgroup` fails gracefully and you use `/bind` instead.

## Non-Command Special Handling

| Message | Condition | Implementation |
|---------|-----------|----------------|
| `/switch_<id>` | `<id>` = 6-char session short id | Resolve alive session by short id → switch current project |
| Any text | Claude **running** | Send to tmux → `waitUntilDone()` rounds (one-time "still running" notice past `MAX_WAIT_DONE_MS`, give up at `MAX_WAIT_DONE_TOTAL_MS`) → clean and reply |

## Claude Running Detection

`checkIfRunning()` is process-based: it asks tmux for the pane's process tree
and looks for a `claude` process (`configResolver.isClaudeRunning`). Screen
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
