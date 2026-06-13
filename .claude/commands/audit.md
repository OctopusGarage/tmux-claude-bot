---
description: Deep adversarial audit for this codebase's blind-spot bug classes (multi-agent; billable)
argument-hint: "[scope: empty=whole project | a git range like 'since v0.1.6' | a path like 'src/core']"
allowed-tools: Workflow, Read, Write, Bash
---

Run a deep adversarial audit of the project, aimed at the bug classes the static
gates (coverage / biome / knip / dependency-cruiser) are structurally blind to:
real-environment startup, cross-adapter drift, cross-process concurrency,
cross-restart persistence, executed-but-unasserted — plus general correctness
and duplication. This is the recurring discovery engine; see the `audit` skill
and `docs/TESTING.md` for the why.

Scope: $ARGUMENTS  (empty → the whole project; or a git range, or a path)

Do this:

1. **Run the engine.** Invoke the **Workflow** tool with `name: "audit"`, passing
   the scope above as `args` (omit `args` if none was given). If the named
   workflow isn't found, run it with `scriptPath: ".claude/workflows/audit.mjs"`.
   It fans out one finder per dimension, then adversarially verifies each
   candidate (refute-biased) and returns `{ confirmed, candidates, refuted }`.

2. **Present** the surviving findings, most-severe first: `file:line` — one-line
   summary — failure scenario — verdict (CONFIRMED/PLAUSIBLE). Group by dimension.

3. **Ratchet, per finding.** State the cheapest guard that would catch this CLASS
   next time (the workflow proposes one in `suggested_guard` — refine it). Mark
   each as *fix now* vs *add a guard* vs *both*. Prefer a structural fix (logic
   into core, a dependency-cruiser/parity/boundary/restart test, or mutation
   testing) over a one-off patch — see the bug-class table in `docs/TESTING.md`.

4. **Report the refuted count** — false positives filtered by the verify pass are
   expected and healthy, not a defect of the run.

5. **Save** the full report to `docs/audits/<UTC-date>.md` (create the dir if
   needed) so runs are comparable over time. Use the date from the environment.

6. **Stop at discovery.** Do NOT start fixing anything — summarize and let me
   decide what to act on. (Confirm before running if the scope is large; this
   spawns ~7 finders plus a verifier per candidate and is billable.)
