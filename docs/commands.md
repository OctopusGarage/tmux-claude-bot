# tmux-claude-telegram Bot Command Reference

## Telegram Menu Commands (16)

| Command | Description | Status Restriction |
|---------|-------------|-------------------|
| `help` | Show all commands | None |
| `start` | Start Claude | Claude **not running** |
| `status` | Check Claude status | None |
| `peek` | Capture tmux pane | None |
| `esc` | Send Escape key | Claude running |
| `interrupt` | Send Ctrl-C | Claude running |
| `exit` | Exit Claude | Claude running |
| `restart` | Restart Claude with --continue | Claude running |
| `clear` | Send /clear command | Claude running |
| `new` | Send /new command | Claude running |
| `enter` | Send Enter key | Claude running |
| `up` | Send Up arrow | Claude running |
| `down` | Send Down arrow | Claude running |
| `pwd` | Show current directory | Claude **not running** |
| `switch` | Switch to directory | Claude **not running** |
| `switch_workdir` | List projects | Claude **not running** |

## Non-Command Special Handling

| Message | Condition | Implementation |
|---------|-----------|----------------|
| `/switch_<N>` | Claude **not running** | Parse index -> `cd <project path>` |
| Any text | Claude **running** | Send to tmux -> `waitUntilDone()` -> clean and reply |
| `cd <path>` | Claude **not running** | Check `cdAllowedDirs` -> `cd <path>` |

## Claude Running Detection

`checkIfRunning()` checks the last line of tmux pane:
- Contains `➜` or `❯` -> shell prompt visible -> Claude **not running**
- No shell prompt -> Claude **running**

## cdAllowedDirs Path Checking

`/switch_<N>` path checks support `~` expansion:
- Config: `~/programming`
- Check: `/home/user/programming/xxx`.startsWith(`/home/user/programming`)

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
