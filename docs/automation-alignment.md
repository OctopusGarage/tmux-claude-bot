# Automation Alignment Contract

This document is the alignment contract for tmux-claude-bot's agent-facing
instructions, user-facing surfaces, intelligent automation modules, and
maintenance documentation. It exists because this project now has several
surfaces that can drift independently: Claude Code project memory, Codex
`AGENTS.md`, repo skills, `.claude` commands, CLI commands, the TUI, Telegram,
Feishu/Lark, Loop Engineering, Autopilot, Opportunity Discovery, PR review,
Daily Task Audit, Runtime Guardian, and docs.

For the current intelligent-automation business model, read
`docs/intelligent-automation.md`. For user-facing command usage, read
`docs/manual.md`, `docs/commands.md`, `docs/tui.md`, and
`docs/agents/usage-guide.md`. For surface-by-surface feature parity, read
`docs/automation-capability-matrix.md`. For governed system prompts, prompt
metadata, allowed actions, and eval expectations, read
`docs/prompt-governance.md`. For role-based CLI/MCP/skill exposure, read
`docs/ai-tool-surface-governance.md`.

## External Guidance Baseline

Use official tool behavior as the baseline when deciding where a rule belongs:

- Claude Code loads `CLAUDE.md` / `.claude/CLAUDE.md` as project memory. Keep it
  concise and use it for project standards, architecture decisions, build/test
  commands, and review checklists. Larger procedure-like material should move
  into skills or scoped rules.
- Claude Code skills and old `.claude/commands/*.md` both create slash-command
  workflows. Prefer skills for reusable procedures with references, scripts, or
  optional automatic invocation. Keep `.claude/commands` as thin compatibility
  entry points when needed.
- Claude Code hooks are deterministic lifecycle automation. Use hooks for
  enforceable checks around tool use or session lifecycle, not for long business
  explanations.
- Codex reads `AGENTS.md` files as durable repository guidance. Nested
  `AGENTS.override.md` / `AGENTS.md` files can specialize subdirectories.
- Codex skills package repeatable workflows and load only when selected or
  relevant. Use skills for reusable operator recipes; do not put long task
  procedures in always-loaded guidance.
- Codex hooks can observe or block supported tool calls and session events, but
  hook output must stay concise and should not leak secrets.
- ChatGPT/Codex scheduled tasks can run in local projects or isolated worktrees.
  Prefer worktrees for unattended code-changing work; use source worktrees only
  for explicit live/self-repair flows with clean-worktree preflight.

Memory and instruction files are context, not a policy engine. If a rule must be
enforced, add a schema check, contract test, hook, runtime gate, or CI/local
verification command.

## Rule Placement

Use the smallest durable surface that matches the scope:

| Surface | Use For | Do Not Use For |
| --- | --- | --- |
| `AGENTS.md` | Cross-agent repository rules Codex and other coding agents must see immediately. Keep it short, strict, and pointer-heavy. | Long tutorials, historical design notes, or feature matrices. |
| `CLAUDE.md` | Claude Code project memory: development conventions, service/runtime facts, logging, verification, architecture constraints. | Full product manuals or repeated copies of intelligent automation docs. |
| `docs/intelligent-automation.md` | Business truth for Loop Engineering, Supervisor, WorkOrder, Autopilot, Opportunity Discovery, PR review, Daily Task Audit, Runtime Guardian. | Tool-specific memory mechanics or one-off historical plans. |
| `docs/automation-alignment.md` | Alignment checklist and source-of-truth map across agent instructions, docs, commands, channels, config, and tests. | User-facing command reference. |
| `docs/automation-capability-matrix.md` | Surface-by-surface capability parity for CLI, TUI, Telegram, Feishu/Lark, and the home/operator skill. | Deep implementation details or task-family business truth. |
| `docs/ai-tool-surface-governance.md` | Role-based exposure rules for AI-facing CLI, MCP tools, and skills. | Human command manuals or provider-specific SDK integration. |
| `docs/manual.md`, `docs/commands.md`, `docs/tui.md` | Human-facing usage and command behavior. | Internal-only design constraints unless needed to explain user behavior. |
| `docs/agents/usage-guide.md` | AI operator recipes for using the installed bot. | Source-code implementation details that can drift from CLI help. |
| `skills/tcb-home-operator/SKILL.md` | Bundled source for the optional global `tcb-home-operator` Home Operator skill. | A second source of truth for product behavior; link back to docs. |
| `.agents/skills/*` | Codex-compatible repo workflows that should load on demand. | Always-on repo rules. |
| `.claude/skills/*` | Claude Code reusable workflows with references/scripts. | Short one-off reminders that belong in `CLAUDE.md`. |
| `.claude/commands/*` | Legacy/thin slash-command compatibility. Prefer a skill for new reusable workflows. | New long-lived workflow truth. |
| `.claude/rules/*` or nested instruction files | Scoped rules for specific directories/file types when always-loaded files get too large. | Global automation taxonomy. |
| `src/**` schema/gates/tests | Enforced behavior and contracts. | Human-only prose. |

