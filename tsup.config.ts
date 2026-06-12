import { defineConfig } from "tsup";

// Bundle the TypeScript source to a self-contained ESM dist. `dependencies` are
// auto-externalized by tsup (resolved from node_modules at runtime); only our
// own source is bundled. The shebang in src/cli.ts is preserved on the entry.
export default defineConfig({
  entry: { cli: "src/cli.ts" },
  format: ["esm"],
  platform: "node",
  target: "node22",
  splitting: true,
  clean: true,
  dts: false,
  sourcemap: false,
  outDir: "dist",
});
