import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { provisionOperatorHome } from "../src/core/projects/operator-home.js";

let tempDirs: string[] = [];

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "tcb-operator-home-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("provisionOperatorHome", () => {
  it("creates cross-agent operator workspace instructions", () => {
    const dir = tempHome();

    provisionOperatorHome(dir);

    const claude = readFileSync(join(dir, "CLAUDE.md"), "utf8");
    const agents = readFileSync(join(dir, "AGENTS.md"), "utf8");
    const readme = readFileSync(join(dir, "README.md"), "utf8");
    const manifest = JSON.parse(readFileSync(join(dir, "role-manifest.json"), "utf8"));
    const homeSkill = JSON.parse(readFileSync(join(dir, "skills/tcb-home-operator.json"), "utf8"));
    const observerMcp = JSON.parse(readFileSync(join(dir, "mcp/observer.json"), "utf8"));
    expect(claude).toContain("Home Operator");
    expect(agents).toBe(claude);
    expect(readme).toContain("Home Operator Workspace");
    expect(readme).toContain("control service remains responsible");
    expect(manifest).toMatchObject({
      role: "home-operator",
      canonicalSkill: "tcb-home-operator",
      authority: "operator-provenance-only",
    });
    expect(homeSkill.capabilityClasses).toContain("delegation");
    expect(observerMcp).toMatchObject({ profile: "observer", exposure: "read-only" });
    expect(observerMcp.tools).toContain("tcb.observer.runtime_guardian_findings");
  });

  it("does not clobber existing operator workspace files", () => {
    const dir = tempHome();
    provisionOperatorHome(dir);
    writeFileSync(join(dir, "AGENTS.md"), "custom operator note\n");
    writeFileSync(join(dir, "mcp/home.json"), '{"custom":true}\n');

    provisionOperatorHome(dir);

    expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toBe("custom operator note\n");
    expect(readFileSync(join(dir, "mcp/home.json"), "utf8")).toBe('{"custom":true}\n');
    expect(existsSync(join(dir, "CLAUDE.md"))).toBe(true);
    expect(existsSync(join(dir, "README.md"))).toBe(true);
  });
});
