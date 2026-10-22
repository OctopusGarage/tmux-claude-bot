# Remote Access Security

The bot controls locally running agents. An identity allowlist rejects strangers,
but cannot distinguish an operator from an attacker using that same compromised
messaging account. Agent permissions and OS isolation determine the damage that
an authorized prompt can do.

## Compatible Enrollment

Existing installations keep their behavior until local enrollment. This
compatibility state is **not** second-factor protection:

```sh
tcb security status --json
tcb security setup
```

Setup requires an interactive trusted terminal. Scan the displayed QR/URI with a
TOTP authenticator and enter its current six-digit code. The QR contains a secret:
do not capture or forward it, or run setup through a chat-controlled pane.
Successful enrollment immediately enables verification for Telegram and Feishu;
no restart is needed. Enrollment material is never sent through chat.

Policy and enrollment use owner-only files under the state directory. Status
reveals no secret, owner identity, request ID or grant. Generic configuration
commands cannot enroll an authenticator or disable protection.

## Chat Workflow

1. Send `/unlock` in the private or project-group chat you intend to use.
2. Read the instructions sent privately. Check the target chat, then send
   `/approve <request-id> <code>` privately using a fresh authenticator code.
3. Use the original chat normally for five minutes. Grants bind channel, user
   and original chat; another chat needs its own grant.
4. Send `/lock` when finished. It revokes your grants and pending requests in
   that channel. `/security` reports enrollment/suspension without unlocking.

All other remote updates, including reads, buttons, voice, images, project
management and delegation, require authorization after enrollment. Approval
messages and bare codes receive best-effort deletion, which cannot remove copies
from notifications, platform infrastructure or other devices. Never post a code
to a group.

Requests expire after one minute. Codes have 30-second periods, tolerate at most
one period of clock drift, and cannot be reused across restarts. Five incorrect
or replayed codes lock verification for five minutes across the installation.
A compromised allowed account can therefore temporarily deny verification.
Requests and grants are bounded in memory and never survive a backend restart.

## Queue And Automation Boundary

Queued work retains its original remote provenance, including before enrollment.
Delivery rechecks the same grant after readiness waits; expiry, locking, local
revocation or a replacement unlock cannot authorize the old item. An internal
system-origin label does not erase remote provenance. Remote-derived queued
input is not persisted for replay. Queue items isolate authorization context.

Proactive notifications retain their existing delivery routes; this feature
does not hide notifications until a chat is unlocked. Independent scheduled
maintenance and trusted local CLI/TUI retain their own authority. Already accepted or running work is not undone by locking or expiry:
an accepted autonomous WorkOrder can finish and follow its existing recovery
policy. Authorization controls admission, not process termination. Stop affected
work explicitly when an incident requires it.

## Local Suspension And Recovery

```sh
tcb security revoke
tcb security status --json
tcb security resume
```

Revoke durably suspends remote access and invalidates grants and requests. The
live backend checks this at its next authorization boundary. Resume permits
fresh verification; it never restores old grants. Neither command stops an agent,
undoes filesystem changes or interrupts input already delivered.

If the authenticator is lost or compromised, run `tcb security reset` interactively
in a trusted terminal, then `tcb security setup`. Reset leaves protection enabled
and suspended; it never falls back to compatibility access. The backend reloads
durable policy at each check, including new enrollment.

State is atomically replaced under a process lock. Invalid state, unsafe file
permissions, symlinks and lock failures deny access. After a stale lock, stop the
service and other security CLI processes, then run `tcb security repair-lock`
interactively. Repair refuses live lock owners and leaves access suspended.
Inspect status before resuming; do not edit security files by hand.

## Remaining Trust Boundaries

- A compromised account can use an active grant. TOTP is not resistant to
  real-time phishing/relay and does not sign an individual operation.
- A local CLI TTY check is not proof of human presence. An agent or program
  running as the same OS user can read state or invoke local commands.
  Owner-only files do not isolate programs running as that user.
- A chat grant permits that chat's existing controls, including project switching
  and key presses. It is not a project role, pane identity binding or per-command
  approval. Existing terminal-state guards still apply.
- Directory allowlists, worktrees, tmux sessions and command filters are not OS
  sandboxes.

For host protection, use a dedicated low-privilege account or VM containing only
required project files and credentials. Keep personal keys, browser profiles,
privileged sockets and broad host mounts outside it. Protect messaging accounts,
review login sessions and use an independent incident notification channel.
This release does not migrate OS accounts or change agent permission flags.
