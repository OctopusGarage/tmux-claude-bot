# Remote Access Security, First Slice

## Approved outcome

Keep the checkout and managed development service on `dev`. Ship compatible
remote-access hardening, validate it, then adopt the verified revision locally.
Existing installations remain usable until the operator completes local
authenticator enrollment. Enrollment enables mandatory verification immediately.

## Authorization boundary

Telegram and Feishu/Lark retain their existing identity allowlists and routing.
Both share one protocol-independent authorization service. Grants bind channel,
user and chat, last five minutes, and never survive a process restart. This first
slice protects a chat control session, rather than introducing project-level
roles or changing existing project switching and group workflows.

`/unlock` requests access for its originating chat. Approval instructions are sent
privately to the requesting user. `/approve <request-id> <code>` is accepted only
privately and approves only that user's pending request in that channel. `/lock`
revokes the user's grants and outstanding requests. All other remote updates,
including reads, voice, images and callbacks, require a current grant after
enrollment. Expired or revoked queued input must fail before delivery. Remote
authorization follows asynchronous work and cannot disappear merely because
an internal caller marks the message as system-originated.

Already accepted, running work is not rolled back. Independent scheduled
maintenance, local CLI and the TUI retain their existing authority. Remote
authorization is not a filesystem sandbox or a defense against same-user host
compromise. A compromised account can use a grant during its active lifetime.

## Enrollment and recovery

Provide `tcb security status|setup|revoke|resume|reset`. Setup and reset require an
interactive local terminal. Enrollment material is never sent through chat or
included in status, logs, generic configuration, or source. Revoke persists
across restarts, and resume never restores prior grants. Reset leaves access
suspended until fresh enrollment. TOTP counters and guessing lockout persist,
with owner-only files, atomic replacement and cross-process locking.

## Integration and deployment

Keep authorization in `src/core/security`, thin ingress wrappers in each
adapter, and a dedicated CLI family. Queue entries capture an opaque grant
reference from request context; execution rechecks it after readiness waits.
Do not persist reusable grants or approval codes. Update alignment and usage
documentation together. Build and test in an isolated worktree so intermediate
edits do not reload the running service. Adopt on `dev` only after verification,
then confirm the managed service and local control surface remain healthy.

## Verification

Test legacy compatibility, missing identity/grant, channel/chat isolation,
expiration, OTP replay and guessing, local revocation, restart invalidation,
private approval, callbacks and media ingress, queue expiry and system-origin
provenance. Run the complete local verification gate before integration. Verify
deployed revision and service health without exposing live identities or secrets.
