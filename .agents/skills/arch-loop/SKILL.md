---
name: arch-loop
description: Use when the user asks for /arch-loop, arch-loop, architecture health loop, architecture score and improve, auto-eval architecture, or repeated improve-codebase-architecture until this repo is good enough.
---

# Arch Loop

## Overview

Run this repo's bounded architecture deepening loop. Treat `/arch-loop` as a
compatibility phrase from Claude; in Codex the project-local entry point is
`$arch-loop` or selecting `arch-loop` from `/skills`.

## Required Inputs

Before scoring or editing, read these repo files:

- `CLAUDE.md`
- `CONTEXT.md`
- `workflows/architecture-deepening-loop.md`
- relevant ADRs under `docs/adr/`

If `workflows/architecture-deepening-loop.md` is missing, stop and report that
the arch loop cannot run.

## Arguments

Accept the same arguments as `.claude/commands/arch-loop.md`:

- `target=<number>` overrides the target score. Default: `88`.
- `max_rounds=<number>` overrides the maximum implementation rounds. Default: `3`.
- `dry-run` or `score-only` rescans and scores without editing files.
- `focus:<area>` focuses the scan on one area while still scoring the whole repo.

## Operating Contract

Follow `workflows/architecture-deepening-loop.md` as the source of truth. In
particular:

- Start from a fresh scan of the current worktree; do not reuse an old candidate
  pool.
- Use `$improve-codebase-architecture` when available to produce a fresh
  baseline report and candidate list.
- Score the repo out of 100 using the workflow rubric: module depth, locality,
  testability, domain clarity, and change safety.
- Stop without editing when the baseline score already meets the target.
- Implement at most one candidate per round, only when it is `Strong` or a
  clearly low-risk `Worth exploring` candidate.
- Reject cosmetic cleanup, large file splitting without a deeper interface,
  one-adapter abstractions, and broad rewrites.
- For implementation rounds, use TDD: write a focused failing test, confirm the
  expected failure, make the smallest behavior-preserving change, then rerun the
  focused test.
- Verify each round with focused tests plus the commands required by the
  workflow.
- Re-score after every round and stop at the first workflow stop condition.

## Output

Use the exact baseline and round output shape from
`workflows/architecture-deepening-loop.md`:

```text
Architecture score: NN/100

Score movement:
- Module depth: A -> B
- Locality: A -> B
- Testability: A -> B
- Domain clarity: A -> B
- Change safety: A -> B

Selected candidate:
- name
- reason
- files

Changed:
- ...

Verification:
- command: result

Stop decision:
- continue | stop

Reason:
- ...
```
