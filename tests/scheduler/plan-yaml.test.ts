import { describe, expect, it } from "vitest";
import { parsePlanYaml, planToYaml } from "../../src/core/scheduler/plan-yaml.js";

const good = `
id: nightly
name: Nightly
pools: { claude: 2, codex: 1 }
schedule: { kind: cron, cron: "0 2 * * *" }
defaults: { rounds: 1, retries: 1 }
projects:
  - { path: /a, agent: claude, goals: [fix-tests], priority: 5 }
  - { path: /b, agent: codex, goals: [code-review] }
`;

describe("parsePlanYaml", () => {
  it("parses a valid plan", () => {
    const p = parsePlanYaml(good);
    expect(p.id).toBe("nightly");
    expect(p.pools).toEqual({ claude: 2, codex: 1 });
    expect(p.projects).toHaveLength(2);
    expect(p.projects[0]).toMatchObject({
      path: "/a",
      agent: "claude",
      goals: ["fix-tests"],
      priority: 5,
    });
    expect(p.schedule).toEqual({ kind: "cron", cron: "0 2 * * *" });
  });
  it("rejects an unknown goal id with a clear message", () => {
    expect(() => parsePlanYaml(good.replace("fix-tests", "no-such-goal"))).toThrow(/no-such-goal/);
  });
  it("rejects an unknown agent", () => {
    expect(() => parsePlanYaml(good.replace("agent: claude", "agent: gemini"))).toThrow(/agent/i);
  });
  it("rejects malformed YAML / missing required fields", () => {
    expect(() => parsePlanYaml("projects: []")).toThrow(); // no id/name/pools
  });
});

describe("planToYaml round-trips", () => {
  it("export → parse yields an equivalent plan", () => {
    const p = parsePlanYaml(good);
    expect(parsePlanYaml(planToYaml(p))).toEqual(p);
  });
});
