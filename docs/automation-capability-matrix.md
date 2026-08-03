# Automation Capability Matrix

This matrix tracks which user/control surfaces expose each intelligent
automation capability. It is a maintenance aid for avoiding Telegram/Feishu/TUI
or CLI drift.

Authoritative behavior lives in source and tests. When this matrix disagrees
with source, fix the source/docs alignment in the same slice.

## Surfaces

| Surface | Role |
| --- | --- |
| CLI | Local operator/admin surface through `tcb ...`. |
| Telegram | Owner chat surface with commands and inline keyboards. |
| Feishu/Lark | Owner chat plus project-bound group surface with commands and cards. |
| TUI | Local terminal client over the control socket. |
| Home/operator skill | AI-facing recipe for operating `tcb` from Claude Code/Codex. |
| MCP | Structured AI tool surface; read-only Observer profile via `tcb mcp observer` and controlled Home profile via `tcb mcp home`. |

## Capability Matrix

| Capability | CLI | Telegram | Feishu/Lark | TUI | Home/operator skill | MCP | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Ordinary project prompt | `tcb send <project> ...` | Send text/voice in current project chat | Send text/voice in private chat or bound project group | Compose prompt | Describes `tcb send` | `tcb.home.send_prompt` | Must block when active automation owns the project unless using diagnostic/escape controls. |
| Voice transcription | Optional install/status via setup, doctor, and install scripts; no separate send command | Voice message handling, `/voice_install`, `/voice_lang` | Audio resource handling, `/voice_lang`, `voiceinstall` card action | Not directly surfaced | Describes voice setup and prompt delivery | Not exposed | Input enhancement only: transcribed text enters the same queue as owner text and keeps voice provenance. |
| Prompt translation | Control socket and setup/doctor support; no separate send command | `/prompt_translate`, `/translate_install`, prompt-translation keyboard | `/prompt_translate`, `/translate_install`, prompt-translation cards | Not directly surfaced | Describes prompt translation setup | Not exposed | Applies before enqueue for text or transcribed voice; failure blocks delivery instead of silently changing intent. |
| Session status | `tcb sessions`, `tcb dashboard`, `tcb peek`, `tcb logs` | `/dashboard`, `/peek`, `/history`, `/logs` | Same command intent through Lark handlers/cards | Session list, live pane, logs | Describes status commands | `tcb.observer.status`, `projects`, `sessions`, `queue`, `logs_query` | Read-only diagnostics should remain available during automation conflicts. |
| Autopilot active delegation | `tcb autopilot <project> [requirement]` | `/autopilot`, inline **Delegate now**, **Review plan first** then **Confirm delegation**, and queue view on blocked delegation | `/autopilot`, cards **Delegate now**, **Review plan first**, queue view, and cancellable active-delegate queue rows | `A` panel delegates via supervisor | Describes `tcb autopilot` | `tcb.home.delegate_autopilot` | Current Autopilot is supervisor-backed delegation only. No keep-alive, goal-cycle, enable/disable, or old human gate UI. Queue cancellation is limited to active-delegated tasks, not scheduled system WorkOrders. |
| Opportunity Discovery suggestions | Inspect via stored reports/commands; no direct top-level CLI command beyond related loop reports | `/opportunity list/show/discuss/dismiss`, per-suggestion keyboard when callback payloads fit Telegram limits; typed-command fallback for oversized callback ids | `/opportunity list/show/discuss/dismiss`, readable per-suggestion cards with view/discuss/dismiss actions plus batch actions | Not directly surfaced | Describes `/opportunity` flow | Not exposed | Discovery is read-only. Discussion and execution are decoupled; approved work enters Autopilot delegation. |
| Loop Engineering admin | `tcb loop validate/tick/run/reports/backlog/skills` | Primarily via notifications and commands described in docs | Primarily via notifications and commands/cards described in docs | Not a full admin surface | Describes loop admin commands | `tcb.observer.loop_reports_list` only | Agent-supervised manual `loop run` is intentionally blocked; managed scheduler/supervisor owns it. |
| Automation Governance Review | Configured under Loop Engineering `automationGovernanceReview` | Result notifications | Result notifications | Not directly surfaced | Points to loop docs | Not exposed | Reviews tmux-claude-bot automation governance; repair PRs are P0/P1-only and must not auto-merge. |
| Daily Task Audit | `tcb task audit --force`, `tcb task report ...` | Final summary notification; task command docs | Final summary notification; project-bound routing when applicable | Not directly surfaced | Describes audit/report commands | `tcb.observer.daily_task_audit` | Audit actively discovers bot-hosted schedules and can dispatch repair when enabled; MCP observes persisted ledger state only. |
| Runtime Guardian | Config/env and logs; no user-facing command required | Notification/audit evidence when it dispatches or blocks | Notification/audit evidence when it dispatches or blocks | Not directly surfaced | Points to maintained docs | `tcb.observer.runtime_guardian_findings` | Repairs tmux-claude-bot runtime only, not target projects; MCP discovers findings without dispatching repair. |
| Project/workspace PR review | Configured under Loop Engineering `pullRequestReview` | Result notifications | Result notifications | Not directly surfaced | Points to loop docs | Not exposed | Reviews loop-created PRs for configured project/workspace. |
| Repository-wide PR review | Configured under `prReview.repositories` | Result notifications | Result notifications | Not directly surfaced | Points to loop docs | Not exposed | Processes all open PRs for configured repositories; may repair only narrow same-repo issues. |
| Notifications from local projects | `tcb notify`, `tcb attach`, `tcb task report` | Delivery target for configured owner/project messages | Delivery target; project-bound group preferred when session known | Not directly surfaced | Describes notify/attach/report | Not exposed | Project-scoped notices must carry project/session identity. |

## Intentional Differences

- Feishu/Lark supports project-bound groups. Telegram is owner-directed unless a
  feature explicitly configures a project chat target.
- Feishu/Lark uses cards for richer actions. Telegram may use inline keyboards or
  concise text commands. The requirement is capability parity, not identical UI.
- The TUI is a local control client, not a full scheduler administration UI.
- The home/operator skill should stay short and route to `docs/agents/usage-guide.md`
  for detailed recipes.

## Alignment Checklist

When changing a capability above:

1. Update the source handler/control path.
2. Update or intentionally decline Telegram, Feishu/Lark, TUI, CLI, and skill
   support.
3. Record the intentional difference in this file.
4. Update `docs/manual.md`, `docs/commands.md`, `docs/tui.md`,
   `docs/ai-tool-surface-governance.md`, or
   `docs/agents/usage-guide.md` as applicable.
5. Add or update tests for any mechanical behavior that can drift.
