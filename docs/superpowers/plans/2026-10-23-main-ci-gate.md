# Main CI Gate Implementation Plan

**Goal:** Push committed work and enforce passing PR CI before main can merge.

**Architecture:** GitHub branch protection enforces required check contexts and administrator compliance. The CI verify job validates all dependency results, with workflow contract tests guarding complete dependencies and failure behavior.

- [ ] Add failing tests in tests/ci-workflow.test.ts executing the workflow gate with success, failure, cancellation, skip, neutral and missing results; assert verify depends on all other CI jobs.
- [ ] Change .github/workflows/ci.yml verify to consume join(needs.*.result, ' ') and require a nonempty set containing only success.
- [ ] Document the required checks and server enforcement in docs/TESTING.md and docs/automation-alignment.md.
- [ ] Run focused tests and pnpm verify:local, commit and fast-forward local dev.
- [ ] Preserve existing main protection settings while updating required checks, confirm administrator enforcement and PR requirements, push dev through the pre-push hook, and verify the remote commit and merge gate.
