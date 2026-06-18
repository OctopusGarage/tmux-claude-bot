import { readFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The app's version, resolved by walking up from this module to the nearest
 * `package.json`. Robust across BOTH layouts: the tsx/`src` tree (this file at
 * `src/shared/`) and the bundled `dist/` (where bundling flattens module depth,
 * so a fixed relative `../..` would overshoot). Defaults to "0.0.0".
 *
 * Memoized: the version is constant for a process, and the dir-walk + readFileSync
 * is pure waste on repeat calls (e.g. once per dashboard build).
 */
let cached: string | undefined;

export function appVersion(): string {
  if (cached !== undefined) return cached;
  let dir = dirname(fileURLToPath(import.meta.url));
  const root = parse(dir).root;
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
        version?: string;
      };
      if (typeof pkg.version === "string") {
        cached = pkg.version;
        return cached;
      }
    } catch {
      // no readable package.json here — keep walking up
    }
    if (dir === root) {
      cached = "0.0.0";
      return cached;
    }
    dir = dirname(dir);
  }
}
