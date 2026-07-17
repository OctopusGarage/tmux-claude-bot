# Project Principles

## Usage Documentation Lookup

When the task is about how to use tmux-claude-bot, available commands, setup,
configuration, the TUI, chat workflows, autopilot, or troubleshooting, check
`llms.txt` first. For direct task recipes, read `docs/agents/usage-guide.md`, then
follow its links to `docs/manual.md`, `docs/commands.md`, or `docs/tui.md` as needed.
Do not read source code to infer user-facing commands or flags until those
documentation references have been checked.

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

### Run & dev modes (overview)

The bot can run in several modes. They differ on four axes: **what executes**
(compiled `dist` vs `tsx` source), **hot-reload** (does saving a `src/` edit take
effect live?), **persistence** (does it survive terminal close / reboot / crash?),
and **config+state source** (the deployed prod profile vs a repo-local one). The
hard invariant across all of them: **one instance per state dir** — the runtime
instance lock (`src/core/infra/instance-lock.ts`) refuses a second instance
sharing a `TCB_STATE_DIR`, so modes that share the prod state are mutually
exclusive.

| Mode | What runs | Hot-reload | Persist / auto-restart | Config+state | Start / switch | Use when |
|------|-----------|-----------|------------------------|--------------|----------------|----------|
| **Managed — prod** (default) | `dist/cli.js` (built) | No (runs last build) | Yes (launchd KeepAlive / systemd `Restart=always` + reboot) | prod `~/.tmux-claude-bot/state` | `node dist/cli.js install` (deploy); `npm run service:prod` (switch back) | Stable production runtime |
| **Managed — dev** (hot-reload) | supervisor → `tsx src/index.ts` | **Yes, `tsc`-gated** | Yes (KeepAlive + supervisor crash-backoff + reboot) | borrows prod `~/.tmux-claude-bot/state` | `npm run service:dev` ⇄ `npm run service:prod` | Self-evolving dev: improve the bot live while using it (rule in gitignored `CLAUDE.local.md`) |
| **`npm run dev`** | `tsx watch src/index.ts` | Yes (raw, no `tsc` gate) | No (foreground; dies with terminal) | borrows prod by default; `TCB_DEV_LOCAL=1` = repo-local; explicit `TCB_STATE_DIR`/`TCB_ENV_FILE` wins | `npm run dev` | One-off foreground dev. NOTE: borrowing prod state hits the instance lock while the managed service is up — use `./dev.sh` instead |
| **`./dev.sh`** | `npm run dev` (borrow prod) | Yes (raw) | No (foreground) | borrows prod | `./dev.sh` | Quick interactive dev against the real profile — auto-pauses the managed service and resumes it on exit |
| **`npm run tui`** (`tcb tui`) | Ink client of the control socket | n/a | n/a | connects to a running bot | `npm run tui` | NOT a bot instance — a third client surface onto whichever bot is already running |

**Switching cheatsheet:**

```
prod  -> dev (hot-reload):   npm run service:dev      # repoints managed service at the repo supervisor
dev   -> prod (stable dist): npm run service:prod     # repoints back at the deployed dist
update prod with new source: node dist/cli.js install # build + deploy to the managed prod instance
quick interactive session:   ./dev.sh                 # auto pause/resume the managed service
inspect a running bot:       npm run tui              # control-socket client (no new instance)
which mode is live?:         scripts/service.sh mode  # prints prod|dev|none (also in `service:status`)
```

**Profile (config+state) resolution** is owned by `scripts/dev-env.sh` (used by
`npm run dev`): default borrows the deployed prod `~/.tmux-claude-bot/state`
(+`.env`) so dev mirrors real projects/sessions; `TCB_DEV_LOCAL=1` forces the
repo's own `.env` + local state; an explicit `TCB_STATE_DIR`/`TCB_ENV_FILE`
overrides everything (how `dev.sh`, the managed-dev wrapper, and tests pin their
dirs). The managed-dev wrapper (`scripts/dev-launchd-wrapper.sh`) borrows prod
the same way.

