import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
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
      ],
    },
  },
});
