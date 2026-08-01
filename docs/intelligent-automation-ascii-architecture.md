# Intelligent Automation ASCII Architecture

This diagram is a compact visual map of tmux-claude-bot's user surfaces,
ordinary project sessions, supervised automation pipeline, self-healing loops,
state artifacts, and documentation governance.

```text
tmux-claude-bot
local long-running agent orchestration service
================================================================================

USER / OPERATOR SURFACES
--------------------------------------------------------------------------------
 Telegram              Feishu/Lark              Local CLI              TUI
 owner chat            owner chat + groups      tcb ...                tcb tui
 commands/buttons      cards/buttons            scripts/admin          keyboard UI
      |                      |                      |                      |
      +----------------------+----------------------+----------------------+
                                     |
                                     v
================================================================================
BOT SERVICE
--------------------------------------------------------------------------------
 src/index.ts / tcb run
 - loads config
 - starts adapters
 - starts control socket
 - starts schedulers
 - manages project/session state
 - writes logs, ledger, reports
                                     |
       +-----------------------------+-----------------------------+
       |                             |                             |
       v                             v                             v

CONTROL / ROUTING                 NOTIFICATIONS                 DIAGNOSTICS
--------------------------------------------------------------------------------
 core command dispatch             NotificationGateway           dashboard
 per-session queue                 Telegram sender               sysload
 current project pointer           Feishu/Lark sender             logs
 project/session catalog           project-bound Lark routing     doctor
 local unix control socket          attachments                   task report
       |                             |                             |
       v                             v                             v

ORDINARY PROJECT WORK
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
INTELLIGENT AUTOMATION PLATFORM
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
 - local base branch fast-forward
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

 ~/.tmux-claude-bot/
--------------------------------------------------------------------------------
 config / state
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
 - Daily Task Audit
 - Runtime Guardian
 - human debugging
 - follow-up repair WorkOrders


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