The subsections below detail each manager (launchd / systemd / dev-service /
manual scripts).

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

### Dev-service mode (hot-reload from source)

`npm run service:dev` repoints the managed service at the repo's hot-reload
supervisor (macOS: `scripts/dev-launchd-wrapper.sh`; Linux:
`scripts/dev-systemd-wrapper.sh` -> `tsx src/scripts/dev-supervisor.ts`) instead
of the bundled `dist`. Editing `src/` then takes effect live, gated by `tsc` (a
failing typecheck keeps the last-good process up; see
`src/core/dev/supervisor-core.ts`). `npm run service:prod` switches back to the
deployed dist. Both platforms are supported (the `--dev` install path +
`service:dev`/`service:prod` switch exist for launchd and systemd alike). Only
one of the two runs at a time (instance lock). KeepAlive / `Restart=always` still
covers crash-respawn and boot-autostart.

Check which mode is live with `npm run service:status` (its output includes a
`mode: prod|dev|none` line) or the quick `scripts/service.sh mode`.

### Manual / local dev (no managed service)

Use `./dev.sh` (auto-pauses/resumes the managed service) or `npm run dev` for a
foreground dev instance, and `npm run service:status` to inspect the managed one.
(The legacy `scripts/start.sh`/`stop.sh`/`status.sh` + the `.bot.pid` file were
removed — superseded by `dev.sh` + `service.sh`, and the instance lock now
prevents the duplicate-instance trap they half-guarded against.)

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

## Local Verification Contract

Before pushing, run `npm run verify:local`. The pre-push hook runs the same
command and must not be bypassed for ordinary work. This local gate mirrors the
CI checks that previously caught missed issues only after push:

- Biome, production TypeScript, and test TypeScript checks
- coverage test run
- `knip` dead-code/export/dependency checks
- dependency-cruiser architecture checks
- type-aware ESLint (`lint:deep`)
- smoke script and high-severity npm audit
- shellcheck when available locally
- systemd unit validation when `systemd-analyze` is available locally

If CI finds a problem that `npm run verify:local` did not find, treat that as a
process bug: update this script, the hook, or these instructions so the same
class of issue is caught locally next time. Do not leave the fix only in CI
tribal knowledge.

Loop Engineering assessment findings must declare every path the active agent is
allowed to change in `affectedFiles`, including architecture guard directories
such as `.semgrep`, config files, docs, and lockfiles. The loop runner treats a
dirty worktree after staging those affected files as a failed round; update the
assessment contract instead of letting verified changes sit uncommitted.

## Active Goal Discipline

Do not turn a broad active goal into an endless opportunistic sweep. A broad
goal must work in explicit, reviewable slices: define the slice, inspect current
state, make only changes that directly prove that slice, run matching
verification, commit or clean up, then stop after each slice to report the exact
state before choosing the next slice.

- Do not keep searching for "one more" unrelated coverage gap after a slice is
  already verified.
- Do not preserve useful-looking opportunistic edits just because they are real
  bugs; if they were not part of the current slice, clean them up or defer them
  explicitly.
- Clean up or revert opportunistic changes before restarting the goal loop.
- If the active goal state is paused, stale, or unclear, say that plainly and
  restart from a current-state audit rather than assuming momentum is progress.

## AI Capability Boundary

This project orchestrates existing agent runtimes (Claude Code, Codex, and their
managed tmux sessions). Do not implement bot-owned AI behavior by writing code
or scripts that call model-provider APIs directly. It must not grow separate
direct model-provider integrations for product AI behavior, autonomous judging,
or evals.

AI work is active-agent-only: if a feature needs AI reasoning, it must reuse the
currently running Claude Code / Codex capability that this bot manages. The
acceptable implementations are queueing work into an existing project session,
using existing agent goal runners, or talking to the running bot/agent
control surface. Do not add a second model transport, even for a quick eval,
prototype, smoke check, or helper script.

This is not a model-client application. For autonomous evals, smoke checks, or
other AI-backed work, the bot should ask the already-running agent surface
instead of adding a separate provider-client path.
Historical names such as `aiEval` describe the quality gate/report field only;
they do not authorize a new script, helper, or module to call model-provider APIs.

