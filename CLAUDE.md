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
- Since the runtime instance lock (`src/core/infra/instance-lock.ts`), a second instance sharing the same state dir refuses to start with an `InstanceLockHeldError` naming the holder pid — the trap now fails fast instead of 409-ing. Instances with different `TCB_STATE_DIR`s are not protected.
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
- `npm run dev` - Start development with hot-reload. At launch it resolves which
  profile to run against: by default, if the deployed prod dir
  (`~/.tmux-claude-bot`, or `$TMUX_CLAUDE_BOT_DIR`) has a `.env`, it borrows the
  prod **config and state** so dev mirrors the real projects/sessions. Set
  `TCB_DEV_LOCAL=1` to switch back to the repo's own `.env` + local state (the
  dev profile, stored in the repo root, gitignored). With no prod install it
  falls back to the local repo. An explicit `TCB_STATE_DIR`/`TCB_ENV_FILE` wins
  over all of this (how `dev.sh` and tests pin their dirs). NOTE: running
  `npm run dev` against the prod profile shares prod's state dir, so the instance
  lock blocks it while the managed service is up — use `./dev.sh` (auto
  pause/resume) or pause the service first.
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

## Resilience Protocol (restart-safety & desktop-side self-healing)

Two facts shape every feature that records session / project / agent state:

1. The bot is a **long-running managed service that restarts** (deploys, crashes, launchd/systemd) — it must come back without losing messages or breaking routing.
2. The user **drives the same tmux sessions directly on the desktop**, bypassing Telegram/Lark (quitting/starting agents, switching kind, `/clear`, killing sessions). No bot hook fires, so any recorded state silently diverges from reality.

**Every new feature that touches session/project/agent state MUST be designed for both.** Don't add a new piece of state without answering the checklist below.

### Axis 1 — Restart-safety (durability)

**Rule:** state whose loss would drop a message, break routing, or confuse the user MUST be persisted under the state dir and restored on boot. State that is a cheap cache of live/disk facts MUST NOT be persisted — rebuild it.

- **Persist** via the existing stores (all resolve `TCB_STATE_DIR`): `JsonMapStore` (session→X — `agentKindMap`, `group_bindings`, `session_path_map`, `session_live_id_map`), `BoundedSessionMap` (bounded id→session, the reply-target maps), the message queue's `.queue/pending.json`, `.current_project`.
- **Restore on boot**: `index.ts` `init()` (current sessions + dead-pane recreation); each adapter's start restores the queue backlog **channel-symmetrically** — each adapter restores and drops ONLY its own channel (`queue.clearPersistedChannel`), so a Telegram+Lark deployment loses neither side and neither double-restores.
- **Decision test for new state:** *"if the bot restarts right now, does losing this lose a message / break routing / confuse the user?"* Yes → persist + restore. No (rebuildable from the live process or disk) → keep it in-memory and say why (e.g. the `ConfigResolver` cache is deliberately not persisted — it is rebuilt from the live process).
- **In-flight messages** (dequeued, mid-execution) are intentionally NOT recovered — they were already delivered to the agent; recovering would double-send. Don't add "recover in-flight" without idempotency.

### Axis 2 — Self-healing (desktop-side bypass)

**Rule:** the **LIVE process / on-disk transcript is the source of truth**; a recorded value is launch-intent / fallback only, used solely when nothing is live.

- **Resolve from live first**, fall back to the recorded value only when no live process is detectable — pattern: `resolveAgentKind` (`agentKindMap.ts`).
- **Self-heal:** when live detection disagrees with the recorded value, write the live value back, so the post-stop fallback is correct — patterns: `resolveAgentKind` (kind), `recordLiveSessionId` refreshed inside `resolveLiveTranscript` (session id).
- **Never trust a recorded session id/kind blindly for a resume/destructive action** — verify against the live process (`/restart` captures the live transcript id *before* exiting; `live-session-id` is only the fallback when that read fails).
- **Clean up records when a session is removed** so a reused free-slot name can't read stale data — `removeProjectBySession` clears queue / current-project / kind / live-id.
- **Invalidate caches on lifecycle events** (`/clear`, `/compact`, switch, start) — `configResolver.invalidate`.
- **Tolerate dead sessions gracefully:** check `hasSession` / `isPaneAlive` before acting; a gone session yields a clear "no session" path, never a crash or a silently stuck queue.

### Checklist for any feature touching session/project/agent state

- [ ] Adds state? Survives restart if lost matters → persist + restore on boot; else in-memory + documented why.
- [ ] Can the desktop change the underlying reality? → resolve from live, self-heal the record, fall back to recorded only when nothing is live.
- [ ] Reads a recorded id/kind for a resume/destructive op? → verify against the live process first.
- [ ] Removing a session leaves orphan records? → clear them in the removal path.
- [ ] Multi-adapter (Telegram + Lark)? → restore/clear per-channel; don't let one adapter drop the other's state.
- [ ] Tested on BOTH axes (restart-restore + desktop-divergence self-heal) — see `live-session-id.test.ts`, `queue.channel.test.ts`, `agentKindMap.test.ts`.

## Agent skills

### Issue tracker

Issues live in GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Defaults: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` at repo root + `docs/adr/`. See `docs/agents/domain.md`.
