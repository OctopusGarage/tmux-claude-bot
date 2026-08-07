# AI Tool Surface Governance

This document defines how tmux-claude-bot should expose capabilities to AI
agents through skills, MCP tools, CLI commands, and the control socket. It
exists to prevent a single all-powerful tool surface from bypassing the business
boundaries already enforced by WorkOrders, supervisor sessions, worker
isolation, system gates, Daily Task Audit, and Runtime Guardian.

For automation terminology and task-family behavior, read
`docs/intelligent-automation.md`. For cross-surface alignment rules, read
`docs/automation-alignment.md`. For human/operator capability parity, read
`docs/automation-capability-matrix.md`.

## Core Principle

Expose AI-facing tools by **business role**, not by implementation convenience.
CLI, MCP, and skills are different surfaces over the same service model:

- CLI is the stable human/script entry point.
- MCP tools are structured, schema-driven, AI-callable capabilities.
- Skills are role-specific operating instructions, stop conditions, and risk
  boundaries.
- The control socket and service code remain the authoritative runtime behavior.

Do not add a generic `tcb(command: string)` MCP tool as the primary interface.
That only wraps a shell and leaves discovery, parsing, permissions, and risk
classification to the model. Prefer small tools with typed parameters,
structured responses, role scope, and audit evidence.

## Feasibility And Tool Boundaries

This design must stay grounded in what the agent surfaces actually provide.
MCP, skills, CLI commands, hooks, and tmux sessions are complementary layers;
none of them is a complete authorization system by itself.

Verified external behavior:

- MCP servers can expose structured tools to AI clients, but MCP does not
  provide this project's business roles (`observer`, `home`, `supervisor`,
  `worker`, `guardian`, `audit`) automatically. Those roles must be enforced by
  tmux-claude-bot's MCP server/control service, separate server registrations,
  or client-side tool enablement where a client supports it.
- Claude Code supports personal and project skills. Skills are instruction
  packages and may include references/scripts, but they are not hard permission
  boundaries. A globally installed Home Operator skill must not be treated as
  authority to mutate every project.
- Codex exposes MCP management through `codex mcp` and uses repository
  instructions such as `AGENTS.md`, but the bot must not assume Codex will
  enforce tmux-claude-bot's role profiles. Role and scope checks belong in the
  bot-owned server/control path.
- Claude Code project-scoped MCP configuration can require approval before a
  server is connected. That is useful for operator consent, but it does not
  replace per-tool validation once a server is approved.
- Local MCP servers and skills can run with meaningful local filesystem/process
  reach. Treat every mutating tool as server-side privileged code and validate
  target identity, WorkOrder scope, conflict state, and capability class before
  doing work.

Practical consequence:

- The first MCP milestone is `observer` only. Current implemented tools are
  `tcb.observer.status`, `tcb.observer.projects`, `tcb.observer.sessions`,
  `tcb.observer.queue`, `tcb.observer.logs_query`, and
  `tcb.observer.loop_reports_list`, `tcb.observer.daily_task_audit`, and
  `tcb.observer.runtime_guardian_findings`, served by `tcb mcp observer` over
  stdio.
- The first Home MCP milestone is controlled operation only. `tcb mcp home`
  exposes all Observer tools plus `tcb.home.send_prompt` and
  `tcb.home.delegate_autopilot`. Both require an explicit target session and
  call existing control-service queue, conflict, and WorkOrder gates.
- `home` mutation can follow only through explicit target identity and existing
  control-service conflict checks. It must not expose arbitrary shell execution,
  direct file edits, PR merge operations, or WorkOrder internals.
- `supervisor`, `worker`, `guardian`, and `audit` tools should remain
  WorkOrder/finding-bound. They should not be exposed as generic shell-command
  or arbitrary-file tools.
- Do not expose service-managed `researcher`, `planner`, `evaluator`, or
  subagent tools only to mirror native Claude Code or Codex agent capabilities.
  Those roles belong in governed worker prompts unless the bot must own
  authorization, persisted state, recovery, or deterministic acceptance for the
  role.
