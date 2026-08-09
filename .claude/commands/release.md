---
description: Cut a release — verify, bump version, push (CI publishes the GitHub release), redeploy this machine, and verify the deploy
argument-hint: "[patch|minor|major|X.Y.Z] [no-deploy]"
allowed-tools: Bash, Read, Edit, Write
---

You are running the **full tmux-claude-bot release flow**. Follow the phases in
order. Treat every verification as a gate: if a step fails, **STOP and report** —
do not bump, tag, push, or deploy on top of a failure.

Arguments: `$ARGUMENTS`
- First token = the bump: `patch` (default), `minor`, `major`, or an explicit `X.Y.Z`.
- If `no-deploy` appears anywhere, skip Phases 4–5 (the machine-local redeploy).

Constants: repo `OctopusGarage/tmux-claude-bot` · launchd label
`com.octopusgarage.tmux-claude-bot` · install dir `~/.tmux-claude-bot`.

## Phase 0 — Preflight (abort on any problem)

1. Confirm the branch is `main` and the working tree is clean. Feature/fix commits
   must already be committed — this flow only adds the version-bump commit. If
   there are uncommitted changes, STOP and tell the user to commit them first.
2. `git fetch --tags origin` (tags are created server-side; may be absent locally).
3. Run `npm run verify:local`; require it to finish green. This is the canonical
   pre-push/release gate and includes formatting, production/test types, coverage,
   dead-code checks, dependency rules, deep lint, smoke, audit, shell lint when
   available, and repository-boundary guards.

## Phase 0.5 — Consolidate commits (don't ship a pile of fragments)

Releases should land as a few **logical** commits, not a trail of `fix: typo`,
`fix: again`, `chore: …` and per-fix version bumps. First **prefer batching**:
develop a change set fully (with local tests — `/dev`, `--dry-run`, unit tests)
and release ONCE, rather than patch→release→patch→release.

If the commits since the last tag are already fragmented, squash them before
bumping. Interactive rebase isn't available here, so use **reset --soft +
grouped recommit**:

1. `git log --oneline $(git describe --tags --abbrev=0)..HEAD` — review what's there.
2. If it reads as one or a few logical units, `git reset --soft <last-tag>` (all
   changes become staged; working tree untouched).
3. Recommit in logical groups by path — e.g. stage `src/` (minus tests) as a
   `feat:`/`fix:` commit, then `tests/` + `vitest.config.ts` as a `test:` commit.
   Unstage a group with `git restore --staged <paths>` before committing the rest.
4. **Verify nothing was lost**: `git diff <old-HEAD> HEAD -- . ':!package.json'`
   must be empty (only the version should differ). Then run the Phase 0 gate again.

Confirm with the user before any force-related rewrite of already-pushed history.

**Force-pushing a rewrite is gated harder than the bump push.** For a history
rewrite you must force-push, and `allow_force_pushes:false` rejects it even with
`enforce_admins` off (`remote: - Cannot force-push to this branch`) —
`allow_force_pushes` has no sub-endpoint, so PUT the full protection object open,
push, then PUT it back. Always restore, even if the push fails. The restore body
MUST keep the require-PR rule (`required_pull_request_reviews`, 0 approvals) or
the cycle silently deletes it. An informational `Required status check "verify"
is expected.` line during the open push is harmless — the `forced update` lands.

```bash
B=repos/OctopusGarage/tmux-claude-bot/branches/main/protection
gh api -X PUT $B --silent --input - <<'JSON'
{"required_status_checks":{"strict":true,"contexts":["verify"]},"enforce_admins":false,"required_pull_request_reviews":null,"restrictions":null,"allow_force_pushes":true,"allow_deletions":false,"required_conversation_resolution":false}
JSON
git push --force-with-lease origin main
gh api -X PUT $B --silent --input - <<'JSON'
{"required_status_checks":{"strict":true,"contexts":["verify"]},"enforce_admins":true,"required_pull_request_reviews":{"required_approving_review_count":0,"dismiss_stale_reviews":false,"require_code_owner_reviews":false},"restrictions":null,"allow_force_pushes":false,"allow_deletions":false,"required_conversation_resolution":false}
JSON
gh api $B --jq '{enforce_admins:.enforce_admins.enabled, force_pushes:.allow_force_pushes.enabled, require_pr:(.required_pull_request_reviews!=null)}'  # {true,false,true}
```

## Phase 0.6 — Doc alignment (does the documentation still match what shipped?)

Code drifts the docs that describe it — a renamed command, a new env var, a
changed flow — and a release that ships stale instructions is worse than no
docs. Before bumping, reconcile the **user-facing docs against the change set**.
This is a targeted reconcile, not a full doc audit: let the diff point you at
the docs that could have gone stale.

1. See what changed since the last tag:
   `git diff --stat $(git describe --tags --abbrev=0)..HEAD`.
