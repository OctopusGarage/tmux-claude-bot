import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** True iff `path` exists (any type). Never throws. */
function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

type Pkg = { scripts: Record<string, string>; deps: Set<string> };

/** Parse `<cwd>/package.json`; null if absent or malformed. Never throws. */
function readPackageJson(cwd: string): Pkg | null {
  try {
    const raw = readFileSync(join(cwd, "package.json"), "utf8");
    const obj = JSON.parse(raw) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return {
      scripts: obj.scripts ?? {},
      deps: new Set([
        ...Object.keys(obj.dependencies ?? {}),
        ...Object.keys(obj.devDependencies ?? {}),
      ]),
    };
  } catch {
    return null;
  }
}

/**
 * Resolve the project's coverage/test command from cwd markers, or null when
 * undetectable (caller treats null as "ask a human"). A present, parseable
 * package.json is authoritative for a JS project: it prefers an existing
 * script (so a repo's own coverage gate is honored), then a known JS runner,
 * else returns null WITHOUT falling through. Only an absent/malformed
 * package.json falls through to Python / Go / Rust markers. Pure + synchronous.
 */
export function detectCheckCommand(
  purpose: "coverage" | "test",
  cwd: string | undefined,
): string | null {
  if (cwd === undefined) return null;

  const pkg = readPackageJson(cwd);
  if (pkg) {
    if (purpose === "coverage") {
      if ("test:coverage" in pkg.scripts) return "npm run test:coverage";
      if ("coverage" in pkg.scripts) return "npm run coverage";
      if (pkg.deps.has("vitest")) return "npx vitest run --coverage";
      if (pkg.deps.has("jest")) return "npx jest --coverage";
      return null;
    }
    if ("test" in pkg.scripts) return "npm test";
    if (pkg.deps.has("vitest")) return "npx vitest run";
    if (pkg.deps.has("jest")) return "npx jest";
    return null;
  }

  if (
    exists(join(cwd, "pyproject.toml")) ||
    exists(join(cwd, "setup.cfg")) ||
    exists(join(cwd, "pytest.ini")) ||
    exists(join(cwd, "tox.ini"))
  ) {
    // Run pytest through the project's package manager so it uses that project's
    // venv (with its plugins, e.g. pytest-cov) — a bare `pytest` often resolves
    // to a global interpreter that then errors on the project's addopts
    // (`--cov`, `--cov-fail-under`, …). Mirrors preferring an existing npm script.
    const runner = exists(join(cwd, "uv.lock"))
      ? "uv run "
      : exists(join(cwd, "poetry.lock"))
        ? "poetry run "
        : "";
    return purpose === "coverage"
      ? `${runner}pytest --cov --cov-report=term-missing`
      : `${runner}pytest`;
  }

  if (exists(join(cwd, "go.mod"))) {
    return purpose === "coverage" ? "go test -cover ./..." : "go test ./...";
  }

  if (exists(join(cwd, "Cargo.toml"))) {
    return purpose === "coverage" ? null : "cargo test";
  }

  return null;
}