- Namespaces such as `tcb.worker.*` improve discovery and model behavior, but
  they are not security. Unknown or untrusted profiles must expose only
  read-only observer tools.
- For local stdio MCP, do not claim OAuth-style user authentication unless the
  specific client/server path implements it. Prefer explicit profile
  configuration, local socket authorization, file permissions, and visible
  `doctor` diagnostics.

Reference material used for this boundary: MCP specification and local-server
docs, Claude Agent Skills and MCP connector docs, Codex CLI MCP docs, AGENTS.md
instruction precedence, and NSA MCP security guidance.

## Canonical Role Package Names

Use role-specific names for new skills, MCP profiles, generated config files,
and documentation. Role surfaces should use the canonical names below instead
of generic package or repository names.

| Canonical Name | Role | Purpose |
| --- | --- | --- |
| `tcb-home-operator` | Home Operator | Owner-facing discovery, diagnosis, queue inspection, and controlled delegation. |
| `tcb-observer` | Observer | Read-only status, logs, reports, queues, and findings. |
| `tcb-loop-supervisor` | Loop Supervisor | WorkOrder orchestration and final summary production. |
| `tcb-loop-worker` | Loop Worker | Bounded WorkOrder execution in a declared project/worktree scope. |
| `tcb-runtime-guardian` | Runtime Guardian Repair | Bot-owned runtime finding review and self-repair delegation. |
| `tcb-daily-audit-repair` | Daily Audit Repair | Bot-owned scheduled-task audit review and self-repair delegation. |

Do not use names such as `tmux-claude-bot-admin`, `tcb-all`, or
`tcb-shell`. They obscure role boundaries and encourage broad mutation.

## Business Roles

| Role | Purpose | Typical Session | May Mutate | Must Not Do |
| --- | --- | --- | --- | --- |
| Home Operator | Central local role for discovery, diagnosis, queue inspection, and owner-approved delegation. | Home/operator agent or ordinary local operator context. | Low-risk control actions and owner-confirmed delegation. | Directly edit target project files, bypass supervisor/system gates, or merge PRs. |
| Loop Supervisor | Orchestrates one bounded WorkOrder, assigns worker work, requests revisions, and writes the final summary. | Reserved `loop-supervisor[-N]`. | Only through the WorkOrder policy and worker/control paths. | Act as final acceptance authority or operate outside the WorkOrder scope. |
| Loop Worker | Performs bounded target-project work in the configured project/workspace path. | Reserved `loop-worker-*`. | Only inside declared WorkOrder paths and policies. | Access unrelated projects, trigger global audits, manage supervisor sessions, or change bot configuration unless the WorkOrder targets the bot. |
| Runtime Guardian Repair | Repairs tmux-claude-bot runtime/orchestration problems found by Runtime Guardian. | Supervisor-backed active delegation. | Only tmux-claude-bot self-repair paths. | Repair target-project application code mentioned by a failed WorkOrder. |
| Daily Audit Repair | Repairs tmux-claude-bot task scheduling, ledger, dispatch, and reporting problems found by Daily Task Audit. | Supervisor-backed active delegation. | Only bot scheduling/audit/reporting behavior. | Treat every target-project failure as bot code to change. |
| Project Agent | Human-facing project chat agent. | Ordinary project session. | User-directed project work inside the active project context. | Own long-running WorkOrders, bypass automation conflict blocks, or manage global automation state. |
| Observer | Read-only diagnostic role for status, logs, reports, and artifacts. | Any authorized local AI context. | No. | Send prompts, start delegation, cancel work, repair, or mutate state. |

## Installation Scope And Isolation

Skill and MCP installation scope is a separate boundary from runtime role. Treat
these as three different layers:

1. **Installation scope** determines where the agent discovers a skill or MCP
   server.
2. **Runtime role** determines what that agent is allowed to do.
3. **Business scope** determines which project, WorkOrder, finding, or session a
   tool call may affect.

