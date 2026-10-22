# Remote Access UX Implementation Plan

**Goal:** Apply the operator-approved admission-only, configurable daily authorization policy.

**Architecture:** Keep the shared ingress guard. Remove queue and dispatch authorization plumbing. Store grant duration alongside existing durable local security policy.

**Tech Stack:** TypeScript, Zod, Commander, Vitest.

- [ ] Add failing integration tests in `tests/security/delivery.test.ts` proving admitted messages execute after locking/expiry while fresh ingress is denied.
- [ ] Add service and CLI tests for 24-hour default, configurable whole hours, persistence and invalid inputs.
- [ ] Remove security additions to queue, dispatch and delegated-task; delete unused security context and its obsolete tests. In ingress call `service.capture(principal)` once before running handlers.
- [ ] Add `grantTtlSeconds` with a schema default of 86400 and `setGrantHours(hours)` validating positive safe whole hours; add `tcb security grant-hours <hours>`.
- [ ] Render the configured hours in all approval/request catalogs and update security/alignment/CLI/command/manual/usage documentation.
- [ ] Run focused security and queue tests, type checks and `pnpm verify:local`; inspect the diff, commit, fast-forward local dev, set local grant-hours to 24 and restart/verify the existing managed dev service.