## Alignment Matrix

When adding, renaming, removing, or changing a user-visible or automation-visible
feature, review this matrix in the same slice:

| Feature Area | Must Align |
| --- | --- |
| Chat command | `BOT_COMMANDS`, Telegram handler, Lark command/card action, help text, `docs/commands.md`, i18n catalogs, command tests. |
| Control button/card action | Shared action registry when available, Telegram keyboard/callback parser, Lark card/action parser, TUI when applicable, dangerous-action confirmation, parity tests. |
| CLI command | `src/cli.ts`, control protocol/client/server if socket-backed, `docs/manual.md`, `docs/agents/usage-guide.md`, CLI tests. |
| User personal configuration | Safe operator command surface such as `tcb config ...`, `tcb automation ...`, setup/dedicated commands for credentials, redacted reads, allowlisted non-secret writes, `.env.example`, `docs/manual.md`, `docs/agents/usage-guide.md`, and config/CLI tests. |
| MCP tool or AI tool surface | Role namespace, capability class, typed response contract, control/CLI backing path, actual enforcement layer for role/scope/permission, `docs/ai-tool-surface-governance.md`, docs/tests. |
| External skill/tool dependency | Curated capability catalog, task-family dependency metadata, approved skill registry, install/update/status CLI, doctor check, prompt fallback wording, `docs/agents/skills.md`, docs/tests. |
| Home/operator workspace | `<state-dir>/home` provisioning, `CLAUDE.md`, `AGENTS.md`, README/manifest, skill/MCP role names, control-service provenance checks, docs/tests. |
| TUI action | TUI keymap/help text, control client protocol, user docs, tests. If intentionally unsupported, document the reason. |
| Localized user-facing copy | `Messages` catalog, `SetupMessages` catalog, `UI_LANGS`, Telegram/Lark cards/keyboards/messages, CLI/TUI/help copy when user-facing, setup/onboarding copy, iconography terms, and i18n tests. |
| Notification workflow | Notification event catalog when available, `NotificationGateway`, Telegram sender, Lark sender, project-bound Lark group routing, attachment behavior, delivery evidence, Daily Task Audit visibility, tests. |
| Loop task family | Config schema, task-family governance registry, scheduler, WorkOrder builder, supervisor prompt, execution worktree policy, conflict model, system gate, report/ledger, docs, tests. |
| Workspace task | Project-level behavior plus workspace repository path policy, per-repo PR/branch policy, cross-repo verification, docs/tests proving the task is not architecture-only. |
| Repository-wide PR review | `prReview.repositories` config, GitHub account binding, per-PR review gate, repair policy, mergeability/CI checks, switch-back, docs/tests. |
| Autopilot delegation | Chat command, control socket, Autopilot action registry, Telegram/Lark/TUI button, supervisor queue visibility, active-delegate cancellation boundaries, WorkOrder creation, conflict blocking, notification, opportunity completion when related, docs/tests. |
| Opportunity Discovery | Read-only WorkOrder, dedupe/store, readable Telegram/Lark suggestions, per-item show/discuss/dismiss actions, batch actions, Autopilot handoff, project conflict blocking, docs/tests. |
| Daily Task Audit | Active discovery, ledger merge, self-audit recursion, auto-repair dispatch, final Telegram/Feishu notification, repair-status closure, docs/tests. |
| Runtime Guardian | Runtime artifact detection, evidence threshold, source/isolated worktree policy, self-repair dispatch, clean-worktree gate, cooldown, docs/tests. |
| GitHub operations | Configured `githubAccount`, command-local `GH_TOKEN` from `gh auth token --user`, all `gh api/pr/run/repo` commands, security alert reads, tests. |
| Worktree/session isolation | Source path validation, isolated/source/auto policy, supervisor session, worker session, lease cleanup, ordinary chat blocking, logs/artifacts, tests. |
| AI/eval behavior | Agent-backed/control-surface path only, no direct model-provider SDK/API calls, deterministic fallback, transient agent failure classification/retry boundaries, review/eval evidence, prompt governance metadata, docs/tests. |
| Governed system prompt | Prompt registry metadata, task-family coverage, allowed-action scope, stop condition, active-agent-only boundary, deterministic contract tests, `docs/prompt-governance.md`. |

