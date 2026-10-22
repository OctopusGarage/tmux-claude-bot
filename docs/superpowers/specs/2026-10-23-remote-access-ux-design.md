# Remote access with admission-only authorization

The operator explicitly prioritizes functionality and accepts the longer authorization window. Check remote authorization once at ingress. Once admitted, input and derived work continue through queues and readiness waits without further security checks, including after expiry, manual locking, local suspension, enrollment, or renewal. Locking blocks future admissions and does not cancel accepted work.

Default grants last 24 hours from approval. Persist a configurable whole-hour lifetime through `tcb security grant-hours <hours>`; status exposes seconds. Changes affect future grants. Existing state without a lifetime migrates to 24 hours. Preserve allowlists, private authenticator approval, chat scoping, replay protection, and local recovery. Preserve compatible enrollment; do not enroll automatically. Remove downstream authorization metadata and context machinery rather than leaving disabled checks.

Update chat copy in every language and the maintained alignment/security references. Validate real queue delivery after expiry and revocation, new admission rejection after locking, exact daily expiry, durable configuration, old-state migration, and CLI validation. Verify locally before committing and deploying to the managed local dev service.
