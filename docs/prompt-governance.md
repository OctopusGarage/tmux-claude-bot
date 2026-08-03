# Prompt Governance

This document is the source of truth for tmux-claude-bot's governed system
prompts. It exists so prompt changes can be reviewed, tested, scored, and kept
aligned with Loop Engineering, WorkOrder gates, self-repair, PR review, and
automation documentation.

For the automation business model, read `docs/intelligent-automation.md`. For
cross-surface drift checks, read `docs/automation-alignment.md`.

## Scope

A governed system prompt is any repo-owned prompt template or policy fragment
that can influence agent-backed automation to inspect repositories, change code,
commit, create PRs, merge PRs, repair tmux-claude-bot, or report final gate
evidence.

Governed prompts include:

| Prompt Family | Current Owner | Purpose |
| --- | --- | --- |
| Loop Supervisor | `src/core/loop/work-order.ts`, `src/core/loop/work-order-contract.ts`, `src/core/loop/final-summary-contract.ts` | Main WorkOrder prompt, WorkOrder contract, finalization prompt, revision prompt, final summary contract, and deterministic gate instructions. |
| Loop task policies | `src/core/prompts/loop-task-policies.ts`, `src/core/loop/task-family.ts` | Task-family policy fragments and governance metadata for architecture, bug-fix, test-coverage, security-maintenance, harness-auto, opportunity-discovery, automation-governance-review, PR review, repository PR review, and active delegation. |
| Daily Task Audit repair | `src/core/tasks/task-repair.ts` | Scheduled task audit repair prompt for tmux-claude-bot task scheduling/reporting failures. |
| Runtime Guardian repair | `src/core/runtime-guardian/service.ts` | Near-real-time runtime repair prompt for confirmed tmux-claude-bot runtime artifacts. |
| Legacy Loop runner prompts | `src/core/loop/run.ts` | Command-backed Loop eval, agent task, preflight repair, dirty-worktree recovery, verification recovery, and post-commit recovery prompts. |
| Opportunity discussion | `src/core/opportunities/view.ts` | Discussion prompts for proposed opportunities before implementation. |
| Repo workflows | `.claude/workflows/`, `.claude/commands/`, `.agents/skills/` | Operator-triggered audit and architecture-loop workflows. |

Explicitly excluded from governed system prompt registry:

- User-entered chat text, `tcb send` text, TUI composer text, and voice-derived
  user input.
- External prompt library content fetched through prompt-library MCP tools.
- Prompt translation output derived from a user's own input.
- Ordinary UI copy, setup wizard questions, confirmation messages, and i18n
  strings.

Excluded prompts can still require product tests, but they are not governed
automation prompts unless they become repo-owned automation instructions.

## Action Matrix

| Prompt Category | Read Repo | Change Code | Commit | Create PR | Auto-Merge |
| --- | --- | ---: | ---: | ---: | ---: |
| Loop Supervisor main | Yes | Policy-controlled | Policy-controlled | Policy-controlled | Policy-controlled |
| Finalization / revision | Yes | Only to finish or repair the same WorkOrder | Policy-controlled | Policy-controlled | Policy-controlled |
| Architecture | Yes | Yes | Yes | Policy-controlled | Policy-controlled |
| Bug fix | Yes | Yes, only confirmed bugs | Yes | Policy-controlled | Policy-controlled |
| Test coverage | Yes | Yes, only meaningful test or narrow testability work | Yes | Policy-controlled | Policy-controlled |
| Security maintenance | Yes | Yes, only confirmed or plausibly reachable risk | Yes | Policy-controlled | Policy-controlled |
| Harness auto | Yes | Only selected justified subtasks | Yes | Policy-controlled | Policy-controlled |
| Opportunity discovery | Yes | No | No | No | No |
| Automation governance review | Yes | Only P0/P1 confirmed tmux-claude-bot issues when configured | Yes | Yes, when configured | No |
| PR review | Yes | Repair policy-controlled | Repair policy-controlled | Existing PR only | Policy-controlled by PR review config |
| Daily Task Audit repair | Yes | Only tmux-claude-bot task/audit/dispatch logic | Yes | Supervisor-controlled | Supervisor-controlled |
| Runtime Guardian repair | Yes | Only tmux-claude-bot runtime/orchestration logic | Yes | Supervisor-controlled | Supervisor-controlled |
| Opportunity discussion | Yes | No | No | No | No |

When a task has `Policy-controlled` permissions, the WorkOrder, config, system
gate, GitHub checks, and final summary contract must all agree before the action
is accepted.

## Required Prompt Contract

