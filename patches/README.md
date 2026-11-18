# Dependency security patches

## picomatch 4.0.7: repeated-extglob denial of service

[GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf)
affects the published versions through 4.0.7. As of 2026-11-18, the registry has
no fixed release. This repository carries a local mitigation in
`picomatch@4.0.7.patch`, applied reproducibly through pnpm `patchedDependencies`.
It is not an upstream release or an adoption of the unrelated, incomplete
[picomatch PR 194](https://github.com/micromatch/picomatch/pull/194).

The patch changes `extglobClose` in the upstream
[4.0.7 parser](https://github.com/micromatch/picomatch/blob/4.0.7/lib/parse.js).
It uses parsed wildcard tokens to detect an unbounded wildcard nested inside a
repeated `+(...)` or `*(...)` group, including single-branch forms such as
`+(*)` and `+(*a)`. Such groups become literals, following the parser's existing
handling of risky extglobs. Ordinary globs, literal repetitions, escaped/quoted
stars, character classes and existing safe nested-star normalization remain
supported. The upstream explicit `maxExtglobRecursion: false` safety opt-out is
unchanged; callers that disable protection are not covered. This is a mitigation
for the identified advisory, not a claim that every possible regular expression
is safe.

Provenance (SHA-256):

- Original `lib/parse.js`: `4e1e05447668aa1e94366c5516a2bcd8f5fff800cc92b1d0cd7d77703b8618c4`
- Patch: `f8562132ea07d803714990e4217e05c408b91faa49293553df9f21f88cff7adc`
- Patched `lib/parse.js`: `031fc058cd0c7a44b27325caeec355cd9305807c500c50f7ab65d0d754cc2024`

The lockfile retains npm's upstream tarball integrity and the exact patch hash.
Install with `pnpm install --frozen-lockfile`. No external checkout or mutable
GitHub branch is needed to apply the patch.

## Verification and audit behavior

Run `pnpm test:security` and `pnpm run audit`. The project audit prints the raw
registry report, verifies the patch declaration, lockfile, all resolved installed
picomatch paths and source digest, then runs security and compatibility probes in
a child process with a five-second deadline. Missing installations, unexpected
versions, missing or modified patches, changed source and probe failures block.

Only the exact advisory for the verified 4.0.7 installation is classified as
**locally remediated**. Its original finding remains visible. All other findings
retain the project's existing severity threshold. Registry transport failures,
malformed reports and unknown severities fail closed. There is no audit ignore
list and no disabled Git hook. The raw `pnpm audit` command still reports the
upstream version as vulnerable because registry matching cannot inspect patches;
use `pnpm run audit` for the verified project check.

Before patching, the two primary attack cases exceeded a bounded two-second
child-process deadline. Tests now cover the attack variants and ordinary matching,
as well as rejection of unpatched/mismatched installations and unrelated findings.

When a fixed upstream release becomes available, replace the patch with that
release, rerun the regression and full project checks, and remove the exact local
remediation from the checker. Do not broaden the exception or merely update its
hash without reviewing source and behavior. Root-level pnpm overrides and patches
do not propagate to separate npm/global installation roots; audit those roots
independently. Picomatch is a development-tool dependency in these lockfiles.
