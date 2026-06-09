/**
 * Architecture rules for the Telegram bot.
 *
 * Layering (presentation -> domain -> primitives):
 *   src/bot       (grammY handlers, replies, executor)  may depend on services + utils
 *   src/services  (domain: tmux, claude, queue, history) may depend on utils
 *   src/utils     (logger, hash, sleep, string, error)   depends on nothing internal
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
      name: "utils-are-primitives",
      severity: "error",
      comment: "src/utils are leaf primitives: they must not import from services or bot.",
      from: { path: "^src/utils" },
      to: { path: "^src/(services|bot)" },
    },
    {
      name: "services-not-depend-on-bot",
      severity: "error",
      comment: "Domain (services) must not depend on presentation (bot).",
      from: { path: "^src/services" },
      to: { path: "^src/bot" },
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
