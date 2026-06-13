import type { Messages } from "./zh.js";

/** Japanese catalog. Typed `: Messages`, so it must implement every key in zh.ts. */
export const ja: Messages = {
  ackReceived: "受信しました",
  queuedAt: (pos) => `キュー投入 · ${pos} 番目`,
  queueFull: (max) => `キューが満杯です（上限 ${max}）· しばらくして再試行してください`,
  noCurrentProject:
    "現在のプロジェクトがありません · /list_alive_projects で選択するか /add_project で作成してください",
  errorPrefix: (msg) => `エラー：${msg}`,
  projectTag: (project) => `📂 ${project}`,

  voiceLangTitle: "🎙️ 音声認識の言語",
  voiceLangCardPrompt: (lang) => `現在(Feishu)：**${lang}** · タップで切替`,
  autoDetect: "自動検出",
  voiceHeard: (text) => `🎙️ 認識結果：「${text}」`,
  voiceTranscribeFailed: "文字起こしに失敗 · 再試行するかテキストを送信してください",
  voiceEmpty: "聞き取れませんでした · もう一度話すかテキストを送信してください",
  voiceUnsupported: "音声の文字起こしは Apple Silicon のみ対応",
  voiceNotInstalled: "音声未インストール（リポジトリで npm run whisper:install を実行）",

  currentProjectIs: (project) => `📂 現在のプロジェクト：${project}`,
  switched: "切り替えました",
  switchedTo: (project) => `切り替えました：${project}`,
  removed: "削除しました",
  nestingWarning:
    "⚠️ これは tmux-claude-bot 自身のリポジトリです。bot から操作すると入れ子になりがちです(「受信」のみで結果なし)。別の実プロジェクトに切り替えてください。",

  uiLangTitle: "🌐 表示言語",
  uiLangCurrent: (lang) => `表示言語：${lang} · タップで切替`,
  uiLangSet: (lang) => `表示言語を ${lang} に設定しました`,

  helpTitle: "ヘルプ",
  helpRunning: "**⚡ 実行中**",
  helpProjects: "**📂 プロジェクト / ビュー**",

  btnEnter: "⏎ Enter",
  btnEsc: "⎋ Esc",
  btnInterrupt: "✋ 中断",
  btnRestart: "🔄 再起動",
  btnClear: "🧹 clear",
  btnCompact: "🗜 compact",
  btnUp: "⬆️ up",
  btnDown: "⬇️ down",
  btnLeft: "⬅️ left",
  btnRight: "➡️ right",
  btnTab: "⇥ Tab",
  btnStatus: "📊 状態",
  btnStart: "🚀 起動",
  btnExit: "🚪 終了",
  btnPeek: "👁 peek",
  btnHistory: "📜 履歴",
  btnQueue: "📋 キュー",
  btnProjects: "📁 プロジェクト",
  btnRecent: "🕘 最近",
  btnCurrent: "📌 現在",
  btnSwitch: "🔀 切替",
  btnRemove: "🗑 削除",
  btnCreate: "➕ 作成",
  btnHelp: "💡 ヘルプ",
  btnVoiceLang: "🎙️ 音声言語",
  btnVoiceInstall: "🎙️ 音声を導入",
  btnUiLang: "🌐 言語",
  btnActiveMarker: "✅ 現在",
  btnMore: "⌨️ さらに ▾",
  btnCollapse: "▴ 折りたたむ",
  btnCancel: "✕ キャンセル",
  btnDeleteMode: "🗑 削除…",

  doneShort: "完了",
  claudeNotRunningRestart: "Claude が実行されていません · /restart で起動してください",
  contentTruncated: "...(内容が長すぎるため省略しました)",
  claudeEmptyOutput: "Claude の出力が空です · /peek で画面を確認",
  claudeStarted: "✅ Claude を起動しました",
  claudeStartedWith: (label) => `✅ 「${label}」で Claude を起動しました`,
  startPickerTitle: "🚀 起動方法を選択",
  startPickerPrompt: "複数の起動コマンドが設定されています。1つ選んでください:",
  btnStartThis: "🚀 これで起動",
  claudeExited: "✅ Claude を終了しました",
  claudeRestarted: "🔄 Claude を再起動しました · --continue",
  sentEsc: "✅ Esc を送信しました",
  interrupted: "✅ 中断しました · Ctrl-C",
  clearedContext: "✅ コンテキストをクリアしました · /clear",
  compactedContext: "✅ コンテキストを圧縮しました · /compact",
  sentEnter: "✅ Enter を送信しました",
  sentUp: "✅ ↑ を送信しました",
  sentDown: "✅ ↓ を送信しました",
  sentLeft: "✅ ← を送信しました",
  sentRight: "✅ → を送信しました",
  sentTab: "✅ Tab を送信しました",
  statusRunning: "🟢 Claude 実行中",
  statusNotRunning: "🔴 Claude 停止中",

  queueGlobalHeader: "━━ 🌐 グローバルキュー ━━",
  queueCounts: (queued, processing) => `待機中： ${queued} | 処理中： ${processing ? "🟢" : "🔴"}`,
  queueSessionHeader: "━━ セッションキュー ━━",
  queueNoSessions: "アクティブなセッションキューはありません",
  queueLastDone: (s) => `最終完了： ${s}秒前`,
  queueTitle: "キューの状態",

  paneTitle: "👁 tmux ペイン",
  emptyPane: "（空）",
  historyTitle: "📜 履歴",
  historyTitleShort: "履歴",
  noPathMapping: "プロジェクトのパス対応がありません · まず /add_project で作成してください",
  noHistory: "会話履歴が見つかりません",
  onlyNRounds: (n) => `会話は ${n} 件のみです`,
  emptyOutput: "(出力なし)",

  noCurrentProjectShort: "現在のプロジェクトなし",
  aliveListTitle: (n) => `アクティブなプロジェクト (${n})`,
  aliveListEmpty: "アクティブなプロジェクトがありません · /add_project <パス> で作成",
  recentListTitle: "最近のプロジェクト",
  recentListTitleN: (n) => `最近のプロジェクト (${n})`,
  recentListEmpty: "最近のプロジェクトがありません · /add_project <パス> で追加",

  addProjectUsage: "使い方：/add_project <パス>",
  addProjectUsageExample: "使い方：/add_project <パス>\n\n例：/add_project ~/projects/myapp",
  notADir: (p) => `${p} はディレクトリではありません`,
  dirNotExist: (p) => `ディレクトリが見つかりません：${p}`,
  pathNotAllowedPath: (p) => `許可されていないパスです：${p}`,
  alreadySwitched: "既に存在します · 切り替えました",
  projectCreated: "プロジェクトを作成しました",
  projectCreatedPath: (p) => `プロジェクトを作成しました：${p}`,
  shortIdNotFound: (id) => `短縮 id が見つかりません：${id}`,
  noCurrentProjectSet: "現在のプロジェクトが未設定です\n\n/add_project <パス> で設定してください",
  currentActive: "✅ アクティブ",
  currentNotFound: "🔴 見つかりません",
  currentProjectTitle: "現在のプロジェクト",
  noRecentProjects: "最近のプロジェクトがありません\n\n/add_project <パス> で追加してください",
  messageTooLong: (len, max) => `メッセージが長すぎます · ${len} > ${max} 文字`,
  onlyTextVoice: "テキストと音声メッセージのみ対応しています",
  unknownCommand: (name) => `不明なコマンド：/${name}（/help で一覧を表示）`,

  toastProcessing: "➕ 処理中…",
  sessionGone: "セッションが存在しないか既に終了しています",
  toastSwitched: "✅ 切り替えました",
  toastRemoving: "🗑 削除中…",
  toastSent: (action) => `/${action} を送信しました`,
  toastError: "問題が発生しました",

  processingQueued: (pos) => `処理中 · キュー ${pos} 番目`,
  processing: "処理中",
  duplicateIgnored: "重複メッセージを無視しました（同じ内容が既に処理中です）",
  failed: "失敗",
  taskStillRunning: (body) =>
    `⏳ タスクは実行中です · /peek で現在の結果を確認してください\n\n${body}`,
  taskStillRunningNotice:
    "⏳ まだ実行中です · 完了時に結果が自動送信されます · /peek で現在の画面を確認",
  voiceDownloadFailed: "音声のダウンロードに失敗 · 通信が不安定です。再試行してください",
  historyYou: "🧑‍💻 あなた",
  crashRecovered: (time) =>
    `♻️ tmux-claude-bot が異常終了（クラッシュ/強制終了）から自動復旧しました · ${time}`,

  noSession: "アクティブなセッションがありません · まず /list_alive_projects か /add_project",
  notRunning: "Claude が実行されていません · /start で起動、または /restart で継続",
  noShortId: (id) => `短縮 ID が見つかりません：${id}`,
  pathNotAllowed: (dirs) => `パスが許可リストにありません · 許可：${dirs.join("、")}`,
  voiceNotEnabled:
    "🎙️ 音声機能が無効です · /voice_install でワンタップ導入（Apple Silicon のみ）、またはホストで npm run whisper:install を実行",
  voiceNeedsAppleSilicon:
    "🎙️ 音声の文字起こしには Apple Silicon（macOS arm64）が必要です · このホストは非対応のためテキストを送信してください",
  voiceAlreadyInstalled: "🎙️ 音声機能は準備完了 · そのまま音声を送信してください",
  voiceInstalling:
    "🎙️ 音声機能を導入中 · 初回は依存関係をダウンロードします（約1-2分）。お待ちください…",
  voiceInstallOk: "🎙️ 音声機能の準備が完了 · 音声を送信できます",
  voiceInstallFailed: (e) =>
    `🎙️ 導入に失敗 · ${e} · 詳細はホストで npm run whisper:install を実行して確認`,
  voiceLangCurrent: (lang) =>
    `🎙️ 現在の認識言語：${lang === "auto" ? "自動検出" : lang} · 下のボタンで切替`,
  voiceLangSet: (lang) =>
    `🎙️ 認識言語を ${lang === "auto" ? "自動検出" : lang} に設定 · 次の音声から有効`,
  voiceLangInvalid: "🎙️ 使い方：/voice_lang <en|zh|yue|ja|es|auto または 2-3 文字の言語コード>",

  helpIntroTelegram: `🤖 tmux-claude-bot

任意のテキストを送信 → Claude に転送 → 返信
🎙️ 音声の文字起こしは任意機能 · /voice_install で有効化（Apple Silicon のみ）· /voice_lang で言語を設定

ヒント：メッセージには 👀（受信）/👍（完了）のリアクションが付きます。処理中はその場に進捗が表示され、結果に編集されます。結果の下に ⏎/✋/⎋/🔄 のショートカットボタンがあります。`,

  helpIntroLark: `🤖 tmux-claude (Lark)

任意のテキストを送信 → Claude に転送 → 返信`,

  helpSectionProjects: "📂 プロジェクト",
  helpSectionRunning: "⚡ 実行中",
  helpSectionIdle: "🚀 停止中",

  cmdCurrentProject: "現在のプロジェクト",
  cmdListAlive: "アクティブなプロジェクト（タップで切替/削除）",
  cmdListRecent: "最近のプロジェクト",
  cmdAddProject: "プロジェクトを作成",
  cmdQueueStatus: "キューの状態",
  cmdHistory: "会話履歴（既定は最新の1件）",
  cmdPeek: "tmux ペインを表示",
  cmdVoiceLang: "音声認識の言語（英/中/広東/日/西/自動）",
  cmdLang: "表示言語（英/簡/繁/広東/日/西）",
  cmdEnter: "Enter",
  cmdEsc: "Escape",
  cmdInterrupt: "Ctrl-C",
  cmdRestart: "再起動 (--continue)",
  cmdClear: "コンテキストをクリア",
  cmdCompact: "コンテキストを圧縮",
  cmdArrowsTab: "矢印キー / Tab",
  cmdExit: "終了",
  cmdStatus: "状態を確認",
  cmdStart: "Claude を起動",
  cmdDoctor: "インストールのヘルスチェックを実行",
  cmdHelp: "このヘルプ",
  cmdWs: "ワークスペース管理（save/use/list/remove）",

  // ── workspaces ──
  wsSaved: (name, session) => `✅ ワークスペース「${name}」を保存 → ${session}`,
  wsUsed: (name) => `✅ ワークスペース「${name}」に切り替えました`,
  wsRemoved: (name) => `✅ ワークスペース「${name}」を削除しました`,
  wsNotFound: (name) => `ワークスペース「${name}」が見つかりません`,
  wsSessionGone: (name) => `ワークスペース「${name}」のセッションは既に存在しません`,
  wsNoCurrentProject: "現在のプロジェクトがありません · まず /add_project で作成してください",
  wsListEmpty: "保存されたワークスペースはありません",
  wsListTitle: "📎 ワークスペース",
  wsListItem: (name, session) => `• **${name}** → ${session}`,
  wsInvalidName: "ワークスペース名は英数字・ハイフン・アンダースコアのみ（1-32文字）",
  wsUsage: "使い方：/ws <save <name> | use <name> | list | remove <name>>",

  // ── sessions ──
  noSessions: "保存されたセッション記録はありません",
  sessionsTitle: (n) => `${n} 件のセッション記録 · タップで再開`,
  sessionsLabel: (id, ago) => `${id} · ${ago}`,
  resumeStarted: (id) => `✅ セッション ${id} を再開しました`,
  cmdSessions: "過去のセッションを閲覧・再開",

  // ── group binding (Feishu) ──
  groupBoundWelcome: (label, path) =>
    `🎉 グループを **${label}** に紐付けました\n\`${path}\`\n\n@ なしでそのまま入力できます。`,
  groupCreateFailed: (msg) =>
    `❌ グループの作成に失敗：${msg}\n\nbot に \`im:chat\` 権限があるか確認してください。`,
  groupBindOnlyInGroup:
    "プライベートチャットでは `/newgroup` を使用してください。`/bind` はグループ内のみ有効です。",
  groupUnbindOnlyInGroup: "`/unbind` はグループ内のみ有効です。",
  groupNewGroupOnlyInP2p: "`/newgroup` は bot とのプライベートチャットのみ有効です。",
  groupRestored: (label) => `🔄 このグループを復元しました → **${label}**。`,
  groupMissingPath: (label) =>
    `⚠️ **${label}** のワークスペースがディスク上にありません。\`/rebind <パス|名前>\` で別の場所に紐付け直してください。`,
  groupUnbound: "🔓 このグループのワークスペース紐付けを解除しました。",
  groupNotBound:
    "このグループはワークスペースに紐付いていません。`/bind <パス|名前>` を使用してください。",
  groupTargetUsage: "使い方：`<コマンド> <絶対パス | ~/パス | ワークスペース名>`",
  btnGroupMenu: "🗂 プロジェクトグループ",
  btnMakeGroup: "🆕 新規グループ",
  btnBindHere: "🔗 紐付け",
  btnRebindGroup: "🔁 紐付け直す",
  btnUnbindGroup: "🔓 解除",
  btnRestoreGroup: "🔄 復元",
  groupPickerTitle: "🆕 新規プロジェクトグループ — プロジェクトを選択",
  groupBindPickerTitle: "🔗 このグループを紐付け — プロジェクトを選択",
  groupBoundCardTitle: (label) => `🗂 このグループの紐付け先：${label}`,
  groupMenuNoProjects:
    "最近のプロジェクトがまだありません。プライベートチャットで `/add_project <パス>` を追加してください。",
  groupCreatedShort: (label) =>
    `✓ プロジェクトグループ「${label}」を作成 — 新しいグループで続けてください。`,
  groupAlreadyExists: (label) =>
    `⚠️ プロジェクト「${label}」には既に紐付いたグループがあります。新規作成は不要、そちらを使ってください。`,
  groupPinnedNoSwitch: (label) =>
    `🔒 このグループは「${label}」に固定されています。プロジェクトの切替は無効です。変更は 🗂 → 紐付け直す から。`,
  groupNoRemoveInGroup:
    "🔒 グループ内ではプロジェクトを削除できません（他のメンバーに影響します）。bot とのプライベートチャットで行ってください。",
};
