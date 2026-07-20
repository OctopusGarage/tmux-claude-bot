# Bot Domain

tmux-claude-bot lets a person drive coding agents from chat apps while the work
continues inside project sessions. The core domain is the relationship between
workspaces, project sessions, chat scopes, agents, and optional Lark project
groups.

## Language

### Workspaces and Projects

**Workspace**:
A directory that can be used as the working directory for an agent.
_Avoid_: folder project, repo, cwd target

**Project**:
A managed workspace whose default project session is derived from the workspace
path. In the regular case, one workspace maps to one project session.
_Avoid_: recent project, live project, workspace entry

**Regular Project**:
A project whose session identity is derived from its workspace path.
_Avoid_: normal project, path project, non-independent project

**Independent Project**:
A path-independent project slot used when multiple agents need to run against
the same workspace. An independent project has its own session identity and may
later be assigned a workspace path.
_Avoid_: free project, parallel project, temporary project

**Project Session**:
The user-visible runtime session that hosts one project or independent project.
Only present this term when a session is live or selected; a stopped recent
workspace row is a Recent Project, not a Project Session.
_Avoid_: tmux session, tmux project, chat session, agent session

**Project Session Surface**:
The core read model for rendering project session rows and actions in chat
adapters, such as whether a row should switch, create, stay inert, or expose a
project-group action.
_Avoid_: adapter project button rules, picker rendering branch

**Operator Session**:
A reserved project-like session used as the fallback home surface when no chat
scope has selected a current session.
_Avoid_: home project, default project

**Recent Project**:
A previously opened workspace kept as a convenience index for pickers. It is not
a liveness state and is not a separate kind of project.
_Avoid_: recent session, stopped project list

**Live Project**:
A project or independent project that currently has a live project session. It
is a runtime state, not a separate entity.
_Avoid_: alive project entity, running project type

**Current Project**:
The project session selected for one chat scope. It is a routing pointer, not a
global bot-wide setting.
_Avoid_: active project, selected workspace

**Saved Workspace**:
A user-named alias for a known project session.
_Avoid_: bookmark, named project

### Agents and History

**Agent**:
The coding assistant process running inside a project session.
_Avoid_: bot, model, assistant process

**Agent Kind**:
The agent family currently associated with a project session, either Claude or
Codex.
_Avoid_: model type, provider

**Launch Flavor**:
A configured way to start an agent kind, usually the same agent binary with
different environment or flags.
_Avoid_: profile, mode, alias

**Transcript**:
The agent-owned conversation history file read by the bot to show history,
inputs, activity, and resume candidates.
_Avoid_: bot history, message log

**Agent Activity**:
Whether the agent appears busy for a project session, based on bot queue work or
fresh transcript writes.
_Avoid_: tmux activity, project activity

**Agent Activity Snapshot**:
The core read model that reports an agent's kind, running state, busy state,
current task identity, task duration, cumulative busy time, usage, pane activity,
and path drift for one project session.
_Avoid_: dashboard busy row, activity flags bundle

### Chat Routing

**Chat**:
A conversation surface in a chat app, such as a Telegram chat, Lark private
chat, or Lark group.
_Avoid_: channel, room

**Chat Scope**:
The per-chat routing key used to store a chat's current session.
_Avoid_: channel key, chat id

**Message**:
User input received from a chat. A message is either handled as a bot command or
forwarded to the current session.
_Avoid_: prompt, request

**User Prompt**:
Human-authored input intended to be delivered to an agent. It may originate as
chat text, transcribed voice, TUI input, or a local control request.
_Avoid_: raw text, user request, inbound text

**System Prompt Action**:
Bot-authored text delivered to an agent to maintain or recover an existing
workflow. It is not user input, even though it may use the same delivery channel.
_Avoid_: internal prompt, auto prompt, bot message

**Prompt Transform**:
A configured change applied to a user prompt before delivery to an agent. If a
prompt transform cannot complete, the original user prompt is not delivered.
_Avoid_: filter, hook, middleware

**Prompt Source**:
The entry surface where a user prompt entered the bot. The current prompt
sources are Telegram, Lark, and Control; Control covers local clients such as
the TUI, CLI, and operator-driven sends.
_Avoid_: input channel, client type, source channel

**Delivered Prompt**:
The final text actually delivered to an agent after any prompt transforms have
completed.
_Avoid_: translated text, final text, outgoing prompt

**Translation Provider**:
A local or remote capability that translates text between configured languages
for prompt transforms.
_Avoid_: translation model, translator script, backend

**Speech Transcription**:
Converting a voice message into text in the recognized spoken language. It does
not decide whether that text should be translated before delivery.
_Avoid_: voice translation, speech prompt, audio prompt

**Delivery Preview**:
User-facing feedback that shows the actual prompt delivered to an agent after
prompt transforms. It is required for voice input and optional for text input.
_Avoid_: debug echo, translated echo, send confirmation

**Reply Target**:
A remembered mapping from a bot reply back to the project session that produced
it, so replying to that message can target the same session.
_Avoid_: thread target, reply session

**Queue**:
The per-session backlog for messages that must be delivered to an agent in
order.
_Avoid_: task list, command queue

**Message Action Plan**:
The protocol-independent decision for a message action before an adapter renders
or executes it: confirm, show a launch-flavor picker, reject an already-running
start, run immediately, enqueue, or ignore as unsupported.
_Avoid_: adapter action branch, callback handler decision

### Lark Project Groups

**Project Group**:
A Lark group bound to one project session so the group itself acts as the work
surface for that project.
_Avoid_: Feishu group project, group project

**Group Binding**:
The durable association between a Lark group, a workspace path, a project
session, and a display label.
_Avoid_: group pointer, project group record

**Bound Group**:
A Lark group with an existing group binding.
_Avoid_: project chat, pinned group

**Parallel Project Group**:
A project group bound to an independent project so the same workspace can have
another group and agent.
_Avoid_: parallel group, free group, free project group

**Group Restore**:
Re-anchoring a bound group to its binding after its current-project pointer or
project session drifted.
_Avoid_: reconnect, recover group

### System Boundaries

**Adapter**:
The chat-app-specific edge that receives messages and renders replies.
_Avoid_: channel implementation, frontend

**Core**:
The protocol-independent domain layer that owns project/session routing,
agent lifecycle, queues, history, recovery, and shared views.
_Avoid_: service layer, backend

**Shared Primitive**:
A leaf utility, type, or configuration helper that has no dependency on core or
adapter code.
_Avoid_: common helper, misc util
