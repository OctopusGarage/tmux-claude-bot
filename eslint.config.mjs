// Deep, type-aware lint — a NARROW complement to biome (style) and tsc (types).
// It enables only three behavioural rules that need type information and that
// neither biome nor tsc can express: floating promises, async-where-void-is-
// expected, and conditions that are always/never true (dead guards). Warn-level
// and non-blocking by design (`npm run lint:deep`) — triage, don't gate, until
// the noise is understood. See docs/TESTING.md.
import tseslint from "typescript-eslint";

export default tseslint.config({
  files: ["src/**/*.ts"],
  extends: [tseslint.configs.base],
  // Only three rules are on, so disable-directives written for other rules would
  // otherwise be reported as "unused" — that's noise here, not a finding.
  linterOptions: { reportUnusedDisableDirectives: false },
  languageOptions: {
    parserOptions: {
      projectService: true,
      tsconfigRootDir: import.meta.dirname,
    },
  },
  rules: {
    "@typescript-eslint/no-floating-promises": "warn",
    "@typescript-eslint/no-misused-promises": "warn",
    "@typescript-eslint/no-unnecessary-condition": "warn",
  },
});
