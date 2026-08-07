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

## Native Agent Guidance

Governed prompts may instruct the active worker to use the reasoning features
provided by its agent surface, including planning, native subagents, parallel
exploration, or a self-review pass. That is prompt-level execution strategy, not
a tmux-claude-bot service architecture.

Do not add repo-owned prompt changes that assume tmux-claude-bot will manage
researcher, evaluator, planner, or implementation subagents as separate service
entities. The bot should send one bounded WorkOrder to the supervisor/worker
path, then require structured final evidence from the worker. If the worker used
native subagents internally, the final summary should synthesize their findings
into conclusions, evidence, uncertainty, verification, and recommended next
steps rather than exposing raw child-session transcripts as platform state.

When a task benefits from generator/evaluator separation, encode it as a prompt
requirement for an explicit review pass and durable `reviewGate` evidence. Add
service-level orchestration only when the system must own authorization,
cross-run state, recovery, or deterministic acceptance for that role.
Repo-owned eval contracts, artifact writers, and deterministic graders are
allowed when they make evidence consistent and auditable; they must not create or
require a separate evaluator session, worker queue, or bot-managed service role.
Complex, UI/product-experience, PR-review, security, workspace, harness-auto,
and long delegated tasks should record synthesized evaluator-style findings in
`reviewGate.evidence` using `questionInvestigated`, `conclusion`, `evidence`,
`uncertainty`, and `recommendedNextStep`. Small serial tasks may omit this field
when normal `preMutationReview`, `postMutationReview`, and deterministic gates
are enough.

## Task-Family Prompt Methodology

Task-family prompts should make native agent capability useful without turning
tmux-claude-bot into a second agent runtime. For each new or changed task kind,
write the policy fragment by answering these questions:

1. What directions should the worker inspect before choosing action?
2. Which directions are independent enough for native parallel exploration or
   subagents, and which must stay serial because they share state?
3. What evidence proves a candidate is real, valuable, allowed, and verifiable?
4. What uncertainty or skipped scope must be reported instead of hidden?
5. What review pass, rubric, deterministic command, or real user path checks the
   worker's own output?
6. What exact stop condition prevents over-optimization or mechanical busywork?

Use native multi-perspective guidance only when the task is parallelizable,
verifiable, and synthesizable. Good examples include opportunity discovery,
architecture investigation, security surface review, coverage gap comparison,
workspace contract analysis, and PR review passes. Poor examples include tiny
single-file fixes, strictly ordered migrations, unclear product decisions, or
high-conflict edits where multiple workers would overwrite each other.

Prefer prompt language like:

```text
Use native exploration when useful, then synthesize the findings into the final
summary with conclusions, evidence, uncertainty, verification, and recommended
next steps.
```

Avoid prompt language that implies tmux-claude-bot owns internal subagent state:

```text
Start researcher agents, evaluator agents, or child worker queues managed by the
bot service.
```

When a prompt asks for broad exploration, require a compact evidence record for
each material direction:

```text
Question investigated:
Conclusion:
Evidence:
- ...
Uncertainty:
Recommended next step:
```

For code-changing tasks, this record should be summarized in `actionsTaken`,
`reviewGate.preMutationReview`, `reviewGate.postMutationReview`,
`reviewGate.deterministicGates`, `reviewGate.evidence`, or `followUps` as
appropriate. For read-only tasks such as opportunity discovery, it should also
appear in the generated report artifact. Do not persist raw native subagent
transcripts as platform truth unless a separate artifact contract and retention
policy are defined.

## Agentic Coding Prompt Loop

Governed code-changing prompts should guide the active worker through a complete
feedback loop:

```text
Explore -> Plan -> Code -> Verify -> Review -> Record
```

Use this loop as prompt structure, not as a new service state machine:

- Explore before editing. Point the worker at relevant files, tests, logs,
  errors, reports, prior handoff, and system-gate evidence when known.
- Plan the smallest verifiable slice. For complex work, require risk, acceptance
  criteria, stop conditions, and verification commands before mutation.
- Code narrowly. Keep edits inside the WorkOrder boundary and preserve unrelated
  user work.
- Verify with deterministic evidence. Name required commands when they are known;
  otherwise require the narrowest reliable check and a reason when stronger
  verification is unavailable.
- Review the result. Require `reviewGate` evidence for behavior, regression,
  boundary, security, migration, deployment, and over-engineering risk.
- Record the learning. When a run fails or exposes a gap, require the final
  summary to say whether the follow-up belongs in a regression test, eval,
  monitor, trace, checklist, or documentation update.
  The optional `learning` summary field classifies candidates as
  `regressionCandidates`, `capabilityEvalCandidates`,
  `monitorOrTraceCandidates`, and `documentationCandidates`.
  Capability evals are non-blocking learning signals for behavior still being
  explored; regression evals should block only after they protect behavior
  already accepted as working with deterministic or stable agent-backed
  evidence.
  Acceptance targets from planning, task policy, and the WorkOrder JSON must be
  preserved as passed, blocked, or deferred evidence rather than deleted or
  silently narrowed.

Do not treat "the model got worse" as a root cause. Prompt revisions and repair
prompts should ask whether the failure came from routing, session identity,
context loss, prompt/policy drift, reasoning defaults, cache/history behavior,
tool output processing, infrastructure, or missing deterministic gates. If the
failure can recur, the prompt should ask the worker to convert it into a
regression guard or operational signal instead of leaving only a prose lesson.

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
5. Confirm the change uses prompt-level worker guidance rather than adding
   bot-managed subagent orchestration unless service-owned state is required.
6. Confirm the prompt states how exploration findings are synthesized into
   evidence, uncertainty, verification, and next steps.
7. Confirm code-changing prompts cover Explore, Plan, Code, Verify, Review, and
   Record, including how failures become regression tests, evals, monitors,
   traces, checklists, or docs when applicable.
8. Add or update deterministic contract tests for the changed behavior.
9. Update `docs/automation-alignment.md` if the change affects task families,
   WorkOrder behavior, PR review, self-repair, or AI/eval behavior.
10. Update user-facing docs only when the prompt changes visible behavior.
11. Run focused tests and `npm run verify:local` before claiming completion.