Do not assume a globally installed skill or MCP server implies global mutation
authority. Do not assume a project-local skill can safely manage other projects.

| Scope | Examples | Intended Use | Isolation Requirement |
| --- | --- | --- | --- |
| Global user install | `~/.claude/skills/tcb-home-operator/SKILL.md`, `~/.codex/prompts/tcb-home-operator.md`, user-level MCP config | Explicit opt-in convenience for users who want Home Operator discovery from arbitrary repositories. Not managed-install default. | Must default to discovery/read-only or explicit owner-approved control; mutating calls still need service authorization, conflict checks, and target identity. |
| Operator workspace | `<state-dir>/home/CLAUDE.md`, `<state-dir>/home/AGENTS.md`, `<state-dir>/home/skills/*`, `<state-dir>/home/mcp/*` | Persistent Home Operator session context. | Useful provenance signal for operator-only actions, but not a hard security boundary. Validate through the control service. |
| Project-local repo skill | `.agents/skills/*`, `.claude/skills/*`, repository `AGENTS.md`/`CLAUDE.md` | Repo-specific workflows while editing tmux-claude-bot or another project. | Must not grant cross-project bot administration unless the user intentionally loads the Home Operator skill or MCP profile. |
| WorkOrder-bound prompt/skill policy | Supervisor and worker instructions embedded in governed prompts or future role skills. | Bounded automation execution. | Must require `workOrderId` and persisted WorkOrder scope; cannot be reused as a general-purpose operator tool. |
| External MCP client install | Third-party client configured to call a local `tcb` MCP server. | Structured local automation access from another AI surface. | Must run read-only by default unless the server has explicit local profile/authorization; never rely on obscurity of localhost alone for high-risk tools. |

The bundled source skill lives at `skills/tcb-home-operator/SKILL.md`.
Managed install must publish it only into the operator workspace by default.
`tcb ai-tools install` is the default one-shot refresh for the Home Operator
skill plus role-scoped MCP profile descriptors; it also removes stale global
skill copies. `tcb ai-tools status` is the corresponding health-oriented
inspection command.
Global publication requires `tcb skill install --scope global` and is an
explicit `tcb-home-operator` skill/prompt convenience for Claude/Codex operator
discovery only. It should remain a Home Operator/Observer recipe unless it is
explicitly split into narrower role-specific skills. Future project-local skills
should reference this governance document instead of copying global operator
authority.

## Operator Workspace Contract

The Home Operator workspace is the persistent directory for the owner-facing
operator agent. By default it lives at `<state-dir>/home`; operators may override
it with `HOME_OPERATOR_DIR`.

Required generated files:

- `CLAUDE.md`: Claude Code instructions for the Home Operator role.
- `AGENTS.md`: Codex/cross-agent instructions for the same role.
- `README.md`: human-readable explanation that the directory is an operator
  workspace, not a target project.
- `.claude/skills/tcb-home-operator/SKILL.md`: operator-home scoped Claude
  skill copy.
- `.codex/prompts/tcb-home-operator.md`: operator-home scoped Codex prompt copy.

Generated role descriptors:

- `skills/`: role-local copies or pointers for `tcb-home-operator` and
  `tcb-observer`.
- `mcp/`: generated MCP profile descriptor files such as `observer.json` and
  `home.json`.

The operator workspace may be used as a provenance signal. For example, a
mutating Home Operator control action can require one of these trusted signals:

- the caller is the managed Home Operator session whose recorded path equals the
  configured operator workspace;
- the local control request carries caller provenance whose `cwd` resolves to
  the configured operator workspace;
- the caller uses an explicitly configured local Home MCP profile;
- the owner invokes a confirmed CLI/chat action with an explicit target.

This is a useful safety check, not sufficient authorization by itself. Directory
origin is easy to spoof from a shell, and project-local agents can sometimes
load global instructions. The control service must still validate target
identity, role, conflict state, and capability class before mutation.

