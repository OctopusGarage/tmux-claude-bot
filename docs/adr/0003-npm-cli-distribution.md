# ADR-0003: npm-first CLI distribution

**Date:** 2026-06-12
**Status:** Proposed

## Context

Today the bot is distributed only as a `curl … install.sh | bash` one-liner that
`git clone`s into `~/.tmux-claude-bot`, installs deps, runs a setup wizard, and
registers a launchd service. The launchd service runs the **TypeScript source
directly via `tsx`** (`node --import tsx … src/index.ts`); `dist/` is built by
`tsc` but is not used by the running service. User-facing operations are spread
across separate entry points: `tsx src/scripts/setup.ts`, `tsx
src/scripts/doctor.ts`, and a set of `scripts/*.sh` wrappers invoked through
`npm run service:*`.

This works but is not the shape a developer-facing tool is expected to take in
2025/2026. It has no presence on a registry, no `npx` entry, no provenance, runs
a dev toolchain (`tsx`) at production runtime, and exposes its operations as a
grab-bag of scripts rather than one coherent command.

## Decision

Adopt the **npm-package-as-distribution-unit + single `bin` CLI** pattern that
mature developer daemons use (PM2, wrangler, vercel). Concretely:

1. **One `bin` CLI** (`tmux-claude-bot`) is the single entry point. All
   operations become subcommands of it:

   ```
   tmux-claude-bot run                  # run the bot (foreground; what launchd execs)
   tmux-claude-bot setup [--reconfigure]
   tmux-claude-bot setup:lark
   tmux-claude-bot doctor
   tmux-claude-bot service install|uninstall|status|logs|restart|pause|resume
   ```

   This is the elegant answer to "how does launchd coexist with npm": **service
   registration is an explicit subcommand, never an npm `postinstall`** — exactly
   PM2's `pm2 startup` model. Installing the package never touches the user's
   system; the user (or installer) runs `service install` deliberately.

2. **Ship bundled `dist/`, not source.** Build with **tsup/esbuild** to a
   self-contained ESM bundle with a `#!/usr/bin/env node` shebang. Runtime no
   longer depends on `tsx`. `files` whitelists only the shippable surface;
   `tests/`, `coverage/`, `logs/`, `docs/` are excluded.

3. **Release automation + supply-chain trust.** Publish from CI with
   `npm publish --provenance` (GitHub Actions OIDC) so the npm page shows a
   provenance badge. Version/changelog managed by the existing release flow (or
   changesets).

4. **`curl | bash` and Homebrew become thin wrappers**, not the canonical path —
   they bootstrap node + invoke the npm CLI. `curl|bash` stays for the
   zero-prerequisites crowd; a Homebrew tap is deferred (second priority).

### Staging (each stage independently verifiable; live service untouched until Stage 2)

- **Stage 1 — foundation (no risk):** add tsup + `src/cli.ts` (commander)
  dispatching to the existing `run`/`setup`/`doctor`/`service` logic; add
  `bin`/`files`/`exports`/`build` to `package.json`. Verified by `npm run build`,
  `node dist/cli.js --help`, `… doctor`, `npm pack --dry-run`. Does **not** change
  the launchd wrapper or the live service.
- **Stage 2 — rewire runtime (touches live service):** point
  `scripts/launchd-wrapper.sh` and `install.sh` at `node dist/cli.js run` instead
  of `tsx src/index.ts`; build during install. Gated on explicit confirmation
  because it changes the running production instance.
- **Stage 3 — publish:** name/scope decided (`@octopusgarage/tmux-claude-bot`);
  added the manual `Publish to npm` workflow (`npm-publish.yml`,
  `npm publish --provenance` over OIDC). Publishing stays a deliberate
  `workflow_dispatch` click and needs the `NPM_TOKEN` repo secret.
- **Stage 4 (deferred):** Homebrew tap; optional `npm i -g` as a first-class
  local tool.

## Open decisions (require the maintainer)

- **Package name / scope:** bare `tmux-claude-bot` vs scoped
  `@octopusgarage/tmux-claude-bot` (recommended: scoped, `publishConfig.access:
  public`). Permanent once published.
- **Canonical install path after Stage 2:** keep `curl|bash` as canonical, or
  promote `npx`/`npm i -g` to canonical with `curl|bash` as a convenience shim.

## Consequences

- Operations converge behind one discoverable command with `--help`/`--version`
  for free; the `scripts/*.sh` + `npm run service:*` surface can shrink to thin
  shims (or be removed) once the CLI covers them.
- The launchd **service runtime** no longer loads `tsx` (it runs the prebuilt
  `dist/` bundle): faster cold start, runtime decoupled from the dev toolchain.
  `tsx` stays a dependency only because the source-run management scripts
  (`npm run setup`/`doctor`/`setup:lark`) still execute TypeScript directly in
  the pruned prod install; routing those through the dist CLI to fully drop `tsx`
  is a possible follow-up.
- A new maintenance surface appears (the published package + release pipeline);
  mitigated by automating publish in CI and keeping a single bundler config.
- Pure ESM only — no CJS/ESM dual build (that is a *library* concern; this is a
  terminal CLI).
