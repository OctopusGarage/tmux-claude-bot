# MCP Profiles

tmux-claude-bot exposes role-scoped local MCP servers over stdio. MCP is an
AI-facing tool surface, not a bypass around the bot's control service.

## Profiles

| Profile | Command | Scope |
| --- | --- | --- |
| `observer` | `tcb mcp observer` | Read-only status, projects, sessions, queues, logs, Loop reports, Daily Task Audit state, and Runtime Guardian findings. |
| `home` | `tcb mcp home` | All Observer tools plus controlled prompt delivery and Autopilot delegation through existing control-service gates. |

The Home profile intentionally does not expose arbitrary shell execution, direct
file edits, PR merge operations, or WorkOrder internals.

`tcb.observer.status` is the canonical agent-facing Runtime Overview. It returns
the complete bounded Dashboard snapshot, stable evidence, `scope`, `errorKind`,
and `nextSuggestedAction`. The Home profile inherits this tool; there is no
duplicate `tcb.home.status`. Use `tcb.observer.loop_reports_list` for narrower
history with optional `projectId`, `status`, and `limit` (default 20, maximum
100).

## Install Profile Descriptors

Generate or refresh local profile descriptor files in the Home Operator
workspace:

```bash
tcb mcp install
```

This writes:

- `<state-dir>/home/mcp/observer.json`
- `<state-dir>/home/mcp/home.json`

Install one profile:

```bash
tcb mcp install --profile observer
tcb mcp install --profile home
```

Write descriptors to a specific operator home:

```bash
tcb mcp install --dir /path/to/operator-home
```

Write a specific stdio command into descriptors:

```bash
tcb mcp install --command /absolute/path/to/tmux-claude-bot
```

The descriptor files are stable JSON records with `profile`, `role`, `exposure`,
`server.command`, `server.args`, `tools`, and `boundaries`. They are intended for
Claude Code, Codex, or another local MCP client to reference explicitly. The
installer does not edit private global client configuration files.

The managed installer runs this descriptor refresh by default. It does not
edit global MCP client configuration. The paired Home Operator skill is
installed into the operator workspace by default; global Claude/Codex skill
publication requires `tcb skill install --scope global`.

## Diagnostics

Run:

```bash
tcb doctor
```

Doctor reports whether MCP profile descriptors are installed. Missing profiles
are informational because MCP is optional. A partial install is a failure because
it means the local tool surface can drift across clients.

## Boundaries

- Unknown or untrusted MCP clients should use only `observer`.
- `home` requires explicit target sessions and still goes through the control
  socket, queue, conflict checks, and Autopilot/WorkOrder gates.
- Supervisor, worker, Runtime Guardian repair, and Daily Audit repair profiles
  are not implemented as general-purpose MCP tools. If added later, they must be
  WorkOrder-bound or finding-bound.