Current implementation note: the control client attaches best-effort caller
provenance (`cwd`, `pid`, and source) to control-socket requests, and the shared
operation wrapper classifies whether the caller cwd matches the Home Operator
workspace. Existing general-purpose CLI, TUI, and chat actions are not blocked
solely by this signal; high-risk future Home/MCP operations should combine it
with explicit target identity and the normal control-service gates.

## Permission Model

Use deny-by-default role profiles for MCP tools:

- `observer`: read-only tools only.
- `home`: observer tools plus low-risk operator controls and owner-confirmed
  delegation.
- `supervisor`: WorkOrder-bound supervisor tools plus scoped worker controls.
- `worker`: WorkOrder-bound worker tools only.
- `guardian`: Runtime Guardian finding-bound self-repair tools plus observer
  tools.
- `audit`: Daily Task Audit candidate-bound self-repair tools plus observer
  tools.

Mutating profiles should be enabled explicitly by installation/configuration and
should be visible in `doctor` or future MCP status diagnostics. If the MCP
server cannot determine its profile, it must expose only observer tools.

## Directory And Session Placement

Do not collapse installation directory, execution directory, and tmux session
identity into one concept. A skill may be globally installed for discovery while
execution still happens in a project-bound or WorkOrder-bound tmux session.

| Surface Or Role | Skill/MCP Install Scope | Default Execution Directory | Tmux Session | Isolation Decision |
| --- | --- | --- | --- | --- |
| Observer tools | Operator-workspace profile by default; optional global or project-local read-only profile. | None, state dir, or explicit report/log path. | No dedicated tmux session required. | Good candidate for explicit global discovery, but managed install keeps it role-scoped until the user opts in. Never require a project cwd for status/log/report discovery. |
| Home Operator | `<state-dir>/home` operator workspace by default; optional explicit global copy. | `<state-dir>/home` for the managed operator session; tmux-claude-bot service context or explicit target path for control calls. | Reserved Home Operator session when enabled; some CLI/MCP calls may run without a dedicated tmux session. | Managed install is operator-workspace scoped. Explicit global install is convenience only; mutating actions must name the target project/session and pass service checks. |
| Project Agent | Project-local instructions or ordinary project chat. | Target project root. | Ordinary project session. | Project-scoped. It should not load global admin authority by default. |
| Loop Supervisor | Governed prompt/role policy, not ordinary global skill authority. | WorkOrder artifact directory plus configured project/workspace paths. | Reserved `loop-supervisor[-N]`. | Must be a dedicated reserved session. It coordinates WorkOrders and must not share ordinary project chat context. |
| Loop Worker | WorkOrder-bound role policy. | Isolated worktree or configured source worktree from WorkOrder. | Reserved `loop-worker-*`. | Must be dedicated per WorkOrder or bounded run slice. This is the main place where code mutation happens. |
| Runtime Guardian Repair | Guardian role policy plus optional global operator trigger. | tmux-claude-bot repo path; isolated or source according to Guardian mode. | Supervisor-backed repair WorkOrder, with worker when needed. | Separate from target-project sessions. It may use source mode only after clean-worktree readiness. |
| Daily Audit Repair | Audit role policy plus optional global operator trigger. | tmux-claude-bot repo path; isolated by default unless explicitly configured. | Supervisor-backed repair WorkOrder, with worker when needed. | Separate from scheduled task target sessions. It repairs bot scheduling/reporting behavior. |
| MCP server process | User-level config or project-local dev config. | tmux-claude-bot service/control context. | No tmux session by default. | Should be a thin tool server over control/CLI. It should not become a hidden worker session or run arbitrary project shell commands. |

Rules:

- Global skill/MCP installs are explicit opt-in only. They are for
  discoverability and operator convenience, not implicit mutation authority.
- Project-local skills should be preferred for repository-specific workflows,
  but they must not manage unrelated projects or global automation state unless
  the user intentionally invokes a Home Operator profile.
