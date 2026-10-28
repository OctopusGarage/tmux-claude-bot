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
2. Read the instructions sent privately. The next private message contains only
   the copyable `/approve <request-id> <code>` command. Check the target chat,
   copy that message, replace `<code>` with a fresh authenticator code, and send
   it privately within five minutes.
3. Use the original chat normally for the configured lifetime (24 hours by
   default). Grants bind channel, user and original chat; another chat needs its
   own grant.
4. Send `/lock` when finished. It revokes your grants and pending requests in
   that channel. Queued and running work continues. `/security` reports
   enrollment/suspension without unlocking.

All other remote updates, including reads, buttons, voice, images, project
management and delegation, require authorization after enrollment. Approval
messages and bare codes receive best-effort deletion, which cannot remove copies
from notifications, platform infrastructure or other devices. Never post a code
to a group.

Configure the lifetime of future approvals locally:

```sh
tcb security grant-hours 24
tcb security status --json
```

Use a positive whole number of hours. The setting survives restarts, appears as
`grantTtlSeconds` in status, and does not shorten or extend existing approvals.
Existing security state without this setting defaults to 24 hours.

Requests expire after five minutes. Codes have 30-second periods, tolerate at most
one period of clock drift, and cannot be reused across restarts. Five incorrect
or replayed codes lock verification for five minutes across the installation.
A compromised allowed account can therefore temporarily deny verification.
Requests and grants are bounded in memory and never survive a backend restart.

## Queue And Automation Boundary

Authorization is checked once when a remote update enters the bot. Once admitted,
input and derived work follow their normal lifecycle without authorization
rechecks at enqueue, dispatch, delegation, or after readiness waits. Expiry,
manual locking, local suspension, enrollment and renewal do not cancel or reject
already admitted work. New updates still require a valid grant. This deliberate
policy prioritizes continuity and accepts that previously admitted malicious
input may still execute after locking; stop affected work explicitly when needed.

Proactive notifications retain their existing delivery routes; this feature
does not hide notifications until a chat is unlocked. Independent scheduled
maintenance and trusted local CLI/TUI retain their own authority. Accepted
autonomous WorkOrders retain their existing recovery policy. Authorization
controls admission, not process termination.

## Passive Security Alerts

Five access denials in a rolling ten-minute window trigger a private warning to
all configured allowlisted users on registered Telegram and Feishu channels.
The counter is installation-wide and covers rejected identities, locked/expired
or unavailable access, invalid card signatures, and failed/expired or non-private
approval attempts. Successful traffic, manual locking and command syntax errors
do not count. This is a denial warning, not a classification of malicious intent.

Warnings contain only the latest channel, a fixed denial category and recovery
guidance (`/lock` in the affected channel or local `tcb security revoke`). They never include sender IDs,
chat IDs, submitted text, commands, request IDs, verification codes or secrets.
They bypass project/group notification routing and do not require an unlocked
chat. Recipients must be reachable privately by the bot.

There is at most one warning burst per ten minutes; events during cooldown are
discarded. Counting and cooldown are bounded in memory and reset on restart.
Delivery is best effort and detached from ingress: failed or slow sends do not
block messages, change authorization or introduce additional lockouts. Failures
are logged generically without provider exception details. The existing durable
OTP failure lockout is unchanged.

An attacker using an already valid grant may cause no denials and no alert.
Warnings delivered to a compromised account are not an independent recovery
channel. Other configured channels may provide additional visibility, but alerts
do not guarantee takeover detection. Daily grants, manual locking and continued
execution of already admitted work retain their existing behavior.

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
