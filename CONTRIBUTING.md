# Contributing

tmux-claude-bot is a TypeScript (ESM) Telegram bot that drives Claude Code in tmux
panes. It runs on Node via the `tsx` loader — there is no build step for running.

## Development setup

```bash
git clone https://github.com/OctopusGarage/tmux-claude-bot.git
cd tmux-claude-bot
npm install
npm run setup        # guided wizard, writes a 0600 .env (BOT_TOKEN, etc.)
npm run dev          # tsx watch src/index.ts, hot reload (./dev.sh runs it proxy-free)
```

Health check anytime with `npm run doctor`. The **`/dev`** Claude command drives this
whole loop (safe start/stop + debug recipes).

> **One bot instance at a time.** Two long-pollers on the same token = 409 Conflict, so
> a `npm run dev` session and the production launchd service can't share a `BOT_TOKEN`.
> Two ways to coexist:
>
> - **Recommended — a separate dev bot.** Give this clone's `.env` its own token (a second
>   bot from [@BotFather](https://t.me/BotFather)). Then `npm run dev` never touches prod.
>   `./dev.sh` warns you if it detects the same token as the running service.
> - **Or pause prod** for the session: `npm run service:pause` … develop … `npm run service:resume`.

### Managing the local service

```bash
npm run service:status     # is the managed bot loaded / running?
npm run service:pause      # stop it (before dev, to avoid 409)
npm run service:resume     # start it again
npm run service:restart    # reload latest code in ~/.tmux-claude-bot
npm run service:logs       # tail the launchd stdout log
npm run service:install    # (re)install the launchd plist
```

## Before you open a PR

Everything must be green — these are the same gates `/release` enforces:

```bash
npm test                                   # vitest (TDD: add/keep tests)
npm run lint                               # biome
npm run lint:types && npm run lint:types:tests
npm run knip                               # dead-code / unused deps
```

New behavior is test-first. Match the surrounding style; keep changes surgical.

### Sensitive data

Never hardcode personal paths, usernames, or credentials — they go in `.env`
(gitignored) or via `process.env` / `os.homedir()`. Tests use generic placeholders
(`/Users/x`, `/home/user`). Pre-commit scan:

```bash
grep -rn "/Users/[a-z]\+/\|/home/[a-z]\+/" --include="*.ts" --include="*.md" src/ tests/ docs/ \
  | grep -vE "/Users/(x|test)/|/home/(user|u)/" || echo "clean"
```

## Conventions

- Conventional commits (`feat:`, `fix:`, `refactor:`, `chore:`, `docs:`).
- End commit messages with the Co-Authored-By trailer when paired with Claude.
- Domain model in `CONTEXT.md`; design decisions in `docs/adr/`.

## Install & deploy

The bot is installed and updated with one command (idempotent — re-run to update):

```bash
curl -fsSL https://raw.githubusercontent.com/OctopusGarage/tmux-claude-bot/main/install.sh | bash
```

- Defaults to the **latest published release** (lean tarball, no `.git`), into
  `~/.tmux-claude-bot` (override with `TMUX_CLAUDE_BOT_DIR`). Pin a version with
  `TMUX_CLAUDE_BOT_VERSION=v1.2.3`, or track the branch with
  `TMUX_CLAUDE_BOT_VERSION=main` (git clone, `git pull` updates).
- It installs deps, runs the setup wizard on first install (your `.env` and
  runtime state are gitignored and preserved across updates), and registers the
  launchd service (`com.octopusgarage.tmux-claude-bot`, auto-restart on crash/boot).
- Redeploy this machine anytime with the **`/deploy`** Claude command, or by
  re-running the installer.

Manage the service:

```bash
npm run service:install        # install/refresh the launchd plist
npm run service:uninstall
launchctl kickstart -k gui/$(id -u)/com.octopusgarage.tmux-claude-bot   # restart
launchctl list | grep com.octopusgarage.tmux-claude-bot                 # status
```

## Cutting a release

Run the **`/release`** Claude command (`patch` by default) — it gates on the full
verification suite, then bumps, tags, and pushes; CI publishes the GitHub Release;
and it redeploys + verifies this machine. The mechanics it drives:

```bash
npm run release -- patch       # or minor | major | X.Y.Z
```

`npm run release` (`scripts/release.sh`) bumps the version, creates the `vX.Y.Z`
tag, and pushes with `--follow-tags`. The `Release` workflow then publishes the
GitHub Release from the tag. Add `no-deploy` to `/release` to skip the local
redeploy.

### Publishing to npm

The package (`@octopusgarage/tmux-claude-bot`) ships separately from the GitHub
Release, via the **manual** `Publish to npm` workflow (`npm-publish.yml`) — not
auto-fired on tag, so a registry publish is always a deliberate click. After a
release tag exists, run that workflow from the Actions tab (leave `ref` blank for
the default branch, or enter the tag). It runs `npm publish --provenance` (OIDC
build attestation → provenance badge on npmjs.com); `prepublishOnly` builds the
`tsup` bundle and `files` ships `dist/` + `scripts/` + the installer only.

One-time setup: add a repo secret **`NPM_TOKEN`** (an npm automation or granular
token with publish rights to the `@octopusgarage` scope).

## Reporting issues

Issues live in GitHub Issues. See `docs/agents/issue-tracker.md` and the triage
labels in `docs/agents/triage-labels.md`.