- Code-changing execution belongs in Loop Worker sessions, not in the MCP server
  process and not in ordinary user chat.
- Supervisor orchestration belongs in reserved Supervisor sessions, not in the
  Home Operator process.
- Native subagent, parallel exploration, planner, and evaluator behaviors belong
  inside the active worker agent when that agent supports it. AI-facing tools and
  skills may describe how to use those capabilities, but should not turn them
  into independent tmux-claude-bot service roles.
- MCP tools that need a directory must take or derive it from trusted service
  state: project catalog, WorkOrder, finding, or explicit owner-selected target.
  Do not use the MCP server process cwd as target truth.
- The service state directory remains shared operational state. Skills and MCP
  tools may read it through service/control APIs, but should not write state
  files directly.

## Capability Classes

Every CLI command, MCP tool, and skill recipe that exposes automation behavior
should declare one capability class.

| Class | Examples | Requirements |
| --- | --- | --- |
| Read-only observation | status, projects, sessions, queue, reports, logs, task audit summary, runtime findings | No mutation, no prompt send, default to current run/window filters when possible. |
| Low-risk control | open project, peek, recover shell-only sessions, toggle local input enhancement | Authorization required; return structured result and reason. |
| Prompt delivery | send to project/session, worker send | Conflict checks, caller/session identity, target path evidence, automation-block behavior. |
| Delegation | Autopilot, opportunity discussion handoff, Daily Audit repair, Runtime Guardian repair | WorkOrder materialization, owner/role policy, queue visibility, audit artifact. |
| Code mutation | worker commands, commits, PR creation | WorkOrder-bound path policy, branch policy, final summary, system gate, tests. |
| High-risk repository operation | PR merge, branch deletion, source-worktree repair, security repair | Explicit policy, configured GitHub identity, clean-worktree gate, CI/mergeability evidence, no generic MCP shell bypass. |

## Role-To-Surface Matrix

| Role | Skill Surface | MCP Surface | CLI Surface | Notes |
| --- | --- | --- | --- | --- |
| Home Operator | `tcb-home-operator` or the current bundled operator skill section. | `tcb.home.*`, `tcb.observer.*` | `tcb dashboard`, `tcb sessions`, `tcb loop reports`, `tcb task audit`, `tcb autopilot` | Owns discovery and owner-facing orchestration, not target edits. |
| Loop Supervisor | `tcb-supervisor` task policy embedded in governed prompts/skills. | `tcb.supervisor.*`, limited `tcb.worker.*`, read-only observer tools | No direct human CLI dependency inside prompts except documented control operations. | Must be WorkOrder-bound and produce final summary evidence. |
| Loop Worker | `tcb-worker` scoped execution instructions. | `tcb.worker.*` scoped by `workOrderId` and repository path | Project-local commands only through WorkOrder policy | Cannot discover or mutate unrelated sessions/projects. |
| Runtime Guardian Repair | `tcb-runtime-guardian` repair recipe. | `tcb.guardian.*`, observer tools | Runtime Guardian config/check commands when added | Repairs bot runtime policy/artifacts only. |
| Daily Audit Repair | `tcb-daily-audit-repair` repair recipe. | `tcb.audit.*`, observer tools | `tcb task audit`, `tcb task report` | Repairs bot task audit/reporting logic only. |
| Project Agent | General project guidance, not automation admin skill. | Usually none; optionally read-only project diagnostics. | Chat/TUI workflows; external `tcb send` is an operator action targeting this session, not authority held by the project agent. | Ordinary user chat must respect active automation conflicts. |
| Observer | `tcb-observer` diagnostic recipe. | `tcb.observer.*` | read-only CLI commands with `--json` where available | Safe first MCP milestone. |

The concrete non-operator skill names above are target names for future
decomposition. Until they exist as separate installable skills, the bundled
operator skill should describe role selection and avoid loading
supervisor/worker authority into ordinary project chat. Adding a persistent
Supervisor skill/MCP package is not complete unless it is included in the
one-shot AI-tool installer/status command, surfaced by `doctor`, and covered by
contract tests.

