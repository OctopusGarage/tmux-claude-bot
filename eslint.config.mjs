// Deep, type-aware lint — a NARROW complement to biome (style) and tsc (types):
// three behavioural rules needing type info that neither can express. Mixed
// severity on purpose (`npm run lint:deep`):
//  - the async-hygiene rules ERROR (and gate CI): a floating / misused promise is
//    almost always a real bug, with an explicit escape hatch (`void x()`).
//  - no-unnecessary-condition WARNS only: it's type-based, and types lie (parsed
//    JSON, SDK payloads, `as` casts), so defensive `?.`/`??` is often correct
//    even when "unnecessary" — gating it would force deleting real safety nets.
// See docs/TESTING.md.
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
    "@typescript-eslint/no-floating-promises": "error",
    "@typescript-eslint/no-misused-promises": "error",
    "@typescript-eslint/no-unnecessary-condition": "warn",
  },
});
