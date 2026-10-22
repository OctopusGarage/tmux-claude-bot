# Host Power History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a bounded `tcb power history` audit that correlates typed TCB power transitions with read-only macOS sleep/wake evidence.

**Architecture:** The host-power manager writes low-frequency typed events to a dedicated rotating journal through an injected recorder. A separate history module reads that journal, parses a bounded `pmset -g log` response, evaluates evidence without treating natural sleep as mandatory, and returns a typed report rendered by the existing power CLI.

**Tech Stack:** TypeScript, Node.js filesystem/child-process APIs, Commander, Vitest, Biome, dependency-cruiser.

---

## File Map

- Create `src/core/power/power-event-journal.ts`: typed power-event schema, daily JSONL append/read, retention, and best-effort recorder.
- Create `src/core/power/power-history.ts`: fixed read-only host probe, `pmset` parser, event correlation, checks, and typed report.
- Modify `src/core/power/power-manager.ts`: emit deduplicated phase, assertion, delay, and degradation evidence through an injected recorder.
- Modify `src/core/platform/power-command.ts`: validate history arguments and render typed text/JSON results.
- Modify `src/cli/power-commands.ts`: register `history --since --json`.
- Create `tests/core/power-event-journal.test.ts`: journal public contract.
- Create `tests/core/power-history.test.ts`: known-good and incomplete overnight evidence contracts.
- Modify `tests/core/power-manager.test.ts`: recorder transition/de-duplication contract.
- Modify `tests/core/power-command.test.ts`: history parsing/rendering/validation contract.
- Modify `tests/cli/power-commands.test.ts`: exact public command tree.
- Modify `docs/manual.md`, `docs/cli-reference.md`, `docs/agents/usage-guide.md`, `docs/agent-maintenance-guidelines.md`, and `docs/automation-alignment.md`: usage, troubleshooting, ownership, and drift checks.

### Task 1: Typed Power Event Journal

**Files:**
- Create: `src/core/power/power-event-journal.ts`
- Test: `tests/core/power-event-journal.test.ts`

- [ ] **Step 1: Write the failing journal contract test**

Create a temporary `stateDir`, append literal events for two dates, include one malformed line, then assert `readPowerEvents({ stateDir, since, until })` returns only valid in-window events in chronological order and reports malformed input without throwing.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run tests/core/power-event-journal.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the minimal typed journal**

Define stable kinds:

```ts
type PowerEvent =
  | { at: number; kind: "phase-transition"; from: HostPowerPhase | null; to: HostPowerPhase }
  | { at: number; kind: "keep-awake-acquired" | "keep-awake-released" }
  | { at: number; kind: "quiet-release-delayed"; reasons: string[] }
  | { at: number; kind: "degraded"; reason: string };
```

Append one validated JSON object per line under `state/power-events/power-YYYYMMDD.jsonl`, keep 30 days, read only intersecting files, skip malformed lines, and expose a no-throw production recorder that logs journal failures.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npx vitest run tests/core/power-event-journal.test.ts`

Expected: PASS.

### Task 2: Host Manager Transition Evidence

**Files:**
- Modify: `src/core/power/power-manager.ts`
- Modify: `tests/core/power-manager.test.ts`

- [ ] **Step 1: Write the failing recorder test**

Inject `recordEvent(event)` into the existing harness and drive `service → natural-sleep → wake-warmup → service`. Assert one phase event per transition, one release, one reacquisition, and no duplicate event on repeated reconciliation in the same state. Add a protected-work case whose repeated identical reason set records once.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run tests/core/power-manager.test.ts`

Expected: FAIL because `HostPowerManagerOptions` has no recorder and no typed transition evidence is emitted.

- [ ] **Step 3: Implement transition-aware emission**

Track the last phase, assertion state, and normalized protected-work reason key in the manager closure. Emit only changes. Wire `startHostPowerManager` to the production journal recorder. Keep existing application log lines and safety behavior unchanged; recorder exceptions must be contained.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npx vitest run tests/core/power-manager.test.ts tests/core/power-event-journal.test.ts`

Expected: PASS.

### Task 3: Typed Host Power History Report

**Files:**
- Create: `src/core/power/power-history.ts`
- Create: `tests/core/power-history.test.ts`

- [ ] **Step 1: Write the failing known-good overnight test**

Use literal application events for release at 02:00, phase transition to natural sleep, reacquisition at 09:15, wake-warmup, and service at 09:30. Supply literal `pmset` lines containing Sleep, DarkWake, and the scheduled full Wake at 09:15. Assert stable event codes, chronological order, `systemEvidence.status === "available"`, and passing release/wake/reacquire/resume checks while DarkWake remains distinct.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run tests/core/power-history.test.ts`

Expected: FAIL because `readPowerHistory` does not exist.

- [ ] **Step 3: Implement parser and report correlation**

Add an injectable probe returning `{ status, output?, detail }`. The production probe uses `execFileSync("pmset", ["-g", "log"], { encoding: "utf8", timeout: 5_000, maxBuffer: 8 * 1024 * 1024 })` on Darwin and returns unsupported elsewhere. Parse only timestamped Sleep, DarkWake, and full Wake lines. Return a typed report with window, config snapshot, evidence availability, checks, events, and truncation at the newest 200 events.