## Module Alignment Matrix

Use this matrix when a change touches a whole module rather than one command or
task family. It keeps the architecture map in
`docs/intelligent-automation-architecture.md` and
`docs/intelligent-automation-ascii-architecture.md` from drifting away from the
surfaces, state, logs, and tests that actually enforce the system.

| Module | Interface To Preserve | Must Align | Do Not Bypass |
| --- | --- | --- | --- |
| Operator surfaces | Telegram, Feishu/Lark, CLI, TUI, home/operator skill, `.claude` commands, and scheduler triggers are entry points into the same bot behavior. | Command/action handlers, shared action registries, control client/server paths, `BOT_COMMANDS`, i18n/help text, Home Operator workspace provisioning, `docs/manual.md`, `docs/commands.md`, `docs/tui.md`, `docs/agents/usage-guide.md`, `docs/automation-capability-matrix.md`, `docs/ai-tool-surface-governance.md`, and surface tests. | Do not create a feature that works only by injecting a private prompt or one-off script when an existing control path should own it. |
| Control and routing | Requests enter command dispatch, the per-session queue, current-project resolution, confirmation gates, or the local control socket before reaching an agent. | `src/core/command/**`, adapter handlers, control protocol/client/server, TUI callers, dangerous-action confirmation, reply-target handling, and queue/control tests. | Do not let chat, CLI, TUI, or skills invent independent routing semantics for the same action. |
| Session runtime | Ordinary project sessions, Loop Supervisor sessions, Loop worker sessions, and Home Operator sessions have distinct responsibilities, visibility, and workspace rules. | Session naming, project/session catalog, role workspaces in `docs/agent-role-workspaces.md`, open/open-worker behavior, worker leases, idle cleanup, dashboard visibility, conflict blocking, docs, and lifecycle tests. | Do not run WorkOrders in ordinary user chat, expose reserved automation sessions as normal project choices, or start target-project workers from a generic bot-owned home that hides project-local instructions. |
| Project, session, and group model | Projects, workspaces, regular sessions, independent sessions, current-project pointers, recent projects, and Feishu/Lark project groups are one domain model. | `docs/domain/project-session-model.md`, project/session catalog, summary view, recent-project logic, group bindings, current-project state, Telegram/Lark project lists, CLI/TUI project views, i18n copy, and project/session tests. | Do not invent adapter-local vocabulary or action availability rules for project/session/group behavior. |
| Project intake and adoption | New project creation, directory browsing, recent project reopening, independent session creation, unmanaged-agent adoption, and worker opening all create or target sessions. | Path validation, directory browser, recent-project store, open/openPath/openWorker control operations, adopt service, session-path map, allowed-directory policy, docs, and adapter/CLI tests. | Do not trust callback payload paths, create sessions outside the project/session catalog, or bypass configured path and git-toplevel validation for worker/intake flows. |
| Agent runtime and transcripts | Claude and Codex profiles, start/resume commands, flavor aliases, live process detection, activity status, usage snapshots, transcripts, history, inputs, and peek are one runtime model. | Agent profiles/registry, runner base, config resolver, Claude/Codex history readers, runtime records, status install, activity snapshot, dashboard/read views, adapter commands, CLI/TUI views, and runtime tests. | Do not add Claude-only or Codex-only behavior without declaring the intentional difference and updating status/history/resume surfaces. |
| Intent modules | Loop Engineering, Autopilot, Opportunity Discovery, PR review, Daily Task Audit, Runtime Guardian, and Automation Governance Review materialize or inspect WorkOrders through the supervised platform. | Config schema, scheduler/tick logic, task-family governance registry, WorkOrder builder, task-specific supervisor policy, conflict model, notification route, report/ledger artifacts, business docs, and task-family tests. | Do not add side-channel prompts, alternate task ledgers, or feature-specific completion rules outside the WorkOrder/system-gate path. |
| WorkOrder and system gate | WorkOrder is the narrow execution contract; `system-gate.json` is the final acceptance artifact; `handoff.json` / `handoff.md` are the resumable next-round state. | WorkOrder contract types, WorkOrder planning contract, final summary parser/schema, `planReview`, revision prompt contract, transient agent failure classification, verification profile, worktree/branch/PR/CI/merge checks, notification evidence, run artifact registry, report and handoff writing, eval contract/artifact helpers when needed, and gate tests. | Do not accept completion based only on an agent message, PR existence, or a green local command without durable gate evidence. Do not make long-running work depend on chat context alone for recovery. Do not duplicate native worker-agent subagent/planner/evaluator capabilities as bot-managed service roles when prompt guidance and final-summary evidence are enough. Eval contracts may be shared modules; evaluator execution must not become a separate service role without an enforced service-owned requirement. |
| Prompt governance | Governed system prompts are repo-owned automation instructions with metadata, action scope, stop conditions, and eval expectations. | Prompt registry, Loop Supervisor prompt, task-family governance registry, task-family policy fragments, self-repair prompts, prompt contract tests, role-specific skill/tool boundaries, `docs/prompt-governance.md`, and `docs/ai-tool-surface-governance.md`. | Do not add prompt text that can edit code, create PRs, merge, or self-repair without registry metadata and deterministic coverage. |
| Capability dependency registry | Curated external skills/tools are optional or required task-family dependencies, not hidden assumptions about the operator's local environment. | `src/core/capabilities/**`, `LOOP_TASK_FAMILY_GOVERNANCE.capabilities`, `src/core/skills/**`, `tcb capabilities ...`, `tcb loop skills ...`, doctor, governed prompt fallback wording, `docs/agents/skills.md`, and capability contract tests. | Do not let a task prompt depend on an undeclared local skill, silently install third-party code, or reference a missing capability as if it is guaranteed. |
| Prompt library | User-managed prompt browsing, search, tags, retrieval, and send/discuss entry points are separate from governed automation prompts. | Prompt MCP config, promptlib client/parser/view, Telegram/Lark prompt browsers, short-id/tag resolution, disabled-state copy, `docs/manual.md`, `docs/commands.md`, and promptlib/adapter tests. | Do not treat external prompt-library content as governed repo prompt truth or mix prompt-library behavior with system-prompt eval policy. |
| Input enhancement | Voice transcription, prompt translation, recent inputs, and editable rerun drafts improve owner input before it enters the queue without changing task semantics. | Voice support/install/lang, `voice_install`, `voice_lang`, prompt-translation config/install/status, `prompt_translate`, `translate_install`, localized picker/card copy, recent-input cache, Telegram/Lark/control preparation paths, docs, and adapter/i18n tests. | Do not add an input feature on one chat surface without a fallback or documented intentional difference on the other supported surfaces. Do not translate or rewrite a prompt without preserving original-input provenance. |
| Attachments and media | User attachments, notification attachments, downloaded voice/media, cache paths, and validation rules share safety and routing expectations. | Attachment classifier/limits, Telegram/Lark media handlers, `tcb attach`, notification attachments, media cache, reply-target routing, docs, and attachment/media tests. | Do not send unvalidated local paths, bypass size/type checks, or make adapter-specific attachment semantics invisible to diagnostics. |
| Batch scheduler | Batch plans, pools, due schedules, pause/resume/stop/report, and task admission are the generic batch system, not Autopilot or Loop Engineering. | Batch scheduler config/env, plan YAML schema, scheduler store/loop/report, control operations, CLI commands, docs/examples, capability matrix, and scheduler tests. | Do not reuse Autopilot or Loop task terminology for batch plans unless the control path and docs explicitly bridge them. |
| Evidence and observability | Logs, reports, ledgers, runtime artifacts, notification evidence, and debug commands explain what happened without reopening a worker. | Structured log fields, `tcb logs` filters, `tcb loop reports list`, loop run artifact registry, notification event catalog, task audit discovery, runtime guardian evidence, dashboard/task-report views, docs, and regression tests. | Do not write new automation state that cannot be discovered by current diagnostics or separated from unrelated historical noise. |
| Authorization and security policy | Owner allowlists, Feishu/Lark chat policy, group action policy, card signing, control socket permissions, GitHub identity, secret handling, agent tool hooks, and local command boundaries determine who may do what. | Telegram auth, Lark auth/chat-policy/card-signing, control socket hardening, GitHub account/token handling, Claude/Codex `PreToolUse` command guards, setup/doctor checks, security docs, and auth/security tests. | Do not add an action path that bypasses owner authorization, group policy, callback/card verification, configured GitHub identity, or agent-level command interception. |
| State and configuration | Source/docs define product behavior; state/config directories hold live user configuration and runtime truth. | `TCB_STATE_DIR`, `.env` loading, state migrations, app-home/state layout, config examples, project/session bindings, install/dev scripts, `tcb config ...`, `tcb automation ...`, docs, and state/config tests. | Do not hardcode live project lists, user paths, schedules, GitHub accounts, or local cleanup policy in source, tests, or maintained docs. Do not make operators hand-edit state/config files for routine inspection or day-to-day enable/disable flows when a safe command can own the behavior. |
| Deployment and lifecycle | Managed prod, managed dev, foreground dev, setup/install, service controls, single-instance protection, doctor, and smoke checks keep one coherent runtime. | `install.sh`, service scripts, dev helpers, setup flows, managed `dist/` entrypoint, launchd/systemd docs, doctor/smoke checks, and lifecycle tests. | Do not add a process manager, state layout, or dev/prod mode that can run against the same state without instance and migration rules. |
| Setup, install, and onboarding | First-run setup, reconfigure, Lark onboarding, managed install, service materialization, optional dependency install, and doctor are one onboarding lifecycle. | `.env.example`, setup scripts, Lark setup/onboarding wizard, install/service scripts, optional install commands, doctor checks, install docs, and setup/install tests. | Do not introduce a required runtime option without updating setup, `.env.example`, doctor, docs, and managed-install behavior. |
| Localization and copy governance | Chat UI copy, card/button labels, setup/onboarding copy, language pickers, per-channel language settings, supported language list, fallback behavior, and catalog completeness are one product surface. | `src/core/i18n/index.ts`, `src/core/i18n/catalog/*`, `src/core/i18n/setup.ts`, `UI_LANGS`, Telegram/Lark adapters, setup scripts, CLI/TUI/help output when user-facing, `docs/domain/iconography.md`, `tests/core/i18n.test.ts`, and `tests/i18n-hardcoded-copy-contract.test.ts`. | Do not add user-visible copy in adapters, CLI/TUI, setup, cards, notifications, or docs examples without either routing through `Messages`/`SetupMessages` or documenting why it is intentionally nonlocalized. |
| UI vocabulary and iconography | Product terms, semantic icons, tone labels, and shared visual meanings are user-facing domain contracts. | `docs/domain/iconography.md`, `src/shared/ui/icons.ts`, project summary view, action registries, i18n catalogs for localized labels, Telegram/Lark cards/keyboards, docs, and copy/icon tests. | Do not hardcode reusable icons or introduce competing terms such as free project vs independent session in adapters. |
| Quality and release gates | Local and remote gates define when code-changing work is ready to trust. | `npm run verify:local`, pre-push hook, CI workflows, typecheck, tests, coverage, dependency graph, lint, smoke, audit, docs-contract tests, and maintenance docs. | Do not weaken gates for unattended automation; if a gate is too noisy, fix the gate or document a bounded skip with evidence. |

