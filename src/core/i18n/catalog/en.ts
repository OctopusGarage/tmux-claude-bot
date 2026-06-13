import type { Messages } from "./zh.js";

/** English catalog. Typed `: Messages`, so it must implement every key in zh.ts. */
export const en: Messages = {
  ackReceived: "Received",
  queuedAt: (pos) => `Queued · #${pos}`,
  queueFull: (max) => `Queue full (max ${max}) — try again shortly`,
  noCurrentProject:
    "No current project — pick one with /list_alive_projects or create one with /add_project",
  errorPrefix: (msg) => `Error: ${msg}`,
  projectTag: (project) => `📂 ${project}`,

  voiceLangTitle: "🎙️ Voice language",
  voiceLangCardPrompt: (lang) => `Current (Feishu): **${lang}** · tap to switch`,
  autoDetect: "auto-detect",
  voiceHeard: (text) => `🎙️ You said: “${text}”`,
  voiceTranscribeFailed: "Transcription failed · retry or send text",
  voiceEmpty: "Didn’t catch that · say it again or send text",
  voiceUnsupported: "Voice transcription needs Apple Silicon",
  voiceNotInstalled: "Voice not installed (run `npm run whisper:install` in the repo)",

  currentProjectIs: (project) => `📂 Current project: ${project}`,
  switched: "Switched",
  switchedTo: (project) => `Switched to: ${project}`,
  removed: "Removed",
  nestingWarning:
    '⚠️ This is tmux-claude-bot\'s own repo — driving it via the bot usually nests (only "received", no result). Switch to a real project.',

  uiLangTitle: "🌐 Interface language",
  uiLangCurrent: (lang) => `Interface language: ${lang} · tap to switch`,
  uiLangSet: (lang) => `Interface language set to ${lang}`,

  helpTitle: "Help",
  helpRunning: "**⚡ Running**",
  helpProjects: "**📂 Projects / Views**",

  btnEnter: "⏎ Enter",
  btnEsc: "⎋ Esc",
  btnInterrupt: "✋ Interrupt",
  btnRestart: "🔄 Restart",
  btnClear: "🧹 clear",
  btnCompact: "🗜 compact",
  btnUp: "⬆️ up",
  btnDown: "⬇️ down",
  btnTab: "⇥ Tab",
  btnStatus: "📊 Status",
  btnStart: "🚀 Start",
  btnExit: "🚪 Exit",
  btnPeek: "👁 peek",
  btnHistory: "📜 History",
  btnQueue: "📋 Queue",
  btnProjects: "📁 Projects",
  btnRecent: "🕘 Recent",
  btnCurrent: "📌 Current",
  btnSwitch: "🔀 Switch",
  btnRemove: "🗑 Delete",
  btnCreate: "➕ Create",
  btnHelp: "💡 Help",
  btnVoiceLang: "🎙️ Voice",
  btnUiLang: "🌐 Language",
  btnActiveMarker: "✅ Current",
  btnMore: "⌨️ More ▾",
  btnCollapse: "▴ Collapse",
  btnCancel: "✕ Cancel",
  btnDeleteMode: "🗑 Delete…",

  doneShort: "Done",
  claudeNotRunningRestart: "Claude isn't running — use /restart to start it",
  contentTruncated: "...(content too long, truncated)",
  claudeEmptyOutput: "Claude returned nothing · /peek to view the pane",
  claudeStarted: "✅ Claude started",
  claudeStartedWith: (label) => `✅ Claude started with "${label}"`,
  startPickerTitle: "🚀 Choose how to start",
  startPickerPrompt: "Multiple start commands are configured — pick one:",
  btnStartThis: "🚀 Start this one",
  claudeExited: "✅ Exited Claude",
  claudeRestarted: "🔄 Claude restarted · --continue",
  sentEsc: "✅ Sent Esc",
  interrupted: "✅ Interrupted · Ctrl-C",
  clearedContext: "✅ Context cleared · /clear",
  compactedContext: "✅ Context compacted · /compact",
  sentEnter: "✅ Sent Enter",
  sentUp: "✅ Sent ↑",
  sentDown: "✅ Sent ↓",
  sentTab: "✅ Sent Tab",
  statusRunning: "🟢 Claude running",
  statusNotRunning: "🔴 Claude not running",

  queueGlobalHeader: "━━ 🌐 Global queue ━━",
  queueCounts: (queued, processing) =>
    `Queued: ${queued} | Processing: ${processing ? "🟢" : "🔴"}`,
  queueSessionHeader: "━━ Session queues ━━",
  queueNoSessions: "No active session queues",
  queueLastDone: (s) => `last done ${s}s ago`,
  queueTitle: "Queue status",

  paneTitle: "👁 tmux pane",
  emptyPane: "(empty)",
  historyTitle: "📜 History",
  historyTitleShort: "History",
  noPathMapping: "No path mapping · create it with /add_project first",
  noHistory: "No conversation history found",
  onlyNRounds: (n) => `Only ${n} conversation(s)`,
  emptyOutput: "(no output)",

  noCurrentProjectShort: "No current project",
  aliveListTitle: (n) => `Active projects (${n})`,
  aliveListEmpty: "No active projects — create one with /add_project <path>",
  recentListTitle: "Recent projects",
  recentListTitleN: (n) => `Recent projects (${n})`,
  recentListEmpty: "No recent projects — add one with /add_project <path>",

  addProjectUsage: "Usage: /add_project <path>",
  addProjectUsageExample: "Usage: /add_project <path>\n\nExample: /add_project ~/projects/myapp",
  notADir: (p) => `${p} is not a directory`,
  dirNotExist: (p) => `Directory not found: ${p}`,
  pathNotAllowedPath: (p) => `Path not allowed: ${p}`,
  alreadySwitched: "Already exists · switched",
  projectCreated: "Project created",
  projectCreatedPath: (p) => `Project created: ${p}`,
  shortIdNotFound: (id) => `Short id not found: ${id}`,
  noCurrentProjectSet: "No current project set\n\nSet one with /add_project <path>",
  currentActive: "✅ active",
  currentNotFound: "🔴 not found",
  currentProjectTitle: "Current project",
  noRecentProjects: "No recent projects\n\nAdd one with /add_project <path>",
  messageTooLong: (len, max) => `Message too long · ${len} > ${max} chars`,
  onlyTextVoice: "Only text and voice messages are supported",
  unknownCommand: (name) => `Unknown command: /${name} (send /help for the list)`,

  toastProcessing: "➕ Working…",
  sessionGone: "Session not found or already ended",
  toastSwitched: "✅ Switched",
  toastRemoving: "🗑 Removing…",
  toastSent: (action) => `Sent /${action}`,
  toastError: "Something went wrong",

  processingQueued: (pos) => `Working · queue #${pos}`,
  processing: "Working",
  failed: "Failed",
  taskStillRunning: (body) => `⏳ Task still running · /peek to see the current result\n\n${body}`,
  taskStillRunningNotice:
    "⏳ Still running — the result will be pushed automatically when it finishes · /peek for a live look",
  voiceDownloadFailed: "Voice download failed · network hiccup, please retry",
  historyYou: "🧑‍💻 You",
  crashRecovered: (time) =>
    `♻️ tmux-claude-bot recovered from an unclean exit (crash / kill) · ${time}`,

  noSession: "No active session · /list_alive_projects or /add_project first",
  notRunning: "Claude isn't running · /start to launch, or /restart to continue",
  noShortId: (id) => `Short ID not found: ${id}`,
  pathNotAllowed: (dirs) => `Path not in the allow-list · allowed: ${dirs.join(", ")}`,
  voiceNotEnabled:
    "🎙️ Voice not enabled · send /voice_install (Apple Silicon only), or run `npm run whisper:install` on the host",
  voiceNeedsAppleSilicon:
    "🎙️ Voice transcription needs Apple Silicon (macOS arm64) · this host can't, send text instead",
  voiceAlreadyInstalled: "🎙️ Voice is ready · just send a voice message",
  voiceInstalling: "🎙️ Installing voice · first run downloads deps (~1-2 min), hold on…",
  voiceInstallOk: "🎙️ Voice is ready · you can send voice messages now",
  voiceInstallFailed: (e) =>
    `🎙️ Install failed · ${e} · run \`npm run whisper:install\` on the host for details`,
  voiceLangCurrent: (lang) =>
    `🎙️ Recognition language: ${lang === "auto" ? "auto-detect" : lang} · tap below to switch`,
  voiceLangSet: (lang) =>
    `🎙️ Recognition language set to ${lang === "auto" ? "auto-detect" : lang} · next voice message`,
  voiceLangInvalid: "🎙️ Usage: /voice_lang <en|zh|yue|auto or a 2-3 letter code>",

  helpIntroTelegram: `🤖 tmux-claude-bot

Send any text → forwarded to Claude → reply
🎙️ Voice transcription is optional · /voice_install to enable (Apple Silicon only) · /voice_lang to set the language

Tip: messages get 👀 (received) / 👍 (done) reactions; progress shows in place and is edited into the result; the result has ⏎/✋/⎋/🔄 shortcut buttons below it.`,

  helpIntroLark: `🤖 tmux-claude (Lark)

Send any text → forwarded to Claude → reply`,

  helpSectionProjects: "📂 Projects",
  helpSectionRunning: "⚡ Running",
  helpSectionIdle: "🚀 Not running",

  cmdCurrentProject: "current project",
  cmdListAlive: "active projects (tap to switch/delete)",
  cmdListRecent: "recent projects",
  cmdAddProject: "create a project",
  cmdQueueStatus: "queue status",
  cmdHistory: "conversation history (latest by default)",
  cmdPeek: "view the tmux pane",
  cmdVoiceLang: "voice recognition language (en/zh/yue/auto)",
  cmdLang: "interface language (en/zh/yue)",
  cmdEnter: "Enter",
  cmdEsc: "Escape",
  cmdInterrupt: "Ctrl-C",
  cmdRestart: "restart (--continue)",
  cmdClear: "clear context",
  cmdCompact: "compact context",
  cmdArrowsTab: "arrow keys / Tab",
  cmdExit: "exit",
  cmdStatus: "check status",
  cmdStart: "start Claude",
  cmdDoctor: "run install health checks",
  cmdHelp: "this help",
  cmdWs: "workspace management (save/use/list/remove)",

  // ── workspaces ──
  wsSaved: (name, session) => `✅ Saved workspace "${name}" → ${session}`,
  wsUsed: (name) => `✅ Switched to workspace "${name}"`,
  wsRemoved: (name) => `✅ Removed workspace "${name}"`,
  wsNotFound: (name) => `Workspace "${name}" not found`,
  wsSessionGone: (name) => `Workspace "${name}" session no longer exists`,
  wsNoCurrentProject: "No current project — use /add_project first",
  wsListEmpty: "No saved workspaces",
  wsListTitle: "📎 Workspaces",
  wsListItem: (name, session) => `• **${name}** → ${session}`,
  wsInvalidName: "Workspace name: letters, digits, hyphens and underscores only (1-32 chars)",
  wsUsage: "Usage: /ws <save <name> | use <name> | list | remove <name>>",

  // ── sessions ──
  noSessions: "No saved sessions found",
  sessionsTitle: (n) => `${n} saved sessions — tap to resume`,
  sessionsLabel: (id, ago) => `${id} · ${ago}`,
  resumeStarted: (id) => `✅ Resumed session ${id}`,
  cmdSessions: "Browse and resume past sessions",

  // ── group binding (Feishu) ──
  groupBoundWelcome: (label, path) =>
    `🎉 Group bound to **${label}**\n\`${path}\`\n\nJust type — no @ needed.`,
  groupCreateFailed: (msg) =>
    `❌ Failed to create group: ${msg}\n\nMake sure the bot has the \`im:chat\` scope.`,
  groupBindOnlyInGroup: "`/bind` only works inside a group. In a private chat use `/newgroup`.",
  groupUnbindOnlyInGroup: "`/unbind` only works inside a group.",
  groupNewGroupOnlyInP2p: "`/newgroup` only works in a private chat with the bot.",
  groupRestored: (label) => `🔄 Restored this group → **${label}**.`,
  groupMissingPath: (label) =>
    `⚠️ The workspace for **${label}** is gone from disk. Use \`/rebind <path|name>\` to point this group somewhere else.`,
  groupUnbound: "🔓 This group is no longer bound to a workspace.",
  groupNotBound: "This group isn't bound to a workspace. Use `/bind <path|name>`.",
  groupTargetUsage: "Usage: `<command> <absolute path | ~/path | workspace name>`",
  btnGroupMenu: "🗂 Project groups",
  btnMakeGroup: "🆕 New group",
  btnBindHere: "🔗 Bind",
  btnRebindGroup: "🔁 Rebind",
  btnUnbindGroup: "🔓 Unbind",
  btnRestoreGroup: "🔄 Restore",
  groupPickerTitle: "🆕 New project group — pick a project",
  groupBindPickerTitle: "🔗 Bind this group — pick a project",
  groupBoundCardTitle: (label) => `🗂 This group is bound to: ${label}`,
  groupMenuNoProjects:
    "No recent projects yet. Add one in a private chat with `/add_project <path>`.",
  groupCreatedShort: (label) => `✓ Created project group "${label}" — continue in the new group.`,
  groupAlreadyExists: (label) =>
    `⚠️ Project "${label}" already has a bound group — use that one; no need to create another.`,
  groupPinnedNoSwitch: (label) =>
    `🔒 This group is pinned to "${label}" — switching projects is disabled here. Use 🗂 → Rebind to change it.`,
  groupNoRemoveInGroup:
    "🔒 Removing projects isn't allowed in a group (it affects others). Do it in a private chat with the bot.",
};
