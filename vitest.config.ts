import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["tests/setup.ts"],
    coverage: {
      provider: "v8",
      all: true,
      include: ["src/**/*.ts"],
      // Entrypoints, wiring, and scripts aren't unit-testable in isolation —
      // they bootstrap real network/tmux/process resources. Excluding them
      // keeps the coverage number honest rather than inflated by untested glue.
      exclude: [
        "src/index.ts",
        "src/scripts/**",
        "src/adapters/*/start.ts",
        "**/*.d.ts",
        // Pure data catalogs and interactive wizard — no executable logic to cover.
        "src/core/i18n/catalog/**",
        "src/core/i18n/setup.ts",
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 74, // current ~74%; raise toward 80 as branch coverage improves
        statements: 80,
      },
    },
  },
});