2. For each changed area, open the doc that documents it and fix any drift:
   - **Chat commands / buttons** added, removed, or renamed → `docs/commands.md`,
     `docs/manual.md`, and `docs/automation-capability-matrix.md`.
   - **CLI commands / options** → `docs/cli-reference.md`, `docs/manual.md`, and
     `docs/agents/usage-guide.md`.
   - **Config / env vars / paths** → `.env.example`, `INSTALL.md`,
     `docs/manual.md`, and `docs/agents/usage-guide.md`.
   - **Behavior / architecture** (new feature or changed flow) →
     `docs/intelligent-automation.md`, `docs/automation-alignment.md`, and the
     relevant `docs/adr/` only when a documented decision changed.
   - **Dev / release process, gates, scripts** → `CONTRIBUTING.md`,
     `docs/TESTING.md`.
   - **Security-relevant** (auth, allowlist, data handling) → `SECURITY.md`.
3. Fix drift in place: correct stale facts, and tighten the wording while you're
   there — concise, accurate, no marketing. Don't document trivial internals;
   only what a user, operator, or contributor actually relies on.
4. Commit doc fixes as a `docs:` commit — fold it into the Phase 0.5
   consolidation if you haven't bumped yet — then re-run the Phase 0 gate (its
   secret/path scan already covers `*.md`).

If nothing drifted, say so and move on.

## Phase 1 — Bump, tag, push

`npm run release -- <bump>` does it all: it runs on `main`, requires a clean tree,
`git pull --ff-only`, `npm version` (bumps package.json + lock, commits, tags
`vX.Y.Z`), then `git push --follow-tags origin main`. Capture the new tag it prints.

**Branch protection blocks that push.** `main` is protected (`enforce_admins:true`
+ required `verify` check + a require-PR rule), so the script's `git push` is
rejected as-is. Toggle `enforce_admins` off around the **whole** `npm run release`
call and restore it immediately — even if the push fails. The bump push is a
fast-forward, so the `enforce_admins` toggle alone is enough (an exempt admin
bypasses require-PR + required checks for a non-force push); `allow_force_pushes`
does NOT need touching here.

```bash
B=repos/OctopusGarage/tmux-claude-bot/branches/main/protection
gh api -X DELETE $B/enforce_admins --silent          # open
npm run release -- <bump>                            # bumps, tags, pushes
gh api -X POST   $B/enforce_admins --silent          # restore (run even on failure)
gh api $B --jq '.enforce_admins.enabled'             # must print: true
```

## Phase 2 — GitHub release (published by CI)

The `Release` workflow (`.github/workflows/release.yml`) fires on the `v*` tag push
and creates the GitHub Release with a **commit-based changelog** (`git log
<prev>..<tag>`) plus the **install one-liner** and a Full Changelog link. Wait for
it, then verify:
- `gh run list --workflow=Release -L 1` shows the run succeeded (poll if needed).
- `gh release view vX.Y.Z` resolves, is marked **Latest**, and its body has both a
  Changes section and an Install section. If the changelog reads thin, edit it:
  `gh release edit vX.Y.Z --notes-file <file>`.

If CI is unavailable, create it manually:
`gh release create vX.Y.Z --generate-notes --title vX.Y.Z`.

## Phase 3 — (none)

## Phase 4 — Redeploy this machine (skip if `no-deploy`; macOS only)

Deploy the just-released tag to `~/.tmux-claude-bot` via the installer. It downloads
the lean release asset, mirrors it in with `rsync --delete` (so a prior git-clone or
source-archive install leaves no clutter), refreshes deps with `--omit=dev`, and
restarts the launchd service. `.env` and runtime state are gitignored and preserved.

**First, wait out the raw CDN.** `raw.githubusercontent.com/.../main/install.sh` is
cached ~5 min, so right after a push that touched `install.sh` the CDN can still serve
the old one — deploying with it silently does the wrong thing. Poll until the CDN
serves the same `install.sh` as this checkout, then deploy with that exact verified
copy (no second fetch). If `install.sh` was unchanged this release, the first check
matches immediately and there's no wait:

```bash
RAW="https://raw.githubusercontent.com/OctopusGarage/tmux-claude-bot/main/install.sh"
EXPECT="$(shasum install.sh | awk '{print $1}')"   # this checkout's installer
for i in $(seq 1 15); do
  curl -fsSL "$RAW" -o /tmp/tcb-install.sh
  [ "$(shasum /tmp/tcb-install.sh | awk '{print $1}')" = "$EXPECT" ] && { echo "CDN fresh"; break; }
  echo "[$i] CDN still stale, waiting 25s..."; sleep 25
done
TMUX_CLAUDE_BOT_VERSION="vX.Y.Z" bash /tmp/tcb-install.sh
```

(`.env` already present → the installer skips the setup wizard.)

## Phase 5 — Verify the deploy (skip if `no-deploy`)

1. Exactly one instance, launchd-managed, running from the install dir:
   `pgrep -fl "tmux-claude-bot.*(src/index.ts|dist/cli.js)"` → one PID; `ps -o ppid= -p <pid>`
   is `1`; `launchctl list | grep com.octopusgarage.tmux-claude-bot` shows it with
   exit code `0`.
2. Healthy startup, no conflict:
   `tail -n 20 ~/.tmux-claude-bot/logs/launchd.out.log` shows
   `Connected to Telegram` and no `409` / `Conflict` / `error`.

## Report

Summarize: new version, bump commit SHA, tag, release URL, redeploy PID, the
gate/verify results, and any docs reconciled in Phase 0.6 (or "docs already
aligned"). If you stopped early, say exactly which gate failed and what's needed
to proceed.