## Drift Audit Checklist

Run this checklist before claiming an automation or cross-surface feature is
complete:

1. Name the canonical module and source of truth.
2. List every user/control surface that should expose it: CLI, TUI, Telegram,
   Feishu/Lark, control socket, home/operator skill, scheduled config.
   Update `docs/automation-capability-matrix.md` when the support shape changes.
3. State any intentional surface difference and the user-facing fallback.
4. Confirm docs mention the feature in the right layer and do not duplicate a
   stale older design.
5. If the feature changes user personal configuration, confirm routine
   inspection and mutation have a command-backed path, secrets are redacted on
   read, generic writes are allowlisted and non-secret, and any unsupported
   config change has a clear setup/dedicated-command fallback.
6. Confirm new or changed user-facing copy is routed through the right
   localization surface: `Messages` for chat/cards/buttons, `SetupMessages` for
   setup/onboarding, docs for prose, or an explicit nonlocalized exception.
7. Confirm generated or installed skills point to the current docs instead of
   copying outdated behavior.
8. Add or update a contract test for every mechanical alignment rule that can
   drift.
9. For governed system prompts, update `docs/prompt-governance.md`, prompt
   metadata, and deterministic prompt contract tests in the same slice.
10. For task-family prompts that mention native subagents, parallel exploration,
   planner, or evaluator behavior, confirm that behavior stays worker-internal
   and that the final artifact records synthesized evidence, uncertainty, and
   verification in `reviewGate.evidence` rather than raw child-session state.
