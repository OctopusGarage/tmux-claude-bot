---
name: audit
description: Reference for the project's deep-audit methodology — the blind-spot bug-class taxonomy this codebase is prone to and the verify/ratchet discipline. Read when running or interpreting `/audit`, or doing a manual deep review. Not an auto-action; the executable engine is `.claude/workflows/audit.mjs`.
---

# Audit methodology

The static gates (vitest+coverage, biome, knip, dependency-cruiser, Stryker)
verify **local, static, single-process** properties. Real bugs escape into the
dimensions they're blind to. This skill is the taxonomy + discipline; the
executable engine is `.claude/workflows/audit.mjs`, run via `/audit`.

## Blind-spot bug classes (where this project actually breaks)

1. **Real-environment & startup** — a blank `KEY=` (dotenv → `""`), a non-default
   install path (`TCB_STATE_DIR`), module-load env/path reads.
2. **Cross-adapter drift** — `telegram` vs `lark` behaving differently where they
   shouldn't; an adapter hardcoding what `core` already derives.
3. **Cross-process concurrency** — the instance lock, state-file read-modify-write
   races, the bot + `claude-tmux` helper sharing `session_path_map.json`.
4. **Cross-restart persistence** — state lost (or wrongly kept) across a restart;
   a format that won't round-trip.
5. **Executed-but-unasserted** — code that runs but nothing asserts; retry/guard
   branches that can never fire given the caller contract; false/stale comments.
6. plus **general correctness** and **reuse/duplication** (duplication is the
   *source* of the drift class).

See the bug-class → defense table in `docs/TESTING.md` for the guard each maps to.

## Discipline

- **Verify by reading the actual code** — construct the exact input / timing /
  state. No verdict without a concrete path.
- **Be refute-biased** — default to REFUTED when you can't construct the failure.
  False positives waste everyone's time (a real review here refuted 3 of ~9).
- **Ratchet, don't whack-a-mole** — every confirmed escape gets a cheap guard for
  its *class* (a boundary/parity/restart/property test, a dependency-cruiser or
  biome rule, or mutation testing), not just a one-off fix.
- **Structural beats reactive** — keep logic in `core/`, adapters thin (enforced
  by the `adapters-isolated` dependency-cruiser rule). Most drift bugs trace to
  logic that was copied between adapters instead of shared.

## What `/audit` does NOT do

It discovers and ratchets; it does not fix. Treat its output as a worklist, not a
mandate — decide what to act on. The first run on a large scope is billable
(multi-agent fan-out), so it's a deliberate / scheduled tool, not auto-firing.
