# Host Power History Design

## Problem

`tcb power status` proves the current policy, power source, and repeating wake
schedule, but it cannot prove that a previous quiet window behaved correctly.
Today an operator must manually correlate structured bot logs with the verbose
macOS `pmset -g log` output. The bot logs keep normal keep-awake acquire/release
events, but do not record every host-power phase transition or provide one
bounded audit view.

## Outcome

Add a read-only `tcb power history [--since <time>] [--json]` command. It
produces one bounded timeline that answers:

- when the bot entered each configured power phase;
- when its AC-only keep-awake assertion was acquired or released;
- whether protected work delayed a quiet-hours release;
- when macOS actually slept, dark-woke, or woke;
- whether the configured quiet release, fixed wake, and service resume have
  sufficient evidence for the selected period.

The default lookback is 24 hours. `--since` accepts the same ISO time, epoch
milliseconds, or relative `30m|2h|1d` forms as `tcb logs`.

## Evidence Model

TCB owns structured application evidence. The host power manager records only
state transitions, not every 30-second reconciliation tick:

- `phase-transition`, including the previous and current phase;
- `keep-awake-acquired` and `keep-awake-released`;
- `quiet-release-delayed`, with bounded protected-work reason codes;
- `degraded`, with the existing sanitized reason.

The normal application logger keeps the same human-readable transition lines,
but its daily files may contain tens of megabytes of unrelated runtime traffic.
History therefore reads a dedicated, typed `power-events` JSONL journal under
the canonical state directory. The journal contains only these low-frequency
transitions, rotates daily, and retains 30 days. It is not a second policy/state
authority and does not copy the system log.

macOS owns system evidence. The history reader invokes a fixed, read-only
`pmset -g log` probe and parses only Sleep, DarkWake, and full Wake records in
the requested interval. It never invokes privileged commands, mutates the wake
schedule, or persists the verbose raw host log. Non-macOS hosts and probe or
parse failures return an explicit unavailable/incomplete evidence status while
preserving available TCB evidence.

## Audit Semantics

The report contains a window, policy snapshot, bounded chronological events,
and checks. Checks are evidence statements rather than promises that macOS must
sleep:

- quiet release observed after the configured quiet start;
- natural host sleep observed after release and before the configured wake;
- scheduled full wake observed near the configured wake time;
- keep-awake reacquisition observed after wake;
- service-phase transition observed at or after quiet end.

Natural sleep is optional by policy. A missing sleep event is therefore
`not-observed`, not a failure, when release evidence exists. Missing required
TCB or scheduled-wake evidence is `incomplete`; contradictory evidence is
`degraded`. The report must not infer success solely from current configuration.

Events and checks use stable codes for JSON consumers. Human output presents a
compact summary followed by the bounded timeline. Personal absolute paths,
commands, credentials, and raw protected-work details are excluded.

## Boundaries And Performance

- Default lookback: 24 hours; maximum lookback: 30 days, matching TCB log
  retention.
- Maximum rendered events: 200. The JSON response declares truncation.
- Only daily power-event journal files intersecting the requested interval are
  read; high-volume general application logs are never scanned.
- The macOS probe is read-only, has a timeout and output cap, and is injectable
  for deterministic tests.
- Query failure never changes runtime power behavior or service availability.
- The command remains CLI-only because it is a local host diagnostic; it does
  not add chat buttons, TUI actions, Control operations, MCP mutation, or
  background polling.

## Module Design

Keep policy control and history inspection separate:

- `power-manager` emits transition evidence through a best-effort journal while
  retaining ownership of reconciliation and keep-awake decisions. Journal
  failure is logged and never changes the safety decision.
- `power-history` parses TCB and host records, correlates them against the power
  policy, and returns a typed report.
- `power-command` validates CLI arguments and renders text or JSON.
- `power-commands` registers the public Commander surface.

The history module accepts readers and a clock through a narrow interface so
tests exercise the public report without invoking the real host log.

## Error Handling

Invalid or excessive `--since` values are rejected before any probe runs.
Missing TCB files produce an empty application-evidence set. Unsupported or
failed host inspection is included as structured evidence availability instead
of crashing the command. Malformed individual JSONL or `pmset` lines are
skipped; a fully unusable host response is reported as a parse failure.

## Verification

Public-seam tests cover:

- phase and keep-awake transition logging without 30-second duplicates;
- one known-good overnight sequence from quiet release through scheduled wake
  and service resume;
- no-sleep-but-valid-release semantics;
- missing TCB evidence and unavailable system evidence;
- DarkWake remaining distinct from scheduled full Wake;
- relative, ISO, epoch, invalid, and over-30-day `--since` handling;
- event caps, chronological ordering, and JSON/text rendering;
- the exact CLI command tree and maintained documentation/alignment surfaces.

The slice finishes with focused tests, production and test type checks, format,
dependency boundaries, `npm run verify:local`, and a clean worktree commit.
