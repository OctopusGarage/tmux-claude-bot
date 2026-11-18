# Dependency security verification

Run `pnpm test:security` and `pnpm run audit`; `pnpm verify:local` and CI use the
same checks. High and critical unremediated findings block delivery. Audit
service failures also block rather than reporting a successful audit.

See [patch provenance and verification](../patches/README.md) for the temporary
picomatch 4.0.7 source mitigation and the difference between a raw registry
finding and a verified local repair. No audit ignore list is configured.

Security version overrides belong under `pnpm.overrides` in `package.json`.
The former top-level npm `overrides` field was not effective with pnpm. Only
confirmed affected dependency edges are pinned; the lockfile records the
resolved versions. Hono/node-server, fast-uri, qs and esbuild use patched
versions. Stryker, ESLint and typescript-eslint use minimatch 11.0.1; security tests exercise Stryker file matching and
validation APIs and ESLint path selection. Full lint, build and test checks cover
the changed dependency graph; a complete mutation campaign is not required.
