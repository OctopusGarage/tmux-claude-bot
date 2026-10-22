import { describe, expect, it } from "vitest";
import {
  assessWorkspaceArchitecture,
  parseArchitectureAssessment,
} from "../../src/core/loop/workspace-assessment.js";

describe("workspace Architecture assessment", () => {
  it("scores a clean, well-described two-repository workspace at the target", () => {
    const result = assessWorkspaceArchitecture({
      targetScore: 95,
      repositories: [
        { id: "backend", name: "Backend", path: "/repo/backend" },
        { id: "frontend", name: "Frontend", path: "/repo/frontend" },
      ],
      exists: (path) =>
        [
          "/repo/backend",
          "/repo/frontend",
          "/repo/backend/README.md",
          "/repo/backend/CLAUDE.md",
          "/repo/backend/pyproject.toml",
          "/repo/frontend/README.md",
          "/repo/frontend/CLAUDE.md",
          "/repo/frontend/package.json",
        ].includes(path),
      runGit: ({ cwd, args }) => {
        if (args[0] === "rev-parse") return { status: 0, stdout: `${cwd}\n`, stderr: "" };
        if (args[0] === "status") return { status: 0, stdout: "", stderr: "" };
        return { status: 1, stdout: "", stderr: "unexpected git command" };
      },
    });

    expect(result).toMatchObject({ score: 100, targetScore: 95, decision: "skip" });
    expect(result.blockers).toEqual([]);
  });

  it("blocks before dispatch when a repository is dirty or not a git root", () => {
    const result = assessWorkspaceArchitecture({
      targetScore: 95,
      repositories: [{ id: "backend", name: "Backend", path: "/repo/backend" }],
      exists: () => true,
      runGit: ({ args }) =>
        args[0] === "rev-parse"
          ? { status: 1, stdout: "", stderr: "not a git repository" }
          : { status: 0, stdout: " M src/app.py\n", stderr: "" },
    });

    expect(result).toMatchObject({ decision: "block", score: null, targetScore: 95 });
    expect(result.blockers).toEqual([
      "backend is not a valid git repository: not a git repository",
    ]);
  });

  it("selects Architecture only when the score is below the target", () => {
    const result = assessWorkspaceArchitecture({
      targetScore: 95,
      repositories: [{ id: "backend", name: "Backend", path: "/repo/backend" }],
      exists: (path) => path === "/repo/backend",
      runGit: ({ cwd, args }) =>
        args[0] === "rev-parse"
          ? { status: 0, stdout: `${cwd}\n`, stderr: "" }
          : { status: 0, stdout: "", stderr: "" },
    });

    expect(result).toMatchObject({ decision: "run", score: 50, targetScore: 95 });
    expect(result.blockers).toEqual([]);
  });

  it("uses the project assessment JSON as the same pre-dispatch gate", () => {
    expect(
      parseArchitectureAssessment(
        0,
        '{"score":95,"findings":[],"suggestedBotImprovements":["target reached"]}',
        95,
      ),
    ).toMatchObject({ score: 95, targetScore: 95, decision: "skip" });
    expect(
      parseArchitectureAssessment(
        0,
        '{"score":72,"findings":[],"suggestedBotImprovements":["needs work"]}',
        95,
      ),
    ).toMatchObject({ score: 72, targetScore: 95, decision: "run" });
    expect(parseArchitectureAssessment(1, "assessment failed", 95)).toMatchObject({
      score: null,
      targetScore: 95,
      decision: "block",
    });
  });
});
