# Bounded remote security alerts

Borrow the denial-counter pattern from telegram-bridge without importing its stricter authorization lifecycle. Five denials in a rolling ten-minute installation-wide window trigger one warning; reserve a ten-minute cooldown synchronously before any network work. Attempts during cooldown are discarded. Counters remain bounded and in memory.

Count rejected identities, remote ingress authorization denials, invalid/expired authenticator approvals, and private-only approval/card-signature violations. Do not count normal successful traffic, manual locking, syntax errors or ordinary command errors. Do not inspect prompts or infer malicious intent. Existing 24-hour grants and admission-only authorization remain unchanged.

Register private senders for each configured allowlisted Telegram and Feishu recipient when adapters start. Deliver warnings across registered channels, with no project/group routing, identities, message text, secrets, request identifiers or provider errors in the payload. Localize warning and fixed denial categories. Include /lock and local tcb security revoke guidance. Notification work is detached from ingress; sender failures are contained and logged generically, without authorization changes. No new configuration or permissions are required.

Verify threshold/window/cooldown, concurrency, sender failures, private destinations, adapter and ingress wiring, and the existing security policy. Same-account warnings are not an independent account-takeover detector; an already authorized attacker may generate no denials.