- [ ] **Step 4: Add RED/GREEN edge slices**

One test at a time, add and satisfy:

- valid release without host sleep gives `natural-sleep: not-observed`, not degraded;
- unavailable system evidence preserves TCB events and marks scheduled-wake incomplete;
- no TCB journal evidence cannot be inferred from current status;
- malformed host output yields parse-failed rather than throwing;
- more than 200 merged events sets `truncated: true` and retains the newest 200 chronologically.

Run after every slice: `npx vitest run tests/core/power-history.test.ts`.

Expected after each implementation: PASS.

### Task 4: CLI Contract And Rendering

**Files:**
- Modify: `src/core/platform/power-command.ts`
- Modify: `src/cli/power-commands.ts`
- Modify: `tests/core/power-command.test.ts`
- Modify: `tests/cli/power-commands.test.ts`

- [ ] **Step 1: Write the failing command-core test**

Inject `readHistory(input)` and assert `runPowerCommand(["history", "--since", "24h", "--json"])` passes the exact epoch window and returns the typed report. Add literal invalid relative time and over-30-day cases that return exit code 1 without calling the reader.

- [ ] **Step 2: Run the command test and verify RED**

Run: `npx vitest run tests/core/power-command.test.ts`

Expected: FAIL with the current usage response.

- [ ] **Step 3: Implement validation and rendering**

Extract or reuse one exported relative/ISO/epoch parser instead of copying log-query semantics. Default to `24h`, cap at 30 days, accept options in either order, call `readPowerHistory`, and render a compact status/check/timeline text. JSON is the complete typed report.

- [ ] **Step 4: Add the Commander command and test**

Register:

```text
power history [--since <time>] [--json]
```

Assert the command tree contains `status`, `history`, and `schedule`; `history` exposes exactly `--since` and `--json` beyond Commander defaults.

- [ ] **Step 5: Run focused CLI tests and verify GREEN**

Run: `npx vitest run tests/core/power-command.test.ts tests/cli/power-commands.test.ts`

Expected: PASS.

### Task 5: Documentation And Alignment

**Files:**
- Modify: `docs/manual.md`
- Modify: `docs/cli-reference.md`
- Modify: `docs/agents/usage-guide.md`
- Modify: `docs/agent-maintenance-guidelines.md`
- Modify: `docs/automation-alignment.md`

- [ ] **Step 1: Update operator documentation**

Document `tcb power history --since 24h`, JSON automation use, the distinction between policy/current status and historical evidence, natural-sleep `not-observed`, evidence-unavailable behavior, 30-day/200-event bounds, and that `pmset` access is read-only.

- [ ] **Step 2: Update the alignment contract**

Extend the Host power row so “Must Align” includes the typed journal, read-only host-event correlation, CLI history contract, evidence completeness semantics, and focused regression tests. Extend “Do Not Bypass” to forbid interpreting configuration alone as historical success or persisting copied raw system logs.

- [ ] **Step 3: Run documentation drift checks**

Run: `rg -n "power history|historical evidence|power-event" docs/manual.md docs/cli-reference.md docs/agents/usage-guide.md docs/agent-maintenance-guidelines.md docs/automation-alignment.md`

Expected: every maintained surface contains its intended entry and no undocumented command variant appears.

### Task 6: Review, Full Verification, And Commit

**Files:** all files in Tasks 1–5.

- [ ] **Step 1: Run focused and static gates**

Run:

```bash
npx vitest run tests/core/power-event-journal.test.ts tests/core/power-history.test.ts tests/core/power-manager.test.ts tests/core/power-command.test.ts tests/cli/power-commands.test.ts
npm run lint:types
npm run lint:types:tests
npx biome check <touched TypeScript and test files>
npx depcruise src --config .dependency-cruiser.cjs
git diff --check
```

Expected: zero failures and zero dependency violations.

- [ ] **Step 2: Exercise the real read-only command**

Run: `tcb power history --since 24h` and `tcb power history --since 24h --json`.

Expected: existing pre-journal history is explicitly incomplete rather than falsely successful; the host timeline is bounded and includes available macOS evidence.

- [ ] **Step 3: Run the repository gate**

Run: `npm run verify:local`.

Expected: exit 0.

- [ ] **Step 4: Self-review scope and safety**

Confirm no `pmset` mutation outside the existing interactive schedule commands, no privilege request, no absolute user path in output, no high-volume application-log scan, no forced sleep, and no unrelated changes.

- [ ] **Step 5: Commit the implementation slice**

```bash
git add src/core/power src/core/platform/power-command.ts src/cli/power-commands.ts tests/core tests/cli/power-commands.test.ts docs/manual.md docs/cli-reference.md docs/agents/usage-guide.md docs/agent-maintenance-guidelines.md docs/automation-alignment.md
git commit -m "feat(power): add auditable sleep and wake history"
```
