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
} as const;