- Do not add source, scripts, smoke tests, docs, or `.env.example` entries that
  call OpenAI, Anthropic, Gemini/Google, or other LLM/model HTTP APIs directly.
- Do not ship helper scripts that instantiate model SDK clients (`OpenAI`,
  `Anthropic`, `GoogleGenerativeAI`, `GoogleGenAI`, etc.), add AI SDK provider
  packages, or call provider `/v1/*` endpoints for bot-owned AI behavior.
- Do not introduce new model API key env vars for bot-owned features unless the
  user explicitly approves an architecture change first.
- Do not create temporary or example scripts that bypass this boundary for
  convenience; prototypes, smoke tests, and eval helpers follow the same rule.
- AI-backed work must route through the currently running agent capability:
  managed project sessions, the queue, existing goal runners, or a
  command that talks to the running bot/agent control surface. Local deterministic
  checks and schema-validating command contracts are fine.
- If a feature needs AI judgment, reuse the active Claude Code / Codex session
  already managed by this bot. Do not create a parallel provider-client path just
  because a shell script or helper command would be easy to write.
- `eval.command`, assessment/execution commands, smoke helpers, and scripts are
  command-contract boundaries, not model-integration points. They may run local
  deterministic checks or adapters to the running bot/agent control surface. If
  their result depends on AI judgment, that judgment must come from the active
  Claude Code / Codex session already managed by this project.
- Treat any bot-owned OpenAI/Anthropic/LLM provider SDK client, HTTP helper
  script, or provider-key based eval path as an architectural regression: remove
  it or replace it with an agent-backed/control-surface adapter.
- If a shell command needs AI judgment, make it a deterministic contract wrapper
  or an adapter that talks to the running bot/agent control surface; do not make
  the script own model credentials or provider transport.
