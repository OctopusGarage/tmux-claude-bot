import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerPrReviewCommands } from "../../src/cli/pr-review-commands.js";
import { parseLoopConfigYaml } from "../../src/core/loop/config.js";
import {
  readPrReviewWorkOrder,
  runRalphPrReviewPass,
} from "../../src/core/loop/ralph-pr-review.js";

vi.mock("../../src/core/loop/ralph-pr-review.js", () => ({
  readPrReviewWorkOrder: vi.fn(),
  runRalphPrReviewPass: vi.fn(),
}));
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
});
const program = () => {
  const cli = new Command();
  registerPrReviewCommands(cli.command("loop"));
  return cli;
};

describe("PR review CLI", () => {
  it("parses primitive reviewer params and redacts set/get output", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "tcb-pr-cli-")), "loop.yaml");
    writeFileSync(
      file,
      `prReview:
  repositories:
    - id: fixture
      name: Fixture
      path: /repo/fixture
      repo: example/fixture
      agent: codex
      schedule: "0 2 * * *"
`,
    );
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const cli = program();
    await cli.parseAsync(
      [
        "loop",
        "pr-review",
        "set",
        file,
        "repository",
        "fixture",
        "ralphworks",
        "--param",
        "strict=true",
        "--param",
        "limit=2",
        "--param",
        "focus=private-detail",
      ],
      { from: "user" },
    );
    expect(
      parseLoopConfigYaml(readFileSync(file, "utf8")).prReview.repositories[0]?.reviewer,
    ).toEqual({ kind: "ralphworks", params: { strict: true, limit: 2, focus: "private-detail" } });
    expect(output.mock.calls.flat().join("")).not.toContain("private-detail");
    await cli.parseAsync(["loop", "pr-review", "get", file, "repository", "fixture"], {
      from: "user",
    });
    expect(output.mock.calls.flat().join("")).toContain("<redacted>");
  });
  it("passes exact immutable candidate and caller timeout through the public pass boundary", async () => {
    const workOrder = { id: "review" } as ReturnType<typeof readPrReviewWorkOrder>;
    vi.mocked(readPrReviewWorkOrder).mockReturnValue(workOrder);
    vi.mocked(runRalphPrReviewPass).mockResolvedValue({ verdict: "clean" } as never);
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    await program().parseAsync(
      [
        "loop",
        "pr-review",
        "pass",
        "/tmp/work-order.json",
        "42",
        "--repository",
        "example/fixture",
        "--base",
        "a".repeat(40),
        "--head",
        "b".repeat(40),
        "--timeout-minutes",
        "2",
      ],
      { from: "user" },
    );
    expect(readPrReviewWorkOrder).toHaveBeenCalledWith("/tmp/work-order.json");
    expect(runRalphPrReviewPass).toHaveBeenCalledWith({
      workOrder,
      number: 42,
      repository: "example/fixture",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      timeoutMs: 120000,
      signal: expect.any(AbortSignal),
    });
    expect(output).toHaveBeenCalledWith(JSON.stringify({ verdict: "clean" }));
  });
  it.each(["findings", "incomplete"] as const)(
    "preserves %s JSON while exiting nonzero",
    async (verdict) => {
      vi.mocked(readPrReviewWorkOrder).mockReturnValue({ id: "review" } as ReturnType<
        typeof readPrReviewWorkOrder
      >);
      vi.mocked(runRalphPrReviewPass).mockResolvedValue({ verdict } as never);
      const output = vi.spyOn(console, "log").mockImplementation(() => {});
      await program().parseAsync(
        [
          "loop",
          "pr-review",
          "pass",
          "/tmp/order.json",
          "42",
          "--repository",
          "example/fixture",
          "--base",
          "a".repeat(40),
          "--head",
          "b".repeat(40),
        ],
        { from: "user" },
      );
      expect(output).toHaveBeenCalledWith(JSON.stringify({ verdict }));
      expect(process.exitCode).toBe(1);
    },
  );
  it.each(["0", "9007199254740992", "1.5", "NaN"])(
    "rejects invalid candidate %s without running external review",
    async (number) => {
      vi.mocked(runRalphPrReviewPass).mockClear();
      vi.spyOn(console, "error").mockImplementation(() => {});
      await program().parseAsync(
        [
          "loop",
          "pr-review",
          "pass",
          "/tmp/order.json",
          number,
          "--repository",
          "example/fixture",
          "--base",
          "a".repeat(40),
          "--head",
          "b".repeat(40),
        ],
        { from: "user" },
      );
      expect(runRalphPrReviewPass).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    },
  );
});
