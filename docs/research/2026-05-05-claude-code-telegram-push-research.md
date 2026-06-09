# Claude Code 主动推送 Telegram 调研

Date: 2026-05-05
Status: 放弃

## 背景

希望Claude Code完成任务后，主动推送结果到Telegram，而不是当前bot主动拉取模式。

## 技术调研结果

### Claude Code Hooks

**可用Hooks（来自官方文档）：**

| 类型 | Hook名 |
|------|--------|
| Session | Setup, SessionStart, SessionEnd |
| Turn | UserPromptSubmit, UserPromptExpansion, PostToolBatch, Stop, StopFailure, TeammateIdle, TaskCreated, **TaskCompleted** |
| Tool | PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest, PermissionDenied |
| Async | InstructionsLoaded, ConfigChange, CwdChanged, FileChanged, WorktreeCreate, WorktreeRemove, PreCompact, PostCompact, SubagentStart, SubagentStop, Notification, Elicitation, ElicitationResult |

### TaskCompleted Hook

- **时机**: 任务完成前触发（可阻塞完成）
- **无PostTaskComplete**: 没有任务完成后的hook
- **返回值**:
  - `continue: false` + `stopReason` → 阻止完成
  - exit 0 → 放行，Claude打印`[task completed]`

### Hook通信方式

| Handler类型 | 通信方式 |
|-------------|----------|
| `command` | shell脚本，JSON stdin/stdout |
| `http` | POST JSON到外部URL |
| `mcp_tool` | **直接调用MCP工具** |
| `prompt` | 发送prompt给LLM |
| `agent` | 启动子agent |

### 方案对比

**方案A: Hook读tmux发通知**
- TaskCompleted hook直接cat tmux pane内容
- 问题：原始输出噪声多，格式化差，效果差

**方案B: 通知+bot拉取**
- hook只发"任务X完成"，bot主动拉取
- 问题：消息效果差，用户体验不佳

**方案C: MCP工具+指令注入（推荐但未推进）**
- 项目提供`notify_telegram` MCP工具
- 通过instructions告知Claude任务结束时调用它发送摘要
- Claude自行生成格式化消息，效果好
- 问题：instructions机制对MCP工具注入的支持程度未知

## 放弃原因

1. Hook只能拿到原始输出，格式化效果差
2. MCP工具+指令方案需要更多调研（instructions机制对MCP工具的支持）
3. 用户判断"效果不好"，核心问题无法解决

## 待验证项（如后续重新调研）

1. Claude Code的instructions机制是否支持注入MCP工具使用说明
2. settings.json中的instructions和项目级instructions的区别
3. TaskCompleted hook中调用mcp_tool是否可行

## 技术可行性总结

```
当前可行路径:
Claude Code完成 → TaskCompleted hook → mcp_tool handler → notify_telegram工具

问题卡点:
hook只能拿到原始tmux输出 → 消息质量差
若要让Claude生成好内容 → 需MCP工具注入 + instructions告知Claude何时调用
instruction注入MCP工具说明 → 机制未确认
```

## 相关文件

- `src/services/output.ts` — 当前OutputProcessor处理tmux输出
