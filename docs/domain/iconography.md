# Iconography

User-facing icons are domain vocabulary. Keep canonical icons and meanings in
`UI_ICON_REGISTRY` (`src/shared/ui/icons.ts`); `UI_ICONS` and
`UI_ICON_MEANINGS` are derived from that single source. Adapters and core
formatters should reference semantic keys instead of hardcoding emoji.

## Tone

| Key | Icon | Meaning |
| --- | --- | --- |
| `tone.ok` | ✅ | Success or acknowledged action. |
| `tone.result` | 💬 | Agent result or reply. |
| `tone.error` | ❌ | Error or failed operation. |
| `tone.warning` | ⚠️ | Warning or degraded state. |
| `tone.queue` | 📥 | Queue / inbox view. |
| `tone.queued` | ⏳ | Queued or waiting work. |
| `tone.list` | 🗒️ | Plain list view. |
| `tone.view` | 👁 | Read-only view or session pane. |
| `tone.recover` | ♻️ | Recovery flow. |

## Agent

| Key | Icon | Meaning |
| --- | --- | --- |
| `agent.generic` | 🤖 | Agent in general. |
| `agent.claude` | 🟠 | Claude agent. |
| `agent.codex` | 🔘 | Codex agent. |
| `agent.none` | 💤 | No live agent detected. |

## Session

| Key | Icon | Meaning |
| --- | --- | --- |
| `session.active` | 🟢 | Session is running. |
| `session.idle` | 🟡 | Session is running but idle. |
| `session.stopped` | ⚫ | Session is stopped. |
| `session.current` | 📌 | Current session. |
| `session.independent` | 🧩 | Independent session for parallel work. |
| `session.regular` | 🏠 | Regular path-backed session. |
| `session.busy` | ⏳ | Agent or session has active work. |
| `session.driftedPath` | ⚠️ | Session pane path differs from the bound workspace. |
| `session.pane` | 👁 | Session pane / peek view. |

## Project And Group

| Key | Icon | Meaning |
| --- | --- | --- |
| `project.project` | 📂 | Project label. |
| `project.workspace` | 📍 | Workspace path. |
| `project.repository` | 📦 | Git repository. |
| `project.recent` | 🕘 | Recent projects. |
| `project.create` | ➕ | Create/add. |
| `project.switch` | 🔀 | Switch session. |
| `project.remove` | 🗑 | Delete/remove. |
| `group.projectGroup` | 🗂 | Project group. |
| `group.none` | ➖ | No group binding. |
| `group.create` | 🆕 | Create group. |
| `group.bind` | 🔗 | Bind group. |
| `group.unbind` | 🔓 | Unbind group. |

## Actions And Features

| Key | Icon | Meaning |
| --- | --- | --- |
| `action.start` | 🚀 | Start. |
| `action.restart` | 🔄 | Restart or restore. |
| `action.exit` | 🔌 | Disconnect / exit agent. |
| `action.interrupt` | 🛑 | Interrupt / Ctrl-C. |
| `action.clear` | 🧹 | Clear context. |
| `action.compact` | 📦 | Compact context. |
| `action.cancel` | ✕ | Cancel. |
| `action.help` | 💡 | Help. |
| `action.status` | 📊 | Status / dashboard. |
| `action.enter` | ⏎ | Send Enter key. |
| `action.esc` | ⎋ | Send Escape key. |
| `action.tab` | ⇥ | Send Tab key. |
| `action.up` | ⬆️ | Send Up key. |
| `action.down` | ⬇️ | Send Down key. |
| `action.left` | ⬅️ | Send Left key. |
| `action.right` | ➡️ | Send Right key. |
| `feature.voice` | 🎙️ | Voice recognition. |
| `feature.language` | 🌐 | Language setting. |
| `feature.history` | 📜 | Conversation history. |
| `feature.inputs` | 🔁 | Recent inputs / re-run. |
| `feature.dashboard` | 📊 | Dashboard. |
| `feature.adopt` | 🧲 | Take over unmanaged agent. |
| `feature.autopilot` | ✈️ | Supervisor-backed Autopilot delegation. |
| `feature.tag` | 🏷 | Prompt tag. |

## Rules

- Add a semantic key in `UI_ICON_REGISTRY` before introducing a new reusable icon.
- Tests should import `UI_ICONS` or formatter outputs, not duplicate raw emoji.
- Do not maintain a second meaning table by hand; derive it from the registry.
- Shared action buttons should be rendered through
  `src/core/command/action-registry.ts` (`actionButtonRows`) so adapters do not
  read button keys or style metadata directly.
- Adapter-specific one-off icons are allowed only when the interaction is truly
  local and not part of shared project/session/group vocabulary.
