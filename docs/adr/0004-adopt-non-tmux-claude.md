# ADR-0004: Adopt a Claude running outside tmux

**Date:** 2026-06-14
**Status:** Accepted

## Context

The bot can only control Claude sessions that run inside tmux (it drives them via
`tmux send-keys` / `capture-pane`). But users sometimes start `claude` directly in
a terminal — not through the `claude-tmux` helper — and then leave the computer,
wanting to continue from their phone. Those processes are out of the bot's reach.

We want a `/adopt` flow: list the non-tmux claude processes and "take one over" so
the bot can drive it.

## Decision

Discover, then graceful-kill, then resume in tmux. Core logic lives in
`src/core/takeover.ts` (+ `takeover-service.ts`, `flavor-alias.ts`); both adapters
are thin glue over the same service.

Key decisions and the reasoning:

1. **Kill + `--resume`, not migrate the live process.** macOS forbids injecting
   input into a foreign terminal (TIOCSTI returns EPERM — verified) and `reptyr`
   (reparent a live process into a new pty) is Linux-only. So we cannot move the
   running process into tmux. Instead we end it and resume its session in a fresh
   tmux pane. Claude persists each completed turn to its `.jsonl`, so resume loses
   only an in-flight turn, not history.

2. **Graceful termination: SIGINT → settle → SIGTERM → SIGKILL.** SIGINT cancels an
   in-flight generation and is harmless when idle (Claude just arms its exit
   prompt), giving history a moment to flush before we terminate. We cannot
   reliably detect "is a turn running" for a non-tmux process (no terminal view;
   network/CPU are noisy), so SIGINT-first is used unconditionally rather than
   gated on a flaky busy check.

3. **Flavor preserved by inferring the launch alias, not by copying env.** Flavors
   (`claude-yolo` / `claude-stella` / `claude-ollama` …) are shell aliases that set
   env (CLAUDE_CONFIG_DIR, ANTHROPIC_BASE_URL, API keys). At runtime argv0 is just
   `claude`; the flavor lives in env. We parse the rc files for `claude-*` aliases,
   match the orphan's `{config dir, base url}` signature to one, and relaunch by
   typing that **alias name** — so the alias brings its own env (including secrets)
   straight from the rc file and **the bot never reads or prints a secret**. No
   unique match → fall back to a reconstructed `CLAUDE_CONFIG_DIR=… <bin> --resume`.

4. **Resume target = the orphan's session.** Prefer the `.jsonl` the PID has open
   (exact), falling back to the newest by mtime for that project dir. Claude often
   closes the file between turns, so the mtime fallback is the common path; it is
   correct because the orphan is normally the most-recent writer.

5. **Busy pre-flight before killing.** If the target tmux session already exists
   with a non-shell foreground (another claude, an editor…), abort *without*
   touching the orphan and tell the user to exit it first — typing into an occupied
   pane would clobber it, and we'd have nowhere to land the takeover. A failed tmux
   query (pane list unavailable) makes discovery return nothing, so a transient
   failure can't misclassify an in-tmux session as adoptable.

6. **Handing the session back to the computer = clipboard, opt-in.** We cannot
   auto-attach the *original* terminal (same input-injection limit as #1). Instead,
   an optional "view in computer terminal" button copies `tmux attach -t <session>`
   to the host clipboard; the user pastes it back at the computer.

## Consequences

- Works on macOS (lsof/ps/pbcopy, tmux). Not portable to Linux as-is.
- A flavor that changes the model/endpoint resumes correctly **only** when its
  alias is inferable from the rc files; otherwise history is preserved but the
  endpoint falls back to default.
- Adopting is a global host op, so it is private-chat-only on Lark (a bound project
  group is pinned to one project).
