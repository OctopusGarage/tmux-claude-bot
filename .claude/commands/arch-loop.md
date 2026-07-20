---
description: Strict architecture deepening loop — rescan, score, improve, and stop at the target
argument-hint: "[target=88] [max_rounds=3] [dry-run|score-only|focus:<area>]"
allowed-tools: Task, Read, Write, Edit, Bash, Workflow
---

Run the strict architecture deepening loop for this repo.

Arguments: `$ARGUMENTS`

Defaults:

- target score: `88`
- max rounds: `3`
- mode: strict implementation loop

Optional arguments:

- `target=<number>` — override the target score.
- `max_rounds=<number>` — override max implementation rounds.
- `dry-run` or `score-only` — rescan and score only; do not edit files.
- `focus:<area>` — focus the scan on one area, but still score the whole repo.

Use `workflows/architecture-deepening-loop.md` as the operating contract. If the
workflow file is missing, stop and report that the command cannot run.

## Hard Rules

1. Read `CLAUDE.md`, `CONTEXT.md`, `workflows/architecture-deepening-loop.md`,
   and relevant ADRs before scoring or editing.
2. Do not reuse the previous candidate pool. Start from a fresh scan of the
   current worktree.
3. Run `$improve-codebase-architecture` strictly enough to produce a fresh
   baseline: explore the current repo, write/open the HTML report in the OS temp
   directory, and identify current deepening candidates.
4. First output a baseline score with the rubric from the workflow:
   - Module depth: 25
   - Locality: 25
   - Testability: 20
   - Domain clarity: 15
   - Change safety: 15
5. If the score is already at or above the target, stop without editing code.
6. If below target, run at most one candidate per round. Only auto-implement a
   `Strong` candidate, or a clearly low-risk `Worth exploring` candidate.
7. Reject cosmetic cleanup, file splitting without a deeper interface, one-adapter
   abstractions, and broad rewrites.
8. For implementation rounds, use TDD:
   - write a focused failing test first,
   - run it and confirm the expected failure,
   - implement the smallest behavior-preserving change,
   - rerun the focused test.
9. After each round, run focused verification plus:
   - `npm run lint:types`
   - `npm run lint`
   - full `npm test` when touching `src/core`, shared state, adapters, or a
     cross-surface read model.
10. Re-score after every round and stop when:
    - score >= target,
    - max rounds are exhausted,
    - no high-leverage low-risk candidate remains,
    - the next candidate needs ungrilled interface design,
    - verification fails for a reason that is not clearly this round's scoped
      change.

## Output

Use this exact shape at baseline and after each round:

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

If the run is `dry-run` or `score-only`, output the baseline score, current
candidates, and stop decision, then make no file edits.