## MCP Namespace Plan

Use role namespaces so tools are discoverable without being overpowered:

| Namespace | Tool Shape | First Tools To Consider |
| --- | --- | --- |
| `tcb.observer.*` | Read-only service and artifact discovery. | `status`, `projects`, `sessions`, `queue`, `logs_query`, `loop_reports_list`, `task_audit_summary`, `runtime_findings`. |
| `tcb.home.*` | Operator control and owner-approved delegation. | `open_project`, `autopilot_delegate`, `autopilot_queue`, `opportunity_list`, `opportunity_show`, `opportunity_discuss`. |
| `tcb.supervisor.*` | WorkOrder orchestration and finalization. | `workorder_read`, `worker_lease`, `worker_peek`, `final_summary_write`, `system_gate_status`. |
| `tcb.worker.*` | Bounded worker execution. | `scope_read`, `artifact_write`, `project_peek`, future command wrappers constrained by WorkOrder policy. |
| `tcb.guardian.*` | Runtime Guardian self-repair flow. | `findings`, `repair_delegate`, `repair_readiness`. |
| `tcb.audit.*` | Daily Task Audit self-repair flow. | `run`, `summary`, `repair_candidates`, `repair_delegate`. |

Prefer one MCP server with role-aware tool registration over multiple
independent servers at first. Split servers only when deployment or security
requires independent installation.

Namespace is not security. It improves discovery and model behavior, but every
mutating tool must still enforce role, scope, and conflict checks in code.

## Role Binding

Do not let a tool caller choose its own role through a free `role` parameter.
Role must be derived from trusted context:

- MCP server profile or installed tool namespace;
- authenticated local owner context for Home Operator tools;
- `workOrderId` plus persisted WorkOrder state for Supervisor and Worker tools;
- Runtime Guardian or Daily Task Audit finding state for repair tools;
- read-only server profile for Observer tools.

If trusted context is missing or inconsistent, return a blocked response instead
of downgrading into a generic shell/CLI wrapper. A structured response may echo
the resolved role for observability, but the server must treat it as derived
state, not caller input.

For project-directory installs, role binding should also check the repository
root when a tool claims project-local scope. A project-local skill may recommend
commands, but the MCP server/control service still owns the final path and
permission check.

## Required Tool Response Contract

AI-facing tool responses should be structured and evidence-bearing:

```json
{
  "ok": true,
  "role": "observer",
  "capability": "read-only observation",
  "scope": {
    "projectId": "example",
    "session": "tmux_proj_example",
    "workOrderId": "optional"
  },
  "data": {},
  "evidence": ["artifact path, command, timestamp, or gate result"],
  "blockedReason": null,
  "nextSuggestedAction": "optional concise next step"
}
```

For blocked or failed calls:

- Set `ok: false`.
- Include a stable `blockedReason` or `errorKind`.
- Distinguish permission/conflict/readiness/provider-transient/project-failure.
- Include evidence sufficient for logs, Daily Task Audit, or Runtime Guardian.
- Do not ask the model to infer safety from prose-only output.

## Scope And Permission Rules

- Mutating supervisor and worker tools must require `workOrderId` unless they are
  explicitly Home Operator owner-confirmed actions.
- Mutating Home Operator tools must require explicit target project/session
  identity and should not act on "current project" unless the control service
  resolves that identity unambiguously.
- WorkOrder-bound tools must validate the configured `projectPath` or workspace
  repository paths before mutation.
- Worker tools must not accept arbitrary filesystem paths outside the WorkOrder
  scope.
- Guardian and Daily Audit repair tools must target tmux-claude-bot self-repair,
  not target-project application code.
- Project Agent tools must respect automation conflict blocking; observer tools
  remain available during conflicts.
- High-risk repository tools must use configured GitHub identity and system-gate
  evidence; do not expose generic merge/delete shell wrappers.
- MCP tools must not introduce direct model-provider SDK/API calls. AI judgment
  remains active-agent-backed.