- If an implementation idea requires `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
  `GEMINI_API_KEY`, a provider SDK, or a provider HTTP endpoint, stop and redesign
  it around the currently running Claude Code / Codex capability unless the user
  explicitly approves changing this architecture.
- Reading an existing agent CLI's local auth/config state for status display is
  allowed when it does not make a model request.

## Logging

All code logs via `createLogger("<area>.<file>")` exported from
`src/shared/utils/logger.ts`. **Do not use `console.*`** except in user-facing
CLI/wizard stdout: `src/cli.ts`, `src/scripts/*`, and `onboarding-wizard.ts`.

**Always pass the error OBJECT, never its message** — `log.error("msg", { err })`,
not `log.error(\`msg: ${err.message}\`)`. The logger's `errToObj` extracts
name/message/**stack** and redacts secrets; stringifying `err.message` throws away
the stack, which is what you need when diagnosing a failure during testing.

**Log destination:** structured JSONL under `~/.tmux-claude-bot/logs/tcb-YYYYMMDD.jsonl`
(or `TCB_LOG_DIR`). One file per day; 30-day rotation; secrets auto-redacted.

**JSONL fields:** `ts`, `level`, `component`, `msg`, `traceId`, `session`, `chatId`,
`channel`, `data`, `err`.

**Ambient context** (`traceId`, `session`, `chatId`, `channel`) is attached
automatically via the AsyncLocalStorage store in
`src/shared/utils/log-context.ts`. It is established once at each ingress (adapter
handler, queue handler, boot) and inherited by every `await` in that async scope.
Call sites write `log.info("msg", { data })` / `log.error("msg", { err })` — do not
string-embed context fields.

**Verbosity:** `LOG_LEVEL` env var (DEBUG|INFO|WARN|ERROR, default INFO). DEBUG is
reserved for high-volume flow tracing that is noise at steady state but invaluable
when diagnosing — notably the autopilot's degraded-signal probes (`autopilot.signal`
logs at DEBUG when a pane/transcript read falls back, so a stalled tick reads as
"probe failed" rather than looking identical to "genuinely idle"). Run the bot with
`LOG_LEVEL=DEBUG` when testing why autopilot did / didn't act.

**Querying:**
- CLI: `tcb logs [--session <n>] [--trace <id>] [--level WARN] [--days N] [-n 50] [--json]`
- Chat: `/logs` (owner-only) — recent WARN/ERROR for the current session;
  `/logs <traceId>` or `/logs N`.

**Logging is best-effort** — the logger never throws into the caller; a file-write
failure falls back to the stdout mirror.

### Adding logging to a new feature (design-time checklist)

Every new feature owns its observability — wire logging in as you build it, not after
a debugging session proves it missing. The test before a feature is "done": **"if this
misbehaves during testing, can `tcb logs` / `/logs` tell me what it did and why?"** If
not, add the log. Concretely:

- **Ingress** — a new entry point (adapter handler, queue/tick handler, CLI command,
  control-socket op) establishes ambient context ONCE via `runWithLogContext({ traceId,
  channel, chatId, session? })` and logs receipt at INFO; everything downstream inherits
  the context for free.
- **Decisions** — when the feature takes a branch a tester can't see (acted / skipped /
  paused / fell back / deduped / dropped), log WHY. "Why did it do nothing?" MUST be
  answerable from the log. High-frequency branch → DEBUG; one-off state change → INFO.
- **Failures** — every `catch` / `.catch()` either rethrows or logs with the error
  OBJECT (`{ err }`, never `${err.message}` — you lose the stack). A silent swallow is
  allowed ONLY for a genuinely ignorable best-effort; if its silence could mislead a
  tester, add a DEBUG line naming what was skipped.
- **Lifecycle / state** — persisted-state writes, enable/disable, start/stop, a
  connection going up or down → INFO.

**Levels:** DEBUG = high-volume flow trace (off by default; opt in with `LOG_LEVEL`);
INFO = significant event or state change; WARN = recoverable degradation; ERROR = a
real failure (always with `{ err }`).

**Don't:** string-embed ambient fields (`session=` / `chat=`) into the message (they're
auto-attached); log `err.message` instead of `{ err }`; use `console.*` outside the
whitelist; or log at INFO on a per-tick / per-keystroke hot path (use DEBUG).

**Working if:** a tester reproducing a problem can locate the cause from the JSONL
without re-running under a debugger or adding logs reactively.

## Dashboard

An on-demand global status snapshot of all managed sessions.

- **Entry point:** `buildDashboard(deps)` in `src/core/dashboard/dashboard.ts` returns a `DashboardSnapshot`.
- **Surfaces:** `tcb dashboard` (CLI, `--json` for raw JSON) and `/dashboard` (owner-only chat command; Lark restricts it to p2p messages).
- **"Busy"** is `(bot task in flight) OR (transcript written within ACTIVITY_WINDOW_MS) OR (pane is animating)`. The second arm — `AgentProfile.lastActivityAt` (newest transcript mtime, per-agent; process-independent so the one-shot `tcb dashboard` sees it too) — catches work driven directly in the pane, so desktop-initiated activity shows busy. The third arm — `paneIsAnimating`, **only when the first two say idle** — captures the pane twice `PANE_DIFF_MS` (~1.1s) apart and marks busy if it changed: an actively-working pane has a cycling spinner / ticking elapsed timer (main turn, a long *silent* tool call, or a running background subagent), an idle pane is static. It is agent-agnostic (no fragile UI-string match) but adds ~1.1s + two captures per idle session to the snapshot.
- **current-task duration** (`busy Xs`): bot-driven tasks use the precise queue-bracketed tracker (`task-timing.ts`, `taskStarted`/`taskEnded` around `runHandler`); a desktop-driven busy session has no bot timer, so the duration is derived from the transcript — the newest `ConversationRound.timeMs` (the current turn's raw start timestamp) read via `getRecentConversations`, only when busy without a bot timer. Use `ConversationRound.timeMs` (raw epoch ms), never `.time` (the formatted `MM/DD HH:MM`), for arithmetic.
- **cumulative** (`Σ`) still counts **bot-driven** task time only (the persisted `task-timing` total) — desktop work isn't summed.
- **Session uptime** is derived from the tmux `#{session_created}` timestamp (via `bridge.sessionsCreatedAt()`), not from any bot-side record.
- **No live auto-refresh** — every call to `buildDashboard` is a fresh point-in-time snapshot; there is no push or polling mode.

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

## User-facing paths

Any filesystem path shown to a user MUST render the home dir as `~`, never a raw
`/Users/alice/…` or `/home/alice/…`.

This is enforced at the message **send boundary**, so individual call sites do NOT
need to remember:

- Telegram: `compose()` in `src/adapters/telegram/replies.ts` runs every reply
  through `tildeifyHome()`.
- Lark: `sendText()` / `sendCard()` in `src/adapters/lark/replies.ts` run the text
  / every string in the card through `tildeifyHome()` / `tildeifyHomeDeep()`.

`tildeifyHome` / `tildeifyHomeDeep` live in `src/shared/utils/path.ts`. Because the
chokepoint covers all chat output, new features get this for free — do not paste
raw `getPathBySession(...)` / `projectPath` / `workspacePath` into a message and
expect to "fix the display later"; it is already handled. For output that does NOT
go through those send functions (e.g. a new CLI command's stdout, a non-chat
surface), call `tildeifyHome()` yourself. Never widen this by printing absolute
home paths to users.

### Floating-point display noise

The SAME send boundary also runs every reply through `tidyFloatNoise()` /
`tidyFloatNoiseDeep()` (`src/shared/utils/number.ts`): JS double arithmetic prints
`14` as `14.000000000000002` and `3` as `2.9999999999999996`, and this collapses any
number with a ≥10-digit run of 0s or 9s in its fraction back to the clean value (no
real datum has that, so legit decimals like `3.14159` are untouched). So a new view
that formats a computed number can't leak float noise into chat — it's fixed at the
boundary. Still prefer rounding at the source for *intended* precision (e.g. a
percentage shown as an integer); the boundary only cleans noise, not your rounding
choice. Non-chat surfaces (CLI stdout, the TUI's client-side render) don't pass
through it — round there yourself.

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

- **The state dir is `<install dir>/state` (a subdir), NOT the install dir itself.** The install dir is also where the deploy mirrors each release with `rsync --delete` (`install.sh`) — so any state file living at the install-dir ROOT that wasn't in the deploy's exclude list got silently DELETED on every deploy. This is exactly what wiped `group_bindings.json` and bricked Feishu project groups ("send a message, no reply, must recreate the group"). State now lives in one `state/` subdir, excluded as a single `/state` entry; `.env` lives there too. The launchd/systemd wrappers export `TCB_STATE_DIR=<install>/state`; `migrateLegacyStateDir()` (run first in `bootstrap()`, before `loadConfig`) relocates any legacy root-level state on boot. **Invariant:** every state filename in `LEGACY_STATE_NAMES` (`state-migration.ts`) MUST stay in `install.sh`'s `rsync --delete` excludes — a guard test (`state-dir.test.ts`) fails CI otherwise, so a new state file can never silently regress into the deploy-wipe.
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
- **Enumerate from live ∪ records, never records alone.** Any feature that LISTS / picks / sweeps / acts on the *set* of projects or sessions (a picker, a status list, the recovery roster) MUST union the bot's own records with what is live in tmux / on disk — a bot-maintained list captures only what the bot itself created. The user starts sessions DIRECTLY in tmux (bypassing the bot), so a desktop-created project is absent from bot-only lists (`recent_projects.txt`, `agentKindMap`, …) yet is a real, live project the feature must include. Ask: *"if the user `tmux new`'d a project the bot never saw, does this list still show it?"* If no, widen the source. Patterns: `recentProjectButtons` unions `recent_projects.txt` with live `listProjectSessions()` that have a recorded path (so the group-creation picker shows desktop-started projects); the running-sweep adds desktop-started sessions to the recovery roster. The single recorded-value rule above (resolve one value from live) and this one (enumerate the whole set from live) are the same principle at different cardinalities.

### Checklist for any feature touching session/project/agent state

- [ ] Adds state? Survives restart if lost matters → persist + restore on boot; else in-memory + documented why.
- [ ] Can the desktop change the underlying reality? → resolve from live, self-heal the record, fall back to recorded only when nothing is live.
- [ ] LISTS / picks / sweeps a *set* of projects/sessions? → source from live ∪ records, never a bot-only list; a desktop-created (`tmux new`) project the bot never saw must still appear.
- [ ] Reads a recorded id/kind for a resume/destructive op? → verify against the live process first.
- [ ] Removing a session leaves orphan records? → clear them in the removal path.
- [ ] Multi-adapter (Telegram + Lark)? → restore/clear per-channel; don't let one adapter drop the other's state.
- [ ] Tested on BOTH axes (restart-restore + desktop-divergence self-heal) — see `live-session-id.test.ts`, `queue.channel.test.ts`, `agentKindMap.test.ts`.

## User documentation (keep it in sync)

`docs/manual.md` is the **canonical, comprehensive user manual** — the single entry
point for using the system (install, chat usage, the terminal UI, keep-awake, CLI,
troubleshooting). It links the focused references: `docs/commands.md` (the full
chat-command table) and `docs/tui.md` (the terminal-UI guide).

**When you add or change a user-facing command or feature, update the manual in the
same change** — do not "document it later". This is mechanically enforced, so drift
fails CI instead of rotting silently (`tests/docs-contract.test.ts`):

- every Telegram/Feishu menu command (`BOT_COMMANDS`) must appear in `docs/commands.md`;
- every CLI command (each `.command("…")` in `src/cli.ts`) must be named in
  `docs/manual.md`;
- the manual must link `commands.md` and `tui.md`;
- every config key (`envSchema`) must be in `.env.example`.

So: add a `tcb` subcommand → name it in the manual; add a chat command → add a
`docs/commands.md` row; add a config key → add it to `.env.example`. The test tells
you exactly what's missing.

## Agent skills

### Guiding users (AI usage reference)

When asked to explain or walk someone through using this system, consult
`docs/agents/usage-guide.md` — task recipes ("user wants to X → relay Y") + a quick
command/key reference + how to interpret what users see, so you can guide without
memorising. It relays from the canonical docs (`docs/manual.md`, `docs/commands.md`,
`docs/tui.md`); when in doubt trust those / `tcb --help`.

### Issue tracker

Issues live in GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Defaults: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` at repo root + `docs/adr/`. For project/session/group
relationship rules, also read `docs/domain/project-session-model.md`. See
`docs/agents/domain.md`.

### Skills the autopilot goals rely on

Some goals drive the agent by asking it to run a skill (`use your code-review /
simplify / improve-codebase-architecture skill if available`). Those skills live
in the agent's environment, not this repo. `docs/agents/skills.md` is the
registry of their sources + install/update steps; add a row when a new
skill-backed goal is introduced.

<!-- rtk-instructions v2 -->
# RTK (Rust Token Killer) - Token-Optimized Commands

## Golden Rule

**Always prefix commands with `rtk`**. If RTK has a dedicated filter, it uses it. If not, it passes through unchanged. This means RTK is always safe to use.

**Important**: Even in command chains with `&&`, use `rtk`:
```bash
# ❌ Wrong
git add . && git commit -m "msg" && git push

# ✅ Correct
rtk git add . && rtk git commit -m "msg" && rtk git push
```

## RTK Commands by Workflow

### Build & Compile (80-90% savings)
```bash
rtk cargo build         # Cargo build output
rtk cargo check         # Cargo check output
rtk cargo clippy        # Clippy warnings grouped by file (80%)
rtk tsc                 # TypeScript errors grouped by file/code (83%)
rtk lint                # ESLint/Biome violations grouped (84%)
rtk prettier --check    # Files needing format only (70%)
rtk next build          # Next.js build with route metrics (87%)
```

### Test (60-99% savings)
```bash
rtk cargo test          # Cargo test failures only (90%)
rtk go test             # Go test failures only (90%)
rtk jest                # Jest failures only (99.5%)
rtk vitest              # Vitest failures only (99.5%)
rtk playwright test     # Playwright failures only (94%)
rtk pytest              # Python test failures only (90%)
rtk rake test           # Ruby test failures only (90%)
rtk rspec               # RSpec test failures only (60%)
rtk test <cmd>          # Generic test wrapper - failures only
```

### Git (59-80% savings)
```bash
rtk git status          # Compact status
rtk git log             # Compact log (works with all git flags)
rtk git diff            # Compact diff (80%)
rtk git show            # Compact show (80%)
rtk git add             # Ultra-compact confirmations (59%)
rtk git commit          # Ultra-compact confirmations (59%)
rtk git push            # Ultra-compact confirmations
rtk git pull            # Ultra-compact confirmations
rtk git branch          # Compact branch list
rtk git fetch           # Compact fetch
rtk git stash           # Compact stash
rtk git worktree        # Compact worktree
```

Note: Git passthrough works for ALL subcommands, even those not explicitly listed.

### GitHub (26-87% savings)
```bash
rtk gh pr view <num>    # Compact PR view (87%)
rtk gh pr checks        # Compact PR checks (79%)
rtk gh run list         # Compact workflow runs (82%)
rtk gh issue list       # Compact issue list (80%)
rtk gh api              # Compact API responses (26%)
```

### JavaScript/TypeScript Tooling (70-90% savings)
```bash
rtk pnpm list           # Compact dependency tree (70%)
rtk pnpm outdated       # Compact outdated packages (80%)
rtk pnpm install        # Compact install output (90%)
rtk npm run <script>    # Compact npm script output
rtk npx <cmd>           # Compact npx command output
rtk prisma              # Prisma without ASCII art (88%)
```

### Files & Search (60-75% savings)
```bash
rtk ls <path>           # Tree format, compact (65%)
rtk read <file>         # Code reading with filtering (60%)
rtk grep <pattern>      # Search grouped by file (75%). Format flags (-c, -l, -L, -o, -Z) run raw.
rtk find <pattern>      # Find grouped by directory (70%)
```

### Analysis & Debug (70-90% savings)
```bash
rtk err <cmd>           # Filter errors only from any command
rtk log <file>          # Deduplicated logs with counts
rtk json <file>         # JSON structure without values
rtk deps                # Dependency overview
rtk env                 # Environment variables compact
rtk summary <cmd>       # Smart summary of command output
rtk diff                # Ultra-compact diffs
```

### Infrastructure (85% savings)
```bash
rtk docker ps           # Compact container list
rtk docker images       # Compact image list
rtk docker logs <c>     # Deduplicated logs
rtk kubectl get         # Compact resource list
rtk kubectl logs        # Deduplicated pod logs
```

### Network (65-70% savings)
```bash
rtk curl <url>          # Compact HTTP responses (70%)
rtk wget <url>          # Compact download output (65%)
```

### Meta Commands
```bash
rtk gain                # View token savings statistics
rtk gain --history      # View command history with savings
rtk discover            # Analyze Claude Code sessions for missed RTK usage
rtk proxy <cmd>         # Run command without filtering (for debugging)
rtk init                # Add RTK instructions to CLAUDE.md
rtk init --global       # Add RTK to ~/.claude/CLAUDE.md
```

## Token Savings Overview

| Category | Commands | Typical Savings |
|----------|----------|-----------------|
| Tests | vitest, playwright, cargo test | 90-99% |
| Build | next, tsc, lint, prettier | 70-87% |
| Git | status, log, diff, add, commit | 59-80% |
| GitHub | gh pr, gh run, gh issue | 26-87% |
| Package Managers | pnpm, npm, npx | 70-90% |
| Files | ls, read, grep, find | 60-75% |
| Infrastructure | docker, kubectl | 85% |
| Network | curl, wget | 65-70% |

Overall average: **60-90% token reduction** on common development operations.
<!-- /rtk-instructions -->
