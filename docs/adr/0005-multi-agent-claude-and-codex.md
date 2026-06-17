# ADR-0005: Multi-agent support (Claude + Codex) behind a neutral seam

**Date:** 2026-06-17
**Status:** Accepted
**Extends:** ADR-0004 (orphan adoption — now generalized to any agent kind)

## Context

The bot drove exactly one coding agent: Claude Code. Its identity was baked in —
`claude.ts`, `claude-config-resolver.ts`, `history.ts` reading `~/.claude`, and
"Claude" as the domain primitive. We wanted OpenAI Codex as a **first-class peer**
the user can run per project (and switch to/from on the desktop), at full parity:
start/exit/restart, `/history`, `/status` usage, flavors, and orphan adoption.

Codex differs from Claude in every concrete detail — process name, config home
(`CODEX_HOME` vs `CLAUDE_CONFIG_DIR`), transcript format (rollout JSONL under
`sessions/**` vs `projects/<dir>/<uuid>.jsonl`), resume syntax (`codex resume
<id>` vs `claude --resume <id>`), auth source (files vs process env), and the TUI
strings used to detect readiness — but the *lifecycle and command semantics are
identical*.

## Decision

Introduce an agent seam under `src/core/agents/` and make the bot agent-agnostic.
Key decisions and reasoning:

1. **A shared abstraction, not a Claude rewrite or a parallel codex stack.**
   - `AgentRunner` (interface) + `AgentRunnerBase` (the whole start/exit/restart/
     wait-ready/wait-done lifecycle, written once) with a handful of per-agent
     hooks: process detection, ready marker, resume/continue syntax. Subclasses
     (`ClaudeRunner`, `CodexRunner`) are just those hooks — no duplicated wiring.
   - `AgentProfile` (read-side strategy) + a registry for the differences that
     aren't lifecycle (config-dir env, transcript source, flavor parsing, resume-
     command building, status report).
   - `AgentRunnerDispatcher` routes every call to the right backend.
   - Neutral shared layers — `transcript.ts` (rounds + reply-matching + time
     format), `usage.ts` (snapshot + rendering), `shared/types.ts` (kind, glyph,
     api-info) — so a feature is implemented once and both agents inherit it.
   Alternative rejected: copy the claude modules and `if (codex)`-branch the call
   sites. That privileges claude and drifts the two paths over time.

2. **Agent kind is resolved from the LIVE process, not a stored record.**
   `detectAgentKind(running process) ?? persisted launch-intent ?? "claude"`. The
   user can quit codex and start claude in the same desktop tmux pane; the running
   process is ground truth, so `/history`, `/status`, and dispatch must follow it.
   A stored kind would be cheaper but would *lie* after a manual switch. The
   persisted intent is kept only as the fallback for a stopped session (and is
   recorded on start/restart/resume/adopt).

3. **Symmetric where the lifecycle is; asymmetric where the agents truly differ.**
   The seven lifecycle/command files mirror file-for-file (`*-runner/history/
   status/profile/process/flavor-alias/takeover`). The read-side does *not*
   mirror: codex needs `codex-jsonl/rollout/usage` because it *pulls* usage and
   transcript from the rollout JSONL, whereas claude has usage *pushed* to it via
   a statusLine snapshot file (`claude-status.ts` only reads/parses it). "claude"
   is still not the privileged default — the asymmetry follows each agent's real
   surface, not a stored preference. The generic engines (`parseAgentAliases`,
   `listOrphansFor`, the `takeover()` orchestration, the resolver cache) stay in
   `core/`. The old `claude.ts`/`claude-config-resolver.ts`/`history.ts` were
   removed, not wrapped.

4. **Exact live session from the pid's open transcript.** Under same-cwd
   contention (Free Projects), newest-mtime can pick the wrong session, so
   `/history` and restart-resume prefer the `.jsonl`/rollout the live pid actually
   has open, falling back to newest-cwd-matched on disk.

5. **Readiness is a hybrid, not pure UI-string scraping.** A positive ready marker
   (claude `❯`/bypass banner, codex `›`) is the fast path; a confirm-gate detector
   (trust/bypass screens) auto-accepts with Enter; and a *prose-agnostic stability
   fallback* (pane byte-identical for N polls + process alive + substantive
   content) catches a future UI re-skin without hanging. Pure string-matching was
   rejected as too brittle after a launcher/locale change.

## Consequences

- A third agent is a new folder (runner hooks, profile, status, flavor, takeover)
  + a registry entry + **whatever read-side parsers its transcript/usage format
  needs** (as codex needed `jsonl/rollout/usage`). The lifecycle, dispatch, and the
  neutral transcript/usage **shapes + rendering** are reused unchanged; the
  *sourcing* of transcript and usage is per-agent by design (decision #3).
- Orphan adoption (ADR-0004) is now profile-driven, so it adopts codex too.
- Known soft spots: Claude doesn't hold its `.jsonl` open at idle, so restart
  usually falls back to `--continue` (the exact-id path is largely inert for
  claude; codex has a disk fallback, claude does not). The same inertness also
  degrades `/history` isolation, not just restart: for an idle claude free-slot
  sharing a cwd with other claude sessions, transcript selection falls back to
  newest-mtime across the shared history dir, so `/history` can surface rounds
  from a sibling session rather than that slot's own. Codex is less exposed here —
  its pid generally keeps the rollout open even at idle, so `resolveLiveTranscript`
  stays exact; only when no rollout is held open does it fall back to the same
  cwd+mtime guess. A *stopped* session the bot
  never launched/adopted has no live process and no recorded intent, so it
  defaults to `claude` — wrong if it was actually a codex session, but rare.
  A related case — a **manual desktop switch is never recorded at switch time**
  (no hook fires when the user quits codex and starts claude in the pane
  themselves) — is handled by self-healing: `resolveAgentKind` writes the
  live-detected kind through to the persisted map whenever it disagrees with the
  stored value, so any bot interaction (`/history`, `/status`, dispatch, a list
  render) while the switched agent runs corrects the stale intent *before* the
  session stops. Residual: a session that is manually switched and then stops with
  **zero** bot interaction in between never gets observed live, so its fallback
  kind — and a later `/restart`'s resume command — would still name the pre-switch
  agent. Narrow, and it heals itself the moment the bot touches the session again.
- Readiness detection still depends on agent UI strings for the *fast* path and
  for auto-accepting gates; only the fallback is prose-agnostic.