Every governed prompt that can affect code or PR state must state or inherit:

- The bounded task and its stop condition.
- The authoritative repository path or workspace repository paths.
- The allowed and blocked actions.
- The requirement to preserve unrelated user work.
- The active-agent-only AI capability boundary.
- The prohibition on direct model-provider SDKs, API keys, or HTTP integrations.
- The evidence required before editing.
- The verification required after editing.
- The final reporting contract.

Read-only governed prompts must also explicitly prohibit implementation, commit,
PR creation, and auto-merge.

## Prompt Metadata

Each governed prompt should have metadata in the prompt registry:

| Field | Meaning |
| --- | --- |
| `id` | Stable prompt id used by tests and reports. |
| `version` | Integer version incremented for behavior-changing prompt edits. |
| `owner` | Owning runtime module or workflow. |
| `audience` | Agent or operator surface that consumes the prompt. |
| `riskLevel` | `low`, `medium`, or `high`. |
| `actionScope` | Highest action the prompt can authorize: read-only, code-change, commit, PR creation, or auto-merge. |
| `evalExpectation` | Whether deterministic contract tests, active-agent eval, or real WorkOrder smoke tests are expected. |
| `legacy` | Whether the prompt belongs to a supported legacy path. |

Prompt metadata is part of the module interface. Prompt prose is implementation
detail behind that interface.

Task-family policy prompts must also stay aligned with the task-family
governance registry in `src/core/loop/task-family.ts`. The registry owns the
machine-checkable facts for scheduling, action scope, owner confirmation,
planning, AI/eval expectations, default isolation, and stop rules; prompt prose
must elaborate those facts rather than redefine them.

## Eval And Verification

Prompt eval in this project is active-agent-only. Do not add OpenAI, Anthropic,
Gemini, AI SDK, or other model-provider clients to evaluate prompts.

Use the governed prompt CLI to inspect and prepare evaluations:

```bash
tcb prompts governed list --json
tcb prompts governed show loop.policy.test-coverage
tcb prompts governed render loop.policy.test-coverage --fixture default
tcb prompts governed check --json
tcb prompts governed eval --all --output /tmp/tcb-prompt-eval.md
```

`render` is a deterministic inspection command for supported runtime prompts. It
uses built-in synthetic fixtures and does not execute automation. Docs-only,
legacy, or operator workflow prompts that do not have a stable runtime renderer
must fail explicitly instead of rendering an unrelated placeholder.

`eval` generates the task prompt for an active Claude Code / Codex review. It is
not a model-provider client and does not perform hidden network AI calls.

Use these gates:

| Change Type | Required Gate |
| --- | --- |
| Documentation-only prompt inventory update | Docs review plus `npm run verify:local` when practical. |
| Prompt metadata change | Registry completeness tests. |
| Loop Supervisor contract change | Contract tests for final marker, summary schema, deterministic gates, timeout rule, active-agent boundary, and model-provider prohibition. |
| Task-family policy change | Contract tests for action scope, stop condition, and task-specific safety rules. |
| Self-repair prompt change | Tests proving repair is limited to tmux-claude-bot system logic and requires evidence, verification, and commit discipline. |
| Runtime prompt render change | CLI render tests proving the selected fixture exposes the expected prompt family and safety boundaries. |
| High-risk behavioral prompt change | Real supervised WorkOrder smoke test or documented blocker, plus deterministic tests. |

AI review may be recorded as advisory evidence. Deterministic gates remain the
acceptance authority.

## Scoring Rubric

Prompt governance is scored out of 100:

| Dimension | Target |
| --- | ---: |
| Discoverability | 90 |
| Runtime clarity | 92 |
| Policy consistency | 92 |
| Eval readiness | 88 |
| Change safety | 90 |
| Modularity | 88 |
| Documentation alignment | 90 |

Stop the prompt-governance initiative once the overall score is at least 90 and
no dimension is below 85. Do not continue opportunistic prompt cleanup beyond
that point unless there is a concrete P0/P1 issue or explicit user request.

## Change Checklist

When adding or changing a governed prompt:

1. Add or update prompt metadata.
2. Confirm whether the prompt can read, edit, commit, create PRs, or merge.
3. Confirm the stop condition and anti-over-optimization rule.
4. Confirm active-agent-only AI boundaries remain explicit.
5. Add or update deterministic contract tests for the changed behavior.
6. Update `docs/automation-alignment.md` if the change affects task families,
   WorkOrder behavior, PR review, self-repair, or AI/eval behavior.
7. Update user-facing docs only when the prompt changes visible behavior.
8. Run focused tests and `npm run verify:local` before claiming completion.
