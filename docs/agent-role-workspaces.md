# Agent Role Workspaces

This document defines where each tmux-claude-bot agent role runs, which
instruction files it should see, and which skill/MCP surface is appropriate for
that role. It exists to prevent tool-surface drift when adding supervisor,
worker, project, MCP, or skill behavior.

## Core Rule

Agent capabilities are scoped by role first, then by directory.

Persistent infrastructure agents get dedicated workspaces under the state
directory. Target-project agents run inside the target project or execution
worktree so they keep the target project's own instructions, local MCP config,
skills, and tool assumptions.

Do not start a target-project worker from an empty bot-owned home directory. That
would hide project-local `AGENTS.md`, `CLAUDE.md`, `.claude`, `.codex`, MCP
descriptors, repository scripts, and other project-owned context.

## Workspace Model

```text
Persistent infrastructure agent
  fixed state workspace
  fixed role instructions
  role-specific skill/MCP profile

WorkOrder target agent
  target project path or isolated execution worktree
  target project instructions remain visible
  WorkOrder declares the role contract and allowed actions

Ordinary project agent
  target project path
  project-local instructions remain authoritative
  global safe tcb tools may be available

Timer/service component
  no independent agent workspace
  produces evidence, ledger records, notifications, or WorkOrders
```

## Role Matrix

| Role | Session | Working Directory | Skill/MCP Scope | Rule |
| --- | --- | --- | --- | --- |
| Home Operator | `<prefix>home` | `<state-dir>/home` unless configured | Home/operator skill and home/observer MCP profiles | Persistent owner-facing control role. It may inspect and route work, but must not send delegated work to itself. |
| Loop Supervisor | `<prefix>loop-supervisor[-N]` | `<state-dir>/loop-supervisor` or `<state-dir>/loop-supervisor-N` unless configured | Supervisor role skill and supervised-control MCP subset | Persistent orchestration role. It reads WorkOrders, drives target sessions, monitors evidence, and emits final summaries. |
| Loop Worker | `<prefix>loop-worker-*` | WorkOrder execution path: target project path or isolated worktree under `<state-dir>/loop-worktrees` | Worker/project scoped tools declared by the WorkOrder | Not a persistent home role. It must run where project-local instructions and repository tooling are visible. |
| Project Agent | Project-derived session name | Target project path | Global safe tcb tools plus optional project-local integration | Human-facing project chat role. Project-local `AGENTS.md` / `CLAUDE.md` remains authoritative. |
| Runtime Guardian | none by default | none by default | Guardian prompt policy; repair delegates through Loop Supervisor | Timer/service role. It detects runtime evidence and creates supervised repair WorkOrders when thresholds are met. |
| Daily Task Audit | none by default | none by default | Audit prompt policy; repair delegates through Loop Supervisor | Timer/service role. It reconciles scheduled task records and creates supervised repair WorkOrders only for dispatchable failures. |
| Long Task Monitor | none by default | none by default | Notification and evidence only | Timer/service role. It reports long-running work; it should not own code-changing agent behavior. |

## Skill And MCP Defaults

Default global tools should be safe, portable capabilities that any target
project may use without granting repository mutation:

```text
Allowed globally by default:
  notify
  task report
  attach
  status
  log/query
  queue inspect
  help/discovery

Not allowed globally by default:
  send prompt
  delegate/autopilot
  cancel/kill
  merge PR
  mutate repository configuration
  modify another project's tool installation
```

The managed default installs only the Home Operator role surface into the
operator workspace. Other role-specific packages are future or WorkOrder-bound
surfaces until they have an implemented install contract, runtime binding, and
doctor check.

When a role gets a persistent workspace, its role-specific tool profiles must be
installed or generated into that role workspace by the same default AI-tool
installer that provisions the workspace. Project-local installation is still
supported when a repository needs versioned local instructions or a restricted
project-specific MCP descriptor.

Loop Supervisor currently gets its authority from governed WorkOrder prompts and
reserved session naming, not from a separately installed default skill/MCP
package. If a future supervisor workspace package is added, it must be added to
`tcb ai-tools install`, `tcb ai-tools status`, `tcb doctor`, and tests in the
same slice so newly configured supervisor sessions cannot silently miss their
role surface.

## Loop Worker Directory Requirement

Loop worker behavior must preserve target-project context:

- Source mode starts in the configured target project path.
- Isolated mode starts in the prepared execution worktree for that WorkOrder.
- The execution worktree is the worker's project directory for that run.
- The WorkOrder prompt supplies the temporary role contract, allowed actions,
  blocked actions, verification commands, and final summary schema.
- If required project-local agent files are not present in an isolated worktree,
  the run must surface that as a setup or isolation issue instead of silently
  switching to a generic bot-owned home.

This means the worker's stable identity is the WorkOrder, not a stable home
directory. A fixed worker home is only appropriate for logs, leases, reports, or
cached bot metadata, not as the agent cwd.

## Implementation Checklist

When changing any agent-starting logic, MCP profile, or skill install path:

1. Identify the role from the role matrix.
2. Confirm whether the role is persistent infrastructure, WorkOrder target work,
   ordinary project chat, or timer/service.
3. Verify the tmux session cwd matches the role's working-directory rule.
4. Keep target-project agents inside the target project path or execution
   worktree.
5. Update the relevant skill/MCP profile and docs in the same slice.
6. Add a contract test when a wrong cwd or wrong scope could hide project-local
   instructions or expose high-risk controls.