11. For code-changing automation prompts, confirm they guide the worker through
    Explore, Plan, Code, Verify, Review, and Record, including how failures
    become regression tests, evals, monitors, traces, checklists, or docs when
    applicable. Preserve WorkOrder acceptance targets as passed, blocked, or
    deferred evidence, and keep capability evals non-blocking until they
    graduate into stable regression gates.
12. For code-changing automation, prove conflict handling, worktree/session
    isolation, GitHub account binding, verification gates, final notification,
    and audit visibility.
13. For notification features, prove Telegram and Feishu/Lark capability parity,
    and prove Lark project-bound group routing when a session is known.
14. Mark historical documents as historical when they no longer describe current
    behavior.

If an item cannot be aligned in the same slice, document the gap with an owner,
reason, and follow-up test or issue. Do not leave silent drift.

## Enforced Alignment Contracts

The following lists are intentionally explicit because
`tests/alignment-governance-contract.test.ts` treats them as documentation
anchors. When source registries gain or remove an item, update the registry,
docs, and focused contract tests in the same slice.

WorkOrder task kinds:

- `architecture`
- `workspace-architecture`
- `bug-fix`
- `test-coverage`
- `security-maintenance`
- `harness-auto`
- `opportunity-discovery`
- `automation-governance-review`
- `pull-request-review`
- `repository-pull-request-review`
- `active-delegated-task`

Bot-owned notification sources:

- `autopilot-delegate`
- `batch-scheduler`
- `daily-audit`
- `daily-task-audit`
- `long-task-monitor`
- `loop-engineering`
- `opportunity-discovery`
- `runtime-guardian`
- `tmux-claude-bot`

Live operator configuration examples must stay synthetic. Maintained docs and
source must not contain real operator home paths, GitHub accounts, active
project lists, cleanup policy, or schedule settings copied from a running local
installation.

## Known Alignment Gaps To Investigate

No open alignment gaps are currently recorded here.

When a new gap is found, add it here with the affected surfaces, why it cannot
be completed in the current slice, and the test or runtime evidence needed to
close it. Do not leave silent drift in source, docs, skills, commands, or chat
surfaces.
