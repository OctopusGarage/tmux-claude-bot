import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["tests/setup.ts"],
    exclude: [
      // Prevent git worktrees nested under .claude/worktrees/ from being picked
      // up as additional test suites — they are independent branches/sandboxes.
      ".claude/worktrees/**",
      ".stryker-tmp/**",
      "**/node_modules/**",
    ],
    coverage: {
      provider: "v8",
      all: true,
      include: ["src/**/*.ts"],
      // Entrypoints, wiring, and scripts aren't unit-testable in isolation —
      // they bootstrap real network/tmux/process resources. Excluding them
      // keeps the coverage number honest rather than inflated by untested glue.
      exclude: [
        "src/index.ts",
        "src/cli.ts",
        // Composition root: wires the whole HandlerDeps graph (runners, queue, tmux
        // bridge, fs.watch roots) from real resources — the DI glue index.ts/cli.ts
        // invoke. Not unit-testable in isolation (same class as the entrypoints).
        "src/bootstrap.ts",
        "src/scripts/**",
        "src/adapters/*/start.ts",
        "**/*.d.ts",
        // Pure data catalogs and interactive wizard — no executable logic to cover.
        "src/core/i18n/catalog/**",
        "src/core/i18n/setup.ts",
        // Terminal (Ink) render + raw-stdin bootstrap, and the one-shot CLI clients:
        // framework glue that drives a real TTY / process.exit, not unit-testable in
        // isolation (same rationale as the entrypoints above). The transport logic
        // underneath them — adapters/control (protocol/client/server) and the pure
        // composer parser — is NOT excluded; it's covered by real unit tests.
        "src/tui/app.tsx",
        "src/tui/run.ts",
        "src/cli/control.ts",
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