- Global installs must not silently enable mutating MCP tools for every project;
  mutating profiles need explicit local configuration and visible diagnostics.

## CLI Requirements For MCP Wrapping

When a CLI command is likely to be wrapped by MCP or used by an agent:

- Provide a stable `--json` output mode or expose the same data through the
  control client.
- Return machine-readable status and error kinds.
- Avoid mixing historical and current-run data by default; provide time/run
  filters for logs and reports.
- Keep human formatting separate from structured data.
- Add focused tests for JSON contracts before relying on MCP wrappers.

## Skill Requirements

Role skills should not duplicate full command manuals. Each skill should define:

- role purpose and authority;
- allowed and forbidden capability classes;
- first diagnostic tools to call;
- conflict and stop conditions;
- WorkOrder/path/branch evidence requirements;
- when to use MCP tools versus CLI fallback;
- when to ask the owner instead of continuing.

The Home Operator skill should teach discovery and delegation decisions. The
Supervisor and Worker skills should be narrow and WorkOrder-bound. Observer
skills should be read-only and safe to load broadly.

## Business Capability Coverage

AI tool-surface review applies to all bot modules, not only WorkOrder
automation. Use this table to decide whether a feature belongs in MCP, CLI,
skill guidance, or only human/chat surfaces.

| Business Area | Default Tool Role | Exposure Guidance |
| --- | --- | --- |
| Project/session intake and adoption | Home Operator | CLI/control first; MCP only with path validation and structured project/session identity. |
| Agent runtime status, transcripts, history, inputs, and peek | Observer, Home Operator | Good MCP candidates when read-only and filterable by session/run/window. |
| Prompt delivery to ordinary sessions | Home Operator, Project Agent target | Mutating; must honor automation conflict blocks and caller/session provenance. |
| Voice transcription and prompt translation | Home Operator for setup, Project Agent target for delivery | Expose readiness/status and setup diagnostics before exposing toggles; preserve original-input provenance. |
| Prompt library browsing/search/send/discuss | Observer for browse, Home Operator for send/discuss | Keep external prompt-library content separate from governed automation prompts. |
| Attachments and notification attachments | Home Operator | Require path validation, size/type evidence, and target session/notification scope. |
| Batch scheduler | Home Operator, Observer | Read-only plan/status/report tools first; mutating pause/resume/stop tools need explicit operator authority. |
| Loop Engineering, Autopilot, Opportunity Discovery, PR review | Home Operator, Supervisor, Worker, Observer | WorkOrder-bound for execution; owner-confirmed for delegation; read-only for reports and suggestions. |
| Daily Task Audit and Runtime Guardian | Audit/Guardian repair roles plus Observer | Repair tools target tmux-claude-bot self-repair only; findings and summaries are safe observer candidates. |
| GitHub operations and PR merge | Supervisor under WorkOrder policy | Do not expose generic GitHub mutation tools; require configured identity and system-gate evidence. |
| Deployment, setup, doctor, lifecycle | Home Operator, Observer | Read-only doctor/status is safe; install/restart/pause/resume are operator actions and need explicit local authority. |
| Localization, copy, UI vocabulary, prompt governance | Observer for audit, Supervisor for code-changing WorkOrders | Prefer contract tests and reports; mutation must go through code-changing WorkOrders. |

## Extension Checklist

When adding or changing an automation feature, answer these questions in the
same slice:

1. Which business role owns this capability?
2. Which capability class is it?
3. Should it appear in CLI, MCP, skill, chat, TUI, or only internal code?
4. Is it read-only, mutating, code-changing, or high-risk?
5. Does it require `workOrderId`, project/session identity, owner confirmation,
   or GitHub identity?
6. What structured response, evidence, and error kinds will AI tools return?
7. Which docs and tests prove the surfaces cannot drift?
8. What must remain unavailable to this role?

If a feature cannot answer these questions, keep it out of MCP and skills until
the boundary is clear.
