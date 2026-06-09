/**
 * Architecture rules for the layered bot.
 *
 * Layering (adapter -> core -> shared primitives):
 *   src/adapters/*  (platform adapters: Telegram grammY handlers, replies,
 *                    rendering, keyboards, transport) may depend on core + shared
 *   src/core        (protocol-agnostic: tmux, claude, queue, command dispatch,
 *                    project, history) may depend on shared
 *   src/shared      (config, types, utils: logger, hash, sleep, error) depends
 *                    on nothing internal — leaf primitives
 *
 * The point of the seam: core must NEVER import from an adapter, so the same
 * core can be driven by Telegram today and Feishu later.
 *
 * Enforced in CI via `npm run depcruise`. Run `npx depcruise --output-type err` locally.
 */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment: "Circular dependencies make modules impossible to reason about in isolation.",
      from: {},
      to: { circular: true },
    },
    {
      name: "shared-are-primitives",
      severity: "error",
      comment: "src/shared are leaf primitives: they must not import from core or adapters.",
      from: { path: "^src/shared" },
      to: { path: "^src/(core|adapters)" },
    },
    {
      name: "core-not-depend-on-adapters",
      severity: "error",
      comment:
        "Core is protocol-agnostic and reusable across platforms: it must not depend on any adapter (Telegram, Feishu, …).",
      from: { path: "^src/core" },
      to: { path: "^src/adapters" },
    },
    {
      name: "no-orphans",
      severity: "warn",
      comment: "Orphan modules are usually dead code (Knip also tracks this).",
      from: { orphan: true, pathNot: ["\\.d\\.ts$", "(^|/)tsconfig\\.json$"] },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["import", "node"] },
  },
};
