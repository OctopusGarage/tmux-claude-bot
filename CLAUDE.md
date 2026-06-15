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
- Since the runtime instance lock (`src/core/instance-lock.ts`), a second instance sharing the same state dir refuses to start with an `InstanceLockHeldError` naming the holder pid — the trap now fails fast instead of 409-ing. Instances with different `TCB_STATE_DIR`s are not protected.
- The launchd wrapper runs the bundled CLI: `node dist/cli.js run`. A restart runs whatever `dist/` was **last built** — so to pick up source changes the managed copy must be rebuilt (`install.sh` runs `npm run build` on every deploy). This is the deploy path; a bare `kickstart` alone will NOT pick up un-built source edits.

**To restart (the correct way):**

```bash
launchctl kickstart -k "gui/$(id -u)/com.octopusgarage.tmux-claude-bot"   # kill + restart the managed instance
launchctl list | grep octopusgarage                                        # confirm it's running (shows current PID)
```

If duplicate instances already exist (e.g. from an accidental `start.sh`), kill the **non-launchd** lineages by PID first (check `ps -o ppid=` — launchd's instance has PPID=1 and matches the PID in `launchctl list`), then `kickstart -k` so launchd's single instance is the only survivor.

### Linux: systemd --user is the manager

On Linux the bot is installed as a systemd `--user` service (unit
`tmux-claude-bot`, `Restart=always` — the launchd `KeepAlive` analogue), with
`loginctl enable-linger` so it survives logout on headless servers.

**To restart (the correct way):**

    systemctl --user restart tmux-claude-bot   # reloads the last-built dist/
    systemctl --user status tmux-claude-bot     # confirm it's running
    journalctl --user -u tmux-claude-bot -f     # live logs

As with launchd, `Restart=always` means `scripts/stop.sh` won't keep it down;
manage it via `systemctl --user` (or `npm run service:pause|resume|restart`,
which dispatch by OS). The instance is identified the same way:
`tmux-claude-bot.*(src/index.ts|dist/cli.js)`.

### Scripts (manual/dev only — NOT for the launchd-managed instance)

```bash
./scripts/start.sh    # start a foreground/dev instance — only when launchd service is NOT loaded
./scripts/stop.sh     # stop manual instances (no effect on launchd's KeepAlive instance)
./scripts/status.sh   # check running instances
```

### How to identify the correct process

The managed (launchd) instance runs `node dist/cli.js run`; a dev instance (`npm run dev`) runs `tsx src/index.ts`. Both carry `tmux-claude-bot` in the path. Identification uses two parts:
1. `tmux-claude-bot` directory path
2. the entrypoint argument — `dist/cli.js` (managed) or `src/index.ts` (dev)

**NEVER use broad patterns** like `node`, `tsx` alone, or bare process names — they match unrelated processes.

**Rule:** `kill -9 $(pgrep -f "tmux-claude-bot.*(src/index.ts|dist/cli.js)")` — always include `tmux-claude-bot` in the pattern; the alternation catches both the managed and dev forms.

### Implementation

The project root directory name `tmux-claude-bot` is used as the process identity marker. When running `npm run dev`, the working directory contains this string. The stop/status scripts match on this pattern.

## Development Conventions

- `npm run build` - Bundle to `dist/` via tsup (what the launchd service runs)
- `npm run dev` or `tsx src/index.ts` - Start development
- Commands exposed via Telegram Bot menu

## Internationalization (i18n) copy style

All user-facing strings live in `src/core/i18n/catalog/*.ts`. `zh.ts` is canonical
(it defines the `Messages` type); every other locale must implement every key, or
the build fails. Keep `${...}` placeholders and emoji identical across locales;
leave code tokens, CLI commands, percentages, and the `tmux-claude-bot` product
name untranslated.

**Register: this is an app UI. Copy must be concise, neutral, and professional —
NOT colloquial/spoken.** When adding a feature's copy, write every locale in the
same app register as the existing strings; do not write casual/spoken phrasing.

Per-locale register:

| Locale | Register |
|--------|----------|
| `zh` | Simplified Chinese, neutral written. |
| `zh-TW` | Traditional Chinese, Taiwan vocabulary (專案/佇列/預設/辨識), written. |
| `yue` | **書面粵語** — Traditional characters + formal WRITTEN grammar. Do **NOT** use colloquial spoken Cantonese: 嘅→的, 喺→在, 咗→了, 唔→不/沒, 睇→查看, 撳→按, 搵→找, 呢個→這個, 入面→裡, 嗰→那, 啲→些, 揀→選, 畀→給, 喇→了, 仲…緊→仍在…中. |
| `ja` | Polite/neutral Japanese (です・ます or noun style); kanji used as Japanese; refer to the app as "Lark". |
| `es` | Neutral Spanish; avoid first-person ("Salí…" → neutral "… cerrado"). |
| `en` | Concise, neutral English. |

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
