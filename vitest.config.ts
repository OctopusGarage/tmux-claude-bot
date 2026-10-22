import { configDefaults, defineConfig } from "vitest/config";

// These suites verify process-global APIs that worker threads cannot mutate.
const processApiTests = [
  "tests/adapters/control/server.test.ts",
  "tests/core/power-schedule.test.ts",
];
const integrationTests = ["tests/integration/tmux-live.test.ts", "tests/tui/composer-pty.test.ts"];
const excludedTests = [
  ".claude/worktrees/**",
  ".stryker-tmp/**",
  "**/node_modules/**",
];

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Avoid repeated OS process startup under host memory pressure. Keep each
    // suite isolated and serialize worker threads rather than forking processes.
    pool: "threads",
    // Keep full local/coverage gates within the host's CPU and memory envelope.
    // Several suites spawn real child processes, so high coverage parallelism
    // causes scheduler starvation and false 30-second timeouts on busy hosts.
    maxWorkers: 1,
    setupFiles: ["tests/setup.ts"],
    testTimeout: 30_000,
    // Nested worktrees are independent branches, not additional test suites.
    exclude: excludedTests,
    projects: [
      {
        test: {
          name: "unit",
          include: [
            ...configDefaults.include,
            ...[...processApiTests, ...integrationTests].map((file) => `!${file}`),
          ],
        },
      },
      { test: { name: "process-api", pool: "forks", include: processApiTests } },
      { test: { name: "integration", pool: "forks", include: integrationTests } },
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
