# Project Principles

## Sensitive Data Isolation

All personal privacy, local paths, and credentials must:

1. **Never hardcode** - Do not write to source code, config files, or docs
2. **Use .env only** - Config data goes in `.env` (excluded from git via `.gitignore`)
3. **Use environment variables** - tokens, keys, paths via `process.env` or `loadConfig()`

**Bad examples** (forbidden):
```typescript
// ❌ Forbidden: hardcoded path
const path = "/home/user/project/...";
const path = "/Users/username/anaconda3/bin/tool";

// ❌ Forbidden: hardcoded token
const token = "abc123xyz";

// ❌ Forbidden: username in test data
expect(isPathAllowed("/Users/username/projects", allowed)).toBe(true);
```

**Good examples**:
```typescript
// ✅ Good: environment variable
const path = process.env.HOME;
const binPath = process.env.TOOL_BIN ?? "tool";

// ✅ Good: via config
const { botToken, cdAllowedDirs } = loadConfig();

// ✅ Good: generic paths in tests
expect(isPathAllowed("/home/user/projects", allowed)).toBe(true);
```

### Pre-commit check

Before committing, run this to catch hardcoded personal paths:

```bash
# Check for hardcoded usernames/paths in source, tests, and docs
grep -rn "/Users/[a-z]\+/\|/home/[a-z]\+/" \
  --include="*.ts" --include="*.js" --include="*.md" \
  src/ tests/ docs/ || echo "✅ No personal paths found"
```

If any matches are found, refactor to use `process.env`, `os.homedir()`, or generic test data before committing.

## Process Management

**Only ONE bot instance should run at a time.** Multiple instances cause 409 Conflict with Telegram API.

### launchd is the real manager — restart via launchctl, NOT the scripts

On this machine the bot is installed as a launchd service (`~/Library/LaunchAgents/com.octopusgarage.tmux-claude-bot.plist`, label `com.octopusgarage.tmux-claude-bot`) with **`KeepAlive=true`**. That means:

- **`scripts/stop.sh` does NOT stop it** — launchd immediately respawns the process. Running `start.sh` on top of that spawns a *second* lineage, so you end up with multiple instances fighting over the Telegram long-poll (409). This is a real trap; don't fall into it.
- The launchd wrapper runs `node src/index.ts` directly via the tsx loader (no `tsx watch`), so a restart recompiles the latest source — no `npm run build` needed for it to pick up changes.

**To restart (the correct way):**

```bash
launchctl kickstart -k "gui/$(id -u)/com.octopusgarage.tmux-claude-bot"   # kill + restart the managed instance
launchctl list | grep octopusgarage                                        # confirm it's running (shows current PID)
```

If duplicate instances already exist (e.g. from an accidental `start.sh`), kill the **non-launchd** lineages by PID first (check `ps -o ppid=` — launchd's instance has PPID=1 and matches the PID in `launchctl list`), then `kickstart -k` so launchd's single instance is the only survivor.

### Scripts (manual/dev only — NOT for the launchd-managed instance)

```bash
./scripts/start.sh    # start a foreground/dev instance — only when launchd service is NOT loaded
./scripts/stop.sh     # stop manual instances (no effect on launchd's KeepAlive instance)
./scripts/status.sh   # check running instances
```

### How to identify the correct process

The process runs under `tsx src/index.ts` with `tmux-claude-bot` in its working directory path. Identification uses both:
1. `tsx` command
2. `src/index.ts` argument
3. `tmux-claude-bot` directory path

**NEVER use broad patterns** like `node`, `tsx` alone, or bare process names — they match unrelated processes.

**Rule:** `kill -9 $(pgrep -f "tmux-claude-bot.*src/index.ts")` — always include `tmux-claude-bot` in the pattern.

### Implementation

The project root directory name `tmux-claude-bot` is used as the process identity marker. When running `npm run dev`, the working directory contains this string. The stop/status scripts match on this pattern.

## Development Conventions

- `npm run build` - Compile TypeScript
- `npm run dev` or `tsx src/index.ts` - Start development
- Commands exposed via Telegram Bot menu

## Coverage Threshold Protocol

When the branch coverage threshold blocks a commit, follow this diagnostic order — don't jump straight to writing tests.

**Step 1 — Is coverage simply missing?**
Check the uncovered lines. If they're reachable logic (happy paths, error paths, conditional branches) with no corresponding test, write the test. This is the normal case.

**Step 2 — Is the code itself the problem?**
If a branch can only be covered by contorting the test setup, ask why. Common root causes:

- **Dead defensive code**: a `?? fallback` on a value that's structurally always defined, or an `if (!x) return` guarding something the type system already guarantees. Remove the guard or simplify the expression.
- **Over-coupled code**: a function that does too much, making individual branches hard to isolate. Extract the branch into a named function and test it directly.
- **Untestable boundary**: a file that's mostly wiring (e.g. a bot framework's top-level handler registrations). Consider extracting the logic into a separately testable layer and leaving the wiring thin.

**Step 3 — Is the threshold the problem?**
If a file is genuinely an integration boundary (pure framework glue with no extractable logic), and force-covering it would produce meaningless tests, consult before adjusting the threshold — document the reasoning inline in `vitest.config.ts`.

**The rule**: never write a test whose only purpose is to hit a line. Tests must assert behavior. If you can't assert anything meaningful, the test doesn't belong — the code does.

## Agent skills

### Issue tracker

Issues live in GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Defaults: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` at repo root + `docs/adr/`. See `docs/agents/domain.md`.
