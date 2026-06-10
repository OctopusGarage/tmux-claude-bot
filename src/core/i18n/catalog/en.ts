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
  voiceEmpty: "Transcription empty · retry",
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
  claudeExited: "✅ Exited Claude",
  claudeRestarted: "🔄 Claude restarted · --continue",
  sentEsc: "✅ Sent Esc",
  interrupted: "✅ Interrupted · Ctrl-C",
  clearedContext: "✅ Context cleared · /clear",
  compactedContext: "✅ Context compacted · /compact",
  sentEnter: "✅ Sent Enter",
  sentUp: "✅ Sent ↑",
  sentDown: "✅ Sent ↓",
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
  voiceDownloadFailed: "Transcription failed · couldn't download the file",
  historyYou: "🧑‍💻 You",

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

  helpBodyTelegram: `🤖 tmux-claude-bot

Send any text → forwarded to Claude → reply
🎙️ Voice transcription is optional · /voice_install to enable (Apple Silicon only) · /voice_lang to set the language

Tip: messages get 👀 (received) / 👍 (done) reactions; progress shows in place and is edited into the result; the result has ⏎/✋/⎋/🔄 shortcut buttons below it.

━━ 📂 Projects ━━
/current_project — current project
/list_alive_projects — active projects (tap to switch/delete)
/list_recent_projects — recent projects
/add_project <path> — create a project
/queue_status — queue status
/history [N] — conversation history (latest by default)

━━ ⚡ Claude running ━━
/enter — Enter    /esc — Escape
/interrupt — Ctrl-C    /restart — restart (--continue)
/clear — clear context    /compact — compact context
/up · /down — arrow keys    /exit — exit

━━ 🚀 Not running ━━
/start — start Claude
/peek — view the tmux pane
/status — check status
/help — this help`,

  helpBodyLark: `🤖 tmux-claude (Lark)

Send any text → forwarded to Claude → reply

━━ 📂 Projects ━━
/current_project — current project
/list_alive_projects — active projects (tap to switch/delete)
/list_recent_projects — recent projects
/add_project <path> — create a project
/queue_status — queue status
/history [N] — conversation history (latest by default)
/peek — view the tmux pane
/voice_lang — voice recognition language (en/zh/yue/auto)
/lang — interface language (en/zh/yue)

━━ ⚡ Running ━━
/enter — Enter   /esc — Escape
/interrupt — Ctrl-C   /restart — restart
/clear — clear context   /compact — compact
/up · /down — arrow keys   /exit — exit
/status — status

━━ 🚀 Not running ━━
/start — start Claude
/help — this help`,
};
