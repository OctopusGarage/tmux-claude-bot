# Remote Access Security Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for the
> isolated security module, followed by integration and independent review.

**Goal:** Add enrollable second-factor remote authorization without interrupting
existing installations or independent scheduled maintenance.

**Architecture:** A core service owns persistent enrollment/revocation and volatile
chat grants. Thin channel guards establish authorization context; queued commands
capture and revalidate the original grant before terminal delivery.

**Tech Stack:** TypeScript, Node filesystem/crypto, TOTP, grammY, Lark SDK, Vitest.

## Task 1: Authorization service and local administration

- [x] Add failing behavioral tests for enrollment, TTL, principal scope, replay,
  guessing, restart, state corruption and revocation under `tests/security/`.
- [x] Implement `src/core/security/remote-access.ts` and private state storage.
- [x] Add `src/cli/security-commands.ts` and register `tcb security` in `src/cli.ts`.
- [x] Verify targeted tests and type checks; review API before integration.

## Task 2: Request provenance and delivery checks

- [x] Add failing tests for queue capture, missing metadata, expired grants and
  remote-origin work marked as system work.
- [x] Add `src/core/security/context.ts`, optional service dependency in
  `src/core/deps.ts`, and initialization in `src/bootstrap.ts`.
- [x] Stamp queue messages from context without persisting grants; recheck in
  `src/core/command/dispatch.ts` after asynchronous readiness and before effects.
- [x] Verify ordinary local/system messages remain operational.

## Task 3: Channel guards and approval workflows

- [x] Add adapter tests for private approval, group-origin grants, media and
  callbacks, lock behavior, and unenrolled compatibility.
- [x] Integrate Telegram guard after identity allowlist and before all handlers.
- [x] Integrate Lark message and signed-card guards before effects and carry
  authorization through asynchronous handlers.
- [x] Preserve current routing, project selection and background maintenance.

## Task 4: Documentation, review, integration and hot deployment

- [x] Update alignment, CLI reference, chat command guide, usage guide and security
  documentation, explaining migration and same-user compromise limitations.
- [x] Run `pnpm verify:local`, fix regressions, and independently review the diff.
- [ ] Commit the verified slice; integrate into local `dev` while keeping main
  untouched. Install required dependencies before managed source adoption.
- [ ] Verify the running revision, service health, config compatibility and clean
  worktree. Leave enrollment to the operator's private interactive terminal.
