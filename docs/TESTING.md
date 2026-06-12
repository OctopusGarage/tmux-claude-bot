# Testing standard

We use [Vitest](https://vitest.dev). Tests live under `tests/`, mirroring `src/`.

## What we unit-test

- **Pure logic — always.** Parsers, formatters, auth guards, card builders,
  path/hash helpers. These are cheap and have no excuse to be untested.
- **Orchestration — via fakes.** Routing/handler/executor/view code that wires
  the core services to a chat channel. We test it with in-memory fakes for the
  channel and the dependency bundle — never real network, tmux, or whisper.

Entrypoints and wiring (`src/index.ts`, `src/scripts/**`, `src/adapters/*/start.ts`)
are excluded from coverage: they bootstrap real resources and aren't unit-testable
in isolation. Excluding them keeps the coverage number honest.

## The fake-channel / fake-deps convention

Adapter tests share helpers (see `tests/adapters/lark/_fakes.ts`):

- **`fakeChannel()`** — an object shaped like the chat channel that *records*
  every `send`/reaction/card call. Both text and card replies go through
  `channel.send`, so inspecting the recorded `input` (`{ markdown }` vs
  `{ card }`) tells them apart. Exposes `channel.texts()` / `channel.cards()`.
- **`fakeDeps(overrides?)`** — a `HandlerDeps` bundle with minimal fakes for
  `queue`, `currentProject`, `bridge`, `claude`, `output`, `configResolver`, and
  a `config`. The fake queue records each `enqueue` and lets a test drive the
  enqueued message's `resolve`/`reject` to exercise result-reply paths. Any
  piece can be replaced via `overrides`.

Prefer fakes over `vi.mock`. Reach for `vi.mock` only when a cross-module
function can't be reached through the fakes — e.g. stubbing `checkVoiceSupport` /
`transcribeOgg` in the voice tests.

## Assert observable behavior, not internals

Assert *what came out* — which `channel.send` payloads were sent, which
`queue.enqueue` happened and with what action/session — not which private method
was called or in what order. Tests should survive a refactor that preserves
behavior.

## Scripts are code too — verify locally, never ship-to-prod-to-test

The `setup` / `install.sh` scripts caused the most pain precisely because they
were untested and could only be exercised by releasing and running them in a real
(proxy-constrained) environment. Don't do that. For anything shippable:

- **Extract the risky logic into a pure, injectable unit and unit-test it.** The
  proxy-robust id capture lives in `core/onboarding.pollForCaptureIds` with
  injectable `getUpdates`/`now`/`sleep`, so its short-poll, crash-proofing, and
  timeout-fallback are tested without a real bot (`tests/core/onboarding-poll`).
  This is what would have caught the long-poll hang and the crash.
- **Shellcheck every `*.sh`:** `npm run lint:sh` (also a CI gate). Fix warnings,
  don't suppress them.
- **Walk the wizard with no side effects:** `npm run setup -- --dry-run` stubs the
  live token check, id capture, and QR scan and prints (never writes) the resolved
  config. Note: a real terminal is required — Node's readline doesn't accept piped
  stdin cleanly — so dry-run is for *manual* local verification, automation relies
  on the unit tests above.

## Beyond coverage: defenses by bug class

Coverage measures whether a line **ran**, not whether a test would **notice** it
being wrong, and not which **inputs / timing / processes** ran it. A whole-project
review found a batch of bugs that sailed past a high-coverage suite because they
lived in dimensions coverage is blind to. Each got a dedicated, cheap guard —
when you touch the relevant area, keep these green:

| Bug class (what escaped) | Why coverage missed it | Guard |
|---|---|---|
| **Startup from a real env** — a blank `KEY=` line (dotenv → `""`) crashed `loadConfig` | unit tests build config from an object, bypassing dotenv | `tests/startup-smoke.test.ts` (real `.env` via `TCB_ENV_FILE`) + `tests/config-boundary.test.ts` (schema-introspecting: **every** env var must tolerate blank — auto-covers new vars) |
| **Cross-adapter drift** — Telegram's immediate-action set dropped `tab`; dedup handling diverged | each copy was individually tested and passed | `tests/adapters/action-parity.test.ts` (routing pinned to the single registry) + the `adapters-isolated` dependency-cruiser rule (adapters can't import each other) |
| **Cross-process concurrency** — instance-lock TOCTOU | unit tests are single-threaded | `tests/instance-lock-race.test.ts` (deterministic mocked-fs interleave) + `tests/instance-lock-multiprocess.test.ts` (two real processes) |
| **Cross-restart persistence** — Lark reply-target lost on restart | no test restarts the process | per-store "survives a restart" tests (a fresh instance reads what the prior wrote) — see `bounded-session-map` / `json-map-store` / reply-target tests |
| **Executed but unasserted** — the dead queue-retry loop (removing it broke no test) | the line ran; nothing asserted its effect | **mutation testing**: `npm run mutation` (Stryker, core only; weekly CI in `.github/workflows/mutation.yml`) |

The throughline: most of these were **logic duplicated across adapters that
drifted**. The durable fix is structural — keep logic in `core/`, adapters thin —
which the `adapters-isolated` rule now enforces.

## Running

```bash
npm test                       # full suite (vitest run)
npm run lint:sh                # shellcheck the scripts
npx vitest run path/to.test.ts # a single file
npx vitest run --coverage      # coverage report (v8)
npm run mutation               # mutation testing (slow; core only) — see table above
```

## Rule

New adapter orchestration logic ships **with** tests using the fakes pattern
above. A new handler, view, or executor branch is not done until its observable
behavior is covered. A script change ships with either a unit test for its
extracted logic or, at minimum, a passing `lint:sh` — never "release and see".
