/**
 * Shared user-facing strings, kept in one place so every command speaks with a
 * consistent voice: one concise line, `·` as the separator, no English filler.
 */
export const MSG = {
  noSession: "没有活跃会话 · 先 /list_alive_projects 或 /add_project",
  notRunning: "Claude 未运行 · /start 启动，或 /restart 继续",
  noShortId: (id: string) => `未找到短 ID：${id}`,
  pathNotAllowed: (dirs: string[]) => `路径不在允许列表 · 允许：${dirs.join("、")}`,
  queueFull: (max: number) => `队列已满 (${max}) · 请稍候再试`,
  voiceNotInstalled:
    "🎙️ 语音功能未启用 · 发送 /voice_install 一键安装（仅 Apple Silicon），或在主机运行 npm run whisper:install",
  voiceUnsupported: "🎙️ 语音转写需要 Apple Silicon（macOS arm64）· 当前主机不支持，请改发文字",
  voiceAlreadyInstalled: "🎙️ 语音功能已就绪 · 直接发语音即可",
  voiceInstalling: "🎙️ 正在安装语音功能 · 首次需下载依赖（约 1-2 分钟），稍候…",
  voiceInstallOk: "🎙️ 语音功能已就绪 · 现在可以直接发语音了",
  voiceInstallFailed: (e: string) =>
    `🎙️ 安装失败 · ${e} · 可在主机运行 npm run whisper:install 查看详情`,
} as const;
