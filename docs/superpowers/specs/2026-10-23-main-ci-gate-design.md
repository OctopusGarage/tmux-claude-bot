# Main CI merge gate

Require pull requests into main with strict up-to-date GitHub Actions status checks: verify, scan, Analyze (javascript-typescript), and Analyze (actions). Existing protections apply to administrators, prohibit force pushes and deletion, and require PRs without adding human approval requirements. Preserve all unrelated protection settings.

The stable verify job must run with always(), depend on every other job in the CI workflow, and require each dependency result to equal success. Empty, skipped, neutral, failed or cancelled result sets fail. Contract tests execute the actual gate shell for both successful and rejected result sets and ensure future CI jobs cannot be omitted from needs.

Keep protections on the server; repository documentation records required checks and the contract tests prevent workflow drift. Scheduled mutation testing and release/publishing workflows retain their separate triggers. Commit this slice alongside already committed security work, run pnpm verify:local before push, and push local dev without merging main.
