# Remote Security Alerts Implementation Plan

**Goal:** Add passive, bounded denial warnings without changing authorization or normal workflows.

**Architecture:** A shared SecurityAlerts counter receives fixed denial categories. Adapter registrations supply private allowlisted recipients. Ingress and identity guards record events synchronously; detached best-effort delivery cannot block control.

**Tech Stack:** TypeScript, existing i18n catalogs, grammy/Lark adapters and Vitest.

- [ ] Add failing counter tests in tests/security/alerts.test.ts for five-in-ten-minutes, cooldown, bounded sliding window, concurrent events, failure isolation and pending delivery.
- [ ] Add regression assertions in existing ingress and adapter tests for denial categories and unchanged successful/syntax-only handling.
- [ ] Implement src/core/security/alerts.ts; inject its optional capability through HandlerDeps and instantiate it once in bootstrap.
- [ ] Register private configured recipients during adapter startup; record identity, approval, signature and authorization denials without passing user input to alerts.
- [ ] Add localized warning text and fixed reasons to all catalogs; document delivery semantics and unchanged authorization in security and alignment references.
- [ ] Run focused tests and pnpm verify:local, review and commit the slice, fast-forward local dev, verify managed hot reload and unchanged daily security policy, then remove the isolated worktree.
