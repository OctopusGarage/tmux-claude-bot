import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectCheckCommand } from "../../../src/core/autopilot/goals/detect-check.js";

let dir: string;
const pkg = (obj: unknown) => writeFileSync(join(dir, "package.json"), JSON.stringify(obj));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tcb-detect-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("detectCheckCommand", () => {
  it("undefined cwd → null", () => {
    expect(detectCheckCommand("coverage", undefined)).toBeNull();
    expect(detectCheckCommand("test", undefined)).toBeNull();
  });

  it("no project markers → null", () => {
    expect(detectCheckCommand("coverage", dir)).toBeNull();
    expect(detectCheckCommand("test", dir)).toBeNull();
  });

  it("package.json test:coverage script wins for coverage", () => {
    pkg({ scripts: { "test:coverage": "vitest run --coverage" } });
    expect(detectCheckCommand("coverage", dir)).toBe("npm run test:coverage");
  });

  it("package.json coverage script used when no test:coverage", () => {
    pkg({ scripts: { coverage: "c8 mocha" } });
    expect(detectCheckCommand("coverage", dir)).toBe("npm run coverage");
  });

  it("coverage falls back to vitest/jest dep when no coverage script", () => {
    pkg({ devDependencies: { vitest: "^1" } });
    expect(detectCheckCommand("coverage", dir)).toBe("npx vitest run --coverage");
    pkg({ devDependencies: { jest: "^29" } });
    expect(detectCheckCommand("coverage", dir)).toBe("npx jest --coverage");
  });

  it("package.json with no coverage script and no known runner → null for coverage", () => {
    pkg({ scripts: { test: "node t.js" } });
    expect(detectCheckCommand("coverage", dir)).toBeNull();
  });

  it("test uses npm test when a test script exists", () => {
    pkg({ scripts: { test: "node t.js" } });
    expect(detectCheckCommand("test", dir)).toBe("npm test");
  });

  it("test falls back to vitest/jest dep when no test script", () => {
    pkg({ devDependencies: { vitest: "^1" } });
    expect(detectCheckCommand("test", dir)).toBe("npx vitest run");
    pkg({ devDependencies: { jest: "^29" } });
    expect(detectCheckCommand("test", dir)).toBe("npx jest");
  });

  it("python markers → pytest", () => {
    writeFileSync(join(dir, "pyproject.toml"), "[tool.pytest.ini_options]\n");
    expect(detectCheckCommand("coverage", dir)).toBe("pytest --cov --cov-report=term-missing");
    expect(detectCheckCommand("test", dir)).toBe("pytest");
  });

  it("go.mod → go test", () => {
    writeFileSync(join(dir, "go.mod"), "module x\n");
    expect(detectCheckCommand("coverage", dir)).toBe("go test -cover ./...");
    expect(detectCheckCommand("test", dir)).toBe("go test ./...");
  });

  it("Cargo.toml → cargo test for test, null for coverage", () => {
    writeFileSync(join(dir, "Cargo.toml"), "[package]\n");
    expect(detectCheckCommand("coverage", dir)).toBeNull();
    expect(detectCheckCommand("test", dir)).toBe("cargo test");
  });

  it("malformed package.json does not throw; falls through to other markers", () => {
    writeFileSync(join(dir, "package.json"), "{ not json");
    writeFileSync(join(dir, "go.mod"), "module x\n");
    expect(detectCheckCommand("test", dir)).toBe("go test ./...");
    // malformed package.json alone → null
    rmSync(join(dir, "go.mod"));
    expect(detectCheckCommand("test", dir)).toBeNull();
  });
});
