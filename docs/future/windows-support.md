# Future: Windows Support

**Status:** Research memo
**Date:** 2026-07-04

tmux-claude-bot currently depends on tmux-backed project sessions. That keeps the
runtime simple on macOS and Linux, but it leaves native Windows unsupported.

This document records candidate directions for later Windows support. It is not
an accepted architecture decision.

## Current Constraint

The product model should continue to expose "sessions", not "tmux", to users.
tmux is an implementation detail behind the session bridge. Any Windows work
should preserve that domain boundary:

```
Project session -> Terminal multiplexer bridge -> platform backend
```

Before adding Windows support, deepen the existing bridge so project/session,
agent, queue, group, and transcript logic do not call tmux directly.

## Candidate: RMUX

RMUX is a Rust terminal multiplexer engine with a tmux-compatible command surface
and typed SDKs for Rust, Python, and TypeScript. Its main relevance here is not
"replace tmux because it is newer"; it is that RMUX is designed as a programmable
terminal automation engine and runs natively on Windows.

Relevant capabilities to evaluate:

- Native Windows runtime through ConPTY and named pipes.
- Linux and macOS support through Unix PTYs and Unix-domain sockets.
- tmux-compatible CLI commands such as `new-session`, `send-keys`,
  `capture-pane`, `split-window`, and `wait-for`.
- Typed automation APIs around sessions, windows, panes, snapshots, waits,
  output streams, visible-text assertions, and locators.
- Web Share for browser-visible terminal sessions, with execution kept local.
- Claude teammate mode that injects a private tmux shim into Claude's `PATH`.

Potential fit:

- Windows support could be implemented as an alternate terminal multiplexer
  backend after the bridge boundary is explicit.
- Pane readiness checks, prompt detection, output stability, and history/debug
  views may become less brittle if RMUX snapshots and waits are reliable enough
  to replace plain text scraping.
- TypeScript SDK support could let this project integrate RMUX without a Rust
  rewrite.

Risks and unknowns:

- The project is young relative to tmux; compatibility and operational behavior
  need real soak time.
- tmux-compatible command coverage does not guarantee identical edge-case
  behavior for this bot's lifecycle and pane-driving assumptions.
- Claude teammate mode and the private tmux shim need security and failure-mode
  review before use in a long-running bot.
- Web Share is interesting but orthogonal to first-pass Windows support.

## Evaluation Checklist

Before choosing RMUX or any Windows backend:

- Define a `TerminalMultiplexerBridge` contract in terms of domain operations:
  create session, list user sessions, send keys, capture pane, kill session,
  inspect cwd, split/window operations if needed.
- Add backend-neutral integration tests for agent startup, readiness detection,
  command dispatch, queue interruption, current project switching, and session
  cleanup.
- Run those tests against tmux first, then a prototype RMUX backend.
- Verify Claude and Codex startup flows, including trust/bypass prompts and
  resume commands.
- Verify transcript/history resolution when multiple independent sessions share
  one workspace.
- Decide whether Windows support requires service-manager parity with launchd
  and systemd.

## References

- RMUX repository: https://github.com/Helvesec/rmux
- RMUX docs: https://rmux.io/docs/get-started/
- RMUX CLI reference: https://rmux.io/docs/cli/
