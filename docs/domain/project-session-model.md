# Project, Session, and Group Model

This document explains how project-facing features relate to each other. It is
implementation-facing guidance for maintainers and agents; the canonical user
terms live in `CONTEXT.md`.

## Mental Model

The system has one primary work unit: a project session.

A regular project session is derived from a workspace path. An independent
project session is allocated from a numbered slot and can share a workspace path
with other sessions. Chat surfaces do not own work by themselves; they point at a
project session.

```
Chat scope -> Current session pointer -> Project session -> Agent
                         |
                         +-> Workspace path
                         +-> Optional group binding
                         +-> Optional transcript
```

For Lark groups:

```
Lark group -> Group binding -> Project session -> Workspace path
```

A project group is just a Lark group with a group binding. A parallel project
group is a project group whose binding points at an independent project session.

Implementation note: the current code and persisted state still use the legacy
`free` slot/session naming. User-facing copy should say "independent session" or
"parallel project group"; do not expose "free project" as a product term.

## Display Vocabulary

User-facing surfaces should describe the domain, not the implementation:

| Domain layer | User-facing name | Meaning | Implementation detail |
| --- | --- | --- | --- |
| Directory | Workspace | The filesystem location where work happens. | A path on disk. |
| Managed work unit | Project | A workspace known to the bot. | A path-derived identity plus records. |
| Parallel work unit | Independent project | A path-independent slot for another session on the same workspace. | A legacy `free_<n>` slot. |
| Runtime container | Session | The running/stopped container that hosts an agent for a project. | Backed by tmux today. |
| Worker | Agent | Claude or Codex running inside a session. | A process in the session. |
| Conversation record | Transcript | Agent-owned history that the bot can read. | Claude/Codex JSONL files. |
| Lark collaboration surface | Project group | A Lark group pinned to one session. | A group binding record. |

Presentation rule:

- Say "Session" in status lines and project lists.
- Say "Project" for the managed workspace.
- Say "Workspace" for the directory/path.
- Say "Agent" only for Claude/Codex state.
- Say "tmux" only in implementation, diagnostics, or explicit attach-command
  instructions. Even terminal snapshots should be labeled as the session pane.

## Source Of Truth

| Question | Source of truth | Notes |
| --- | --- | --- |
| Does the session exist? | Live project sessions | Records are fallback only. |
| Which workspace does a session use? | Session path map | Independent projects may share a workspace path. |
| Which session does this chat target? | Current session pointer for the chat scope | Per chat, not global. |
| Was a workspace recently opened? | Recent project list | Convenience index, not liveness. |
| Is this an independent project? | Legacy free slot encoded in the session name plus free registry | Independent project identity is the slot. |
| Does this project already have a group? | Group bindings by session | One project session has at most one project group. Additional groups on the same workspace need distinct independent projects. |
| Which agent kind is running? | Live process detection | Persisted launch intent is only the stopped-session fallback. |
| Is the agent busy? | Queue state plus transcript activity | Covers bot-driven and desktop-driven work. |
| Which conversation history exists? | Agent transcript files | The bot reads history, it does not own it. |

`src/core/agents/agent-activity.ts` is the shared read model for live agent
state. Project/session displays should consume that module rather than probing
processes, transcripts, queue state, or pane cwd directly.

`src/core/projects/project-session-catalog.ts` is the shared read model for
project/session picker facts. Display adapters and picker adapters should use it
instead of joining live sessions, recent paths, free slots, group bindings, and
agent state locally.

## Project Lists

All project list surfaces must use the same project summary fields:

- session liveness
- agent kind
- agent running or idle state
- agent busy state
- regular project vs independent project
- group binding presence and label
- workspace path when known

`project-summary-view` is the shared formatter for list decoration and status
lines. Do not create a separate status vocabulary in an adapter.

Shared user-facing icons are defined in `src/shared/ui/icons.ts` and documented
in `docs/domain/iconography.md`. Project/session/group displays should use those
semantic keys instead of hardcoding emoji in adapters.

### Current

`current_project` answers one question: "which project session will this chat
send work to now?"

It should show the selected project label, workspace path when known, project
type, and agent kind. It is not a project picker.

### Projects

The projects list is the live project-session roster, excluding the operator session. It is
for switching to, inspecting, grouping, or removing sessions that exist now.

It may include both regular projects and independent projects. A live
independent project can offer "new project group" only when it has a workspace
path and no group binding; that action binds a new group to the existing
independent session.

### Recent

The recent list is the workspace picker. It is built from:

1. recent workspace paths, in LRU order
2. live project sessions that have a recorded workspace path but are absent
   from the recent list

This union keeps desktop-created sessions visible and actionable. A row can be
live or stopped; opening a stopped row recreates its regular project session.

Recent is not allowed to imply that every row is currently running.

### Project Session Catalog

`src/core/projects/project-session-catalog.ts` owns the protocol-neutral catalog
of project sessions. It returns domain facts plus action availability decisions;
it does not render final adapter copy and it does not call Lark, Telegram, or
tmux mutation APIs.

Catalog rows expose:

- row kind: regular, independent, or operator
- entry kind: live project session, recent project, or current selection
- session identity and label
- current-session and live-session state
- workspace path and existence
- independent slot metadata
- agent kind/running/busy/drift facts
- project group binding facts
- action decisions as `{ available, reason }`

Catalog queries are intent-specific:

- `live-roster`: current first, then live regular sessions by label, then live
  independent sessions by slot; operator sessions are hidden
