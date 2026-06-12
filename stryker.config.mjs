// Mutation testing for the protocol-agnostic core. Coverage tells you a line
// RAN; mutation testing tells you a test would NOTICE if that line were wrong —
// it catches the "executed but unasserted" class (e.g. a dead retry loop whose
// removal breaks no test). Slow, so it's a periodic / CI-nightly gate, NOT part
// of `npm test`. Run with `npm run mutation` (optionally `-- --mutate <glob>`).
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  packageManager: "npm",
  testRunner: "vitest",
  reporters: ["html", "clear-text", "progress"],
  // Only run the tests that actually cover each mutant — keeps the run tractable.
  coverageAnalysis: "perTest",
  mutate: [
    "src/core/**/*.ts",
    "src/shared/config.ts",
    "!src/core/**/*.d.ts",
    // Pure data catalogs / interactive wizard — no logic worth mutating.
    "!src/core/i18n/catalog/**",
    "!src/core/i18n/setup.ts",
  ],
  // Informational thresholds for now (no `break`) — surface the score, then
  // tighten into a hard gate once a baseline is established.
  thresholds: { high: 80, low: 60, break: 0 },
  timeoutMS: 30000,
};
