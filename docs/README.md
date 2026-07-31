# Documentation Map

This directory separates current source-of-truth documents from future notes,
examples, and agent-facing references. When two documents disagree, prefer
current maintained docs, source code, and tests over future notes.

All maintained documentation must be written in English. Source comments and
test comments should also be English. Localized user-facing strings are allowed
only in i18n catalogs, UI fixtures, and tests that intentionally verify localized
behavior.

## Current Maintained Docs

| Document | Purpose |
| --- | --- |
| `manual.md` | Human user manual for install, setup, chat workflows, CLI usage, automation, and troubleshooting. |
| `commands.md` | Telegram and Feishu/Lark chat command reference. |
| `cli-reference.md` | Maintained `tcb` command, subcommand, and option surface. |
| `tui.md` | Terminal UI guide. |
| `TESTING.md` | Testing strategy and local verification rules. |
| `agents/usage-guide.md` | AI operator recipes for helping users operate the bot. |

## Intelligent Automation Docs

| Document | Purpose |
| --- | --- |
| `intelligent-automation.md` | Business truth for Loop Engineering, task families, Autopilot, Opportunity Discovery, PR review, Daily Task Audit, and Runtime Guardian. |
| `intelligent-automation-architecture.md` | End-to-end automation architecture, session model, WorkOrder pipeline, gates, and drift controls. |
| `intelligent-automation-ascii-architecture.md` | ASCII architecture diagram for the automation platform and self-healing loops. |
| `automation-alignment.md` | Rule placement, cross-surface alignment checklist, and drift governance. |
| `automation-capability-matrix.md` | CLI/TUI/Telegram/Feishu/Home-operator feature parity matrix. |
| `agent-maintenance-guidelines.md` | Runtime, logging, notification, GitHub, service, and verification maintenance guidance. |

## Architecture And Domain

| Directory | Purpose |
| --- | --- |
| `adr/` | Accepted architecture decisions. These are historical decisions that remain useful when changing related code. |
| `domain/` | Implementation-facing domain models and vocabulary rules. |
| `agents/` | Agent-facing issue tracker, triage, skill, domain, and usage references. |

## Examples And Future Notes

| Directory | Status |
| --- | --- |
| `examples/` | Maintained config examples. Keep examples aligned with schemas and tests. |
| `future/` | Future design notes. Not current runtime truth. Excluded from Context7 indexing. |

## Cleanup Rules

- Delete one-off implementation plans once the work is complete and the result is
  covered by maintained docs, code, or tests.
- Move still-useful future design material into `future/` and mark it as
  non-current.
- Keep accepted decisions in `adr/`; do not merge ADRs into manuals.
- Keep user-facing commands in `manual.md`, `commands.md`, `cli-reference.md`,
  and `tui.md`; do not duplicate full command tables in architecture docs.
- Keep automation business rules in `intelligent-automation.md`; keep the
  end-to-end module view in `intelligent-automation-architecture.md`.
- Add or update a docs-contract test when a document becomes part of the
  maintained source-of-truth set.