- `workspace-picker`: recent workspaces in LRU order, plus live regular
  path-backed sessions missing from recents; stopped rows are allowed and
  independent sessions are excluded
- `regular-group-candidates`: regular workspaces without a group binding
- `group-bind-candidates`: regular workspaces that the current Lark group may
  bind or rebind to
- `parallel-group-sources`: regular workspaces that can source a fresh
  independent project session
- `existing-independent-group-candidates`: live independent sessions with a
  workspace path and no group binding
- `current-selection`: one row for the chat's current session pointer, including
  stopped-session fallback facts when the live session is absent

Catalog source priority is: live sessions, session path map, independent/free
registry, group bindings, current pointer, recent list, and session telemetry.
The catalog may consume self-healing read interfaces, but the catalog itself
must stay read-only.

### Project Session Picker

`src/core/projects/project-session-picker.ts` owns the protocol-neutral row model
for project/session pickers. It adapts catalog query rows into legacy picker
rows while keeping adapter-facing action IDs mode-specific. Adapter code should
ask it for the right mode instead of re-implementing list eligibility:

- `project-sessions`: live sessions for switching/removal and existing
  independent-session group creation
- `recent-projects`: workspace picker rows; stopped rows are Recent Projects
- `project-group-create`: regular projects without a group
- `project-group-bind`: regular projects that a Lark group can bind to
- `parallel-project-group`: regular projects used as the workspace source for a
  fresh independent session and group
- `existing-independent-project-group`: live independent project sessions that a
  new Lark group can bind to

Group-related modes are currently consumed only by the Lark adapter. The core
picker may expose group eligibility, but Lark API calls and Lark-specific copy
must stay in the Lark adapter.

## Lark Project Groups

The Lark group model has two separate creation paths. Keep them distinct in code
and copy.

### New Project Group

Creates a Lark group for a regular project session.

Eligibility:

- private-chat action only
- regular project only
- no live group binding already owns that project session

A regular project that already has a group must not show a new-group button.

### Bind Or Rebind Group

Attaches the current Lark group to a regular project session.

Eligibility:

- group action only
- regular project only
- another live group must not already own that project session

The group may re-anchor to its own existing project.

### New Parallel Project Group

Creates a new independent project session and binds a newly-created Lark group to it.
Use this when the user wants another independent agent/group on the same
workspace.

Eligibility:

- private-chat action only
- regular project picker row as the workspace source
- can create even when the workspace already has a regular project group
- consumes one independent project slot

This action must create a fresh independent project session. It must not reuse the
regular project's session.

### Bind Existing Independent Project To Group

Creates a Lark group for an independent project session that already exists.

Eligibility:

- private-chat action only
- live independent project
- independent project has a workspace path
- independent project has no group binding

This action must reuse the existing independent project session. It must not
allocate a new independent slot.

### Bound Group Management

Inside a bound group, cross-project switching and removal are disabled. The group
is pinned to its binding and offers work-surface actions for that project plus
binding management:

- restore
- rebind
- unbind

Restore uses the group binding as the source of truth. It re-anchors the group's
current session pointer and recreates the project session if needed.

## Notification Targets

Notification routing is a project/session concern, not an adapter-local choice.
`src/core/notifications/target-resolver.ts` owns the channel-selection policy for
proactive notifications:

- no registered channels: do not notify
- session with a bound Lark project group and Lark enabled: prefer Lark
- otherwise use the most recent owner channel when known
- otherwise fan out to both registered channels
- when a primary channel fails, fall back to the other registered channel

The Lark adapter still owns the final Lark delivery detail: a Lark notification
with a bound session is sent to that group's chat; otherwise it is sent to the
owner. Adapter startup should register senders, not reimplement target policy.

## Queue Observers

`MessageQueue` owns scheduling, ordering, deduplication, persistence, and
readiness gating. Cross-cutting effects that happen around a session task belong
behind `QueueObserver`:

- task timing for dashboards and long-task monitoring
- recording the latest chat target for a session

Keep new queue-adjacent side effects out of `MessageQueue` unless they are part
of scheduling itself. Add them to the observer boundary or a new collaborator so
the queue remains testable as a protocol-neutral scheduler.

## Naming Rules

Use these names consistently:

- "Project" for the managed work unit.
- "Workspace" for the directory.
- "Project session" for the user-visible runtime session.
- "Current session" for a chat-scope routing pointer.
- "Recent project" for a workspace-picker entry.
- "Live project" only as a runtime state.
- "Project group" for a bound Lark group.
- "Parallel project group" for a project group backed by an independent project.
- "Independent project" for the slot/session that enables parallel work.

Avoid presenting "recent", "projects", "project group", and "parallel group" as
peer entities. They are surfaces or actions over the same project-session model.

## Maintenance Checklist

When adding or changing a project-facing surface:

- Use shared project summary fields instead of adapter-local status strings.
- Read picker facts from the project session catalog; do not locally join live
  sessions, recents, bindings, slots, and agent telemetry in an adapter.
- List from live project sessions plus recorded paths when the user can start work
  outside the bot.
- Treat records as fallback when live process or transcript data exists.
- Hide impossible actions in the UI and keep the handler guard anyway.
- Keep regular-project group creation separate from parallel-project-group
  creation.
- Reuse an existing independent project session only in the explicit existing-independent
  group action.
- Include enough status in every picker row for the user to see liveness, agent
  kind, free/regular type, and group ownership.
