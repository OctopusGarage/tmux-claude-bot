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
3. Run the verification gate; require all green:
   - `npm test`
   - `npm run lint`
   - `npm run lint:sh` (shellcheck — install.sh / dev.sh / scripts)
   - `npm run lint:types && npm run lint:types:tests`
   - `npm run knip`
   - Secret / personal-path scan (from CLAUDE.md). `/Users/x`, `/Users/test`,
     `/home/user`, `/home/u` are allowed generic placeholders:
     ```
     grep -rn "/Users/[a-z]\+/\|/home/[a-z]\+/" --include="*.ts" --include="*.md" src/ tests/ docs/ \
       | grep -vE "/Users/(x|test)/|/home/(user|u)/" || echo "clean"
     ```
     Expect `clean`.

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

## Phase 1 — Bump, tag, push

`npm run release -- <bump>` does it all: it runs on `main`, requires a clean tree,
`git pull --ff-only`, `npm version` (bumps package.json + lock, commits, tags
`vX.Y.Z`), then `git push --follow-tags origin main`. Capture the new tag it prints.

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

Summarize: new version, bump commit SHA, tag, release URL, redeploy PID, and the
gate/verify results. If you stopped early, say exactly which gate failed and what's
needed to proceed.
