# Intelligent Automation ASCII Architecture

This diagram is a compact visual map of tmux-claude-bot's operator surfaces,
control path, ordinary project sessions, supervised automation pipeline,
self-healing loops, localization/copy governance, state artifacts, deployment
lifecycle, and release gates.

```text
tmux-claude-bot
local long-running agent orchestration service
================================================================================

OPERATOR SURFACES
--------------------------------------------------------------------------------
 Human UI
 - Telegram owner chat, commands, buttons
 - Feishu/Lark owner chat, project groups, cards
 - Local CLI: tcb ...
 - TUI: tcb tui

 AI operator UI
 - Home Operator session: <projectSessionPrefix>home
 - operator-home scoped tcb-home-operator skill / Codex prompt
 - optional global tcb-home-operator skill / Codex prompt
 - .claude commands and workflows

 System triggers
 - scheduler tick
 - Resource Guardian
 - Daily Task Audit
 - Runtime Guardian
 - PR review schedules
 - GitHub hooks and workflows
                                     |
                                     v
================================================================================
CONTROL + BOT SERVICE
--------------------------------------------------------------------------------
 src/index.ts / tcb run
 - loads config
 - starts adapters
 - starts control socket
 - starts schedulers
 - restores durable occurrence windows and capacity state on demand
 - starts Resource Guardian before notification-driven background services
 - manages project/session state
 - resolves localized UI copy
 - writes logs, ledger, reports
                                     |
       +-----------------------------+-----------------------------+
       |                             |                             |
       v                             v                             v

CONTROL / ROUTING                 NOTIFICATIONS                 DIAGNOSTICS
--------------------------------------------------------------------------------
 core command dispatch             NotificationGateway           dashboard
 per-session queue                 Telegram sender               sysload + Resource Guardian view
 current project pointer           Feishu/Lark sender             logs
 project/session catalog           project-bound Lark routing     doctor
 local unix control socket          attachments                   task report
       |                             |                             |
       v                             v                             v

INPUT ENHANCEMENT
--------------------------------------------------------------------------------
 Voice transcription
 - Telegram voice messages
 - Feishu/Lark audio resources
 - mlx_whisper optional installer: voice_install
 - per-channel recognition language: voice_lang
 - readiness and smoke checks before claiming usable voice

 Prompt translation
 - text and voice prompts before enqueue
 - Argos Translate optional installer: translate_install
 - per-source mode and source language: prompt_translate
 - sources: Telegram, Feishu/Lark, control socket
 - translation failure blocks prompt delivery instead of silently changing intent

 Recent input / rerun
 - keeps original owner input visible
 - records translated vs original text
 - avoids mixing internal compact context into rerun drafts
                                     |
                                     v

LOCALIZATION + COPY GOVERNANCE
--------------------------------------------------------------------------------
 core/i18n
 - Messages catalog: chat, card, button, notification copy
 - SetupMessages catalog: setup and onboarding copy
 - UI_LANGS: supported languages and picker labels
 - per-channel language: TELEGRAM_UI_LANG / LARK_UI_LANG
 - shared fallback: UI_LANG -> DEFAULT_UI_LANG
 - tests: catalog key completeness and non-empty renders
                                     |
                                     v

ORCHESTRATION
--------------------------------------------------------------------------------
 The control path classifies each request into one of three work lanes:

  1. Ordinary interactive work
  2. Supervised automation work
  3. Bot-owned self-work

 All lanes share the same session, queue, runtime, localization, notification,
 evidence, and governance primitives. New automation should deepen this shared
 pipeline rather than inventing a side path.

 Background lanes pass one admission chain before durable reservation and again
 before agent-backed dispatch: occurrence window -> owner activity / interactive
 queue -> quiet hours -> agent capacity -> Resource Guardian. A denial leaves the
 occurrence due and consumes no retry. User work keeps FIFO ordering; official
 exhausted capacity waits rather than bypassing a provider limit.


ORDINARY INTERACTIVE WORK
--------------------------------------------------------------------------------
 ordinary project session
 <projectSessionPrefix><project>
 - human chat context
 - one current project per chat scope
 - start/resume/peek/history/inputs
 - direct owner prompts
 - queue serializes input
                                     |
                                     v
                              tmux session
                                     |
                                     v
                         Claude Code / Codex CLI
                                     |
                                     v
                         capture pane / read history
                                     |
                                     v
                         reply to Telegram / Feishu / TUI


================================================================================
SUPERVISED AUTOMATION PLATFORM
--------------------------------------------------------------------------------

TRIGGERS
--------------------------------------------------------------------------------
 scheduled Loop tick
 /autopilot or "Continue via supervisor"
 opportunity approval
 PR review schedule
 Daily Task Audit repair
 Runtime Guardian finding
 repository-wide PR review
                                     |
                                     v

INTENT MODULES
--------------------------------------------------------------------------------
 Loop Engineering
 - architecture
 - bugFix
 - testCoverage
 - securityMaintenance
 - harnessAuto
 - opportunityDiscovery
 - automationGovernanceReview
 - pullRequestReview

 Autopilot
 - owner-confirmed active delegation

 Opportunity Discovery
 - read-only suggestions before approval

 PR Review
 - loop-created PR review
 - repository-wide all-open-PR processing

 Daily Task Audit
 - retrospective task audit
 - self-check / auto-repair

 Runtime Guardian
 - near-real-time bot runtime self-healing
                                     |
                                     v

WORKORDER CONTRACT
--------------------------------------------------------------------------------
 WorkOrder
 - projectId / workspace id
 - projectPath / repository paths
 - task kind
 - branch / PR / merge policy
 - verification policy
 - worktree isolation policy
 - final summary path
 - artifact paths
 - notification / ledger requirements
                                     |
                                     v

CONFLICT + ISOLATION GATES
--------------------------------------------------------------------------------
 - one code-changing owner per project/branch
 - harnessAuto consumes overlapping child tasks
 - ordinary chat blocks while automation owns project
 - source path verified by git toplevel
 - default code-changing work uses isolated worktree
 - source mode only for explicit live/self-repair
                                     |
                                     v

LOOP SUPERVISOR
--------------------------------------------------------------------------------
 reserved session:
 <projectSessionPrefix>loop-supervisor[-N]

 Responsibilities:
 - read WorkOrder
 - plan bounded work
 - delegate to worker
 - inspect evidence
 - issue revision attempts
 - write strict final summary
                                     |
                                     v

LOOP WORKER
--------------------------------------------------------------------------------
 reserved session:
 <projectSessionPrefix>loop-worker-*

 Responsibilities:
 - execute target-project work
 - run assessment / tests / checks
 - edit code when allowed
 - commit / open PR when configured
 - keep automation context out of human chat
                                     |
                                     v

SYSTEM GATE
--------------------------------------------------------------------------------
 system-gate.json

 Hard checks:
 - final summary format
 - worktree clean state
 - correct branch / switch-back
 - PR URL / report-only reason
 - CI checks
 - mergeability
 - auto-merge result
 - local base branch rebase onto origin
 - verification commands
 - notification delivery evidence

        accepted=false                         accepted=true
              |                                      |
              v                                      v
 bounded revision prompt                    ledger / report / notification
 same supervisor                            release worker or retain evidence
              |
              v
 retry until accepted,
 blocked, timeout, or
 max revision attempts


================================================================================
STATE, LOGS, AND EVIDENCE
--------------------------------------------------------------------------------

 <state-dir>
--------------------------------------------------------------------------------
 .env and runtime state
 logs/
 loop-runs/
 task ledger
 supervisor reports
 system-gate.json
 worker leases
 notification evidence
 run history

 Used by:
 - dashboard
 - logs
 - Resource Guardian
 - Daily Task Audit
 - Runtime Guardian
 - human debugging
 - follow-up repair WorkOrders


================================================================================
RESOURCE GUARDIAN
--------------------------------------------------------------------------------

 host CPU/load sampling + typed sampling health
        |
        v
 sustained pressure policy + durable incident evidence
        |
        +-- healthy / observe -> background admission open
        |
        +-- degraded / protect -> background admission closed
                                   |
                                   v
                  revalidate bot-owned process ownership
                                   |
                  bounded cooperative cancellation / signal
                                   |
                     stable recovery window
                                   |
                                   v
                 global Repair Coordinator
                 -> at most one repair WorkOrder

 Operator controls:
 - tcb resource status / incidents / mode / profile
 - sysload includes Resource Guardian context

 Resource Guardian owns host-pressure admission and bounded emergency action.
 Runtime Guardian below owns durable runtime-artifact healing; it must obey the
 Resource Guardian circuit before reserving background work.


================================================================================
DAILY SELF-HEALING LOOP
--------------------------------------------------------------------------------

Daily Task Audit
--------------------------------------------------------------------------------
 expected schedules
 + ledger
 + loop run artifacts
 + notification evidence
 + previous audit result
        |
        v
 classify:
 success / skipped / failed / missing / inconsistent
        |
        v
 send Telegram / Feishu summary
        |
        v
 if TASK_AUDIT_AUTO_REPAIR=true:
   confirmed tmux-claude-bot-owned issue
        |
        v
   repair WorkOrder -> Supervisor -> Worker -> System Gate


Runtime Guardian
--------------------------------------------------------------------------------
 runtime artifact watcher
 - invalid-output
 - missing system-gate.json
 - stale worker lease
 - inconsistent terminal state
        |
        v
 mode=observe      -> log evidence only
 mode=fast-heal    -> repair WorkOrder for tmux-claude-bot itself


================================================================================
CONFIGURATION, STATE, AND LOCAL TRUTH
--------------------------------------------------------------------------------

 <state-dir>
--------------------------------------------------------------------------------
 - .env and environment-derived runtime settings
 - loop configuration and schedule state
 - project/session mappings and current-project pointers
 - Telegram / Feishu / Lark binding state
 - voice transcription and prompt translation settings
 - Resource Guardian current state, operator overrides, and incidents
 - operator home directory when not explicitly configured

 Rules:
 - defaults to ~/.tmux-claude-bot/state; TCB_STATE_DIR may override it
 - runtime state lives in the state directory, not the install root
 - source code and docs carry product behavior
 - local state carries active user configuration
 - deploys must not overwrite live state
 - migrations move state forward before config is loaded


================================================================================
DEPLOYMENT AND LIFECYCLE
--------------------------------------------------------------------------------

 install / setup
--------------------------------------------------------------------------------
 - install.sh / tmux-claude-bot install
 - tcb setup / tcb setup:lark
 - tcb skill install
 - optional feature installers: whisper, Argos Translate

 managed service
--------------------------------------------------------------------------------
 - macOS launchd
 - Linux systemd --user
 - service status / logs
 - pause / resume / restart
 - dev mode: hot reload from the repository
 - prod mode: bundled dist from the managed install directory

 lifecycle concerns
--------------------------------------------------------------------------------
 - single-instance protection
 - keep-awake behavior
 - state-safe deploy layout
 - doctor and smoke checks
 - clean handoff between dev and prod service modes


================================================================================
QUALITY AND RELEASE GATES
--------------------------------------------------------------------------------

 local gates
--------------------------------------------------------------------------------
 - npm run verify:local
 - pre-push hook
 - typecheck, tests, coverage, knip, dependency graph, lint, smoke, audit

 remote gates
--------------------------------------------------------------------------------
 - GitHub Actions CI on Linux and macOS
 - security scans
 - Dependabot workflow
 - release and npm publish workflows

 Principle:
 - unattended automation may create or update code only when it can leave
   durable evidence and pass the configured gates for that work type.


================================================================================
DOCUMENTATION / GOVERNANCE
--------------------------------------------------------------------------------

 docs/README.md
 - documentation map

 docs/intelligent-automation.md
 - automation business truth

 docs/intelligent-automation-architecture.md
 - end-to-end architecture and drift controls

 docs/automation-alignment.md
 - cross-surface alignment rules

 docs/automation-capability-matrix.md
 - CLI / TUI / Telegram / Feishu / skill parity

 tests/docs-contract.test.ts
 - docs indexed
 - CLI docs match source
 - Autopilot semantics stay current
 - maintained docs stay English

 tests/core/i18n.test.ts
 - UI language list stays complete
 - chat catalogs keep the same key set
 - setup catalogs keep the same key set
 - localized copy renders non-empty

 AGENTS.md / CLAUDE.md
 - always-loaded rules
 - AI boundary
 - verification rules
 - documentation/comment language rule


================================================================================
CORE PRINCIPLE
--------------------------------------------------------------------------------

AI agents may reason and execute.
The bot system owns coordination, isolation, durable evidence, and final gates.

No task is complete because an agent says so.
A task is complete only when the system gate accepts the evidence.
```
