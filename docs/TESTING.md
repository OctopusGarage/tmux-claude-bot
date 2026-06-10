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

## Running

```bash
npm test                       # full suite (vitest run)
npx vitest run path/to.test.ts # a single file
npx vitest run --coverage      # coverage report (v8)
```

## Rule

New adapter orchestration logic ships **with** tests using the fakes pattern
above. A new handler, view, or executor branch is not done until its observable
behavior is covered.
