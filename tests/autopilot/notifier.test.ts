import { describe, expect, it } from "vitest";
import { NotifierRegistry, renderNotice } from "../../src/core/autopilot/notifier.js";
import { en } from "../../src/core/i18n/catalog/en.js";

describe("NotifierRegistry + renderNotice", () => {
  it("broadcasts a structured notice to all pushers and isolates failures", async () => {
    const reg = new NotifierRegistry();
    const got: string[] = [];
    reg.register(async (n) => void got.push(`a:${n.kind}`));
    reg.register(async () => {
      throw new Error("boom");
    });
    reg.register(async (n) => void got.push(`b:${n.kind}`));
    await reg.broadcast({ kind: "keepaliveDone", session: "s1" });
    expect(got.sort()).toEqual(["a:keepaliveDone", "b:keepaliveDone"]);
  });

  it("renders every notice kind to localized text (all 10 union arms)", () => {
    const m = en;
    expect(renderNotice({ kind: "paused", session: "sX", reason: "boom" }, m)).toContain("boom");
    expect(renderNotice({ kind: "stopped", session: "sX", reason: "halt" }, m)).toContain("halt");
    expect(renderNotice({ kind: "usage", session: "sX", pct: 90 }, m)).toContain("90");
    expect(renderNotice({ kind: "maxIter", session: "sX" }, m)).toContain("sX");
    expect(renderNotice({ kind: "wallClock", session: "sX" }, m)).toContain("sX");
    expect(renderNotice({ kind: "awaitHuman", session: "sX", goalId: "g" }, m)).toContain("sX");
    expect(renderNotice({ kind: "complete", session: "sX", goalId: "gx" }, m)).toContain("gx");
    expect(renderNotice({ kind: "cycleComplete", session: "sX", rounds: 3 }, m)).toContain("3");
    expect(renderNotice({ kind: "keepaliveDone", session: "sX" }, m)).toContain("keep-alive");
    expect(
      renderNotice(
        { kind: "goalAdvance", session: "sX", goalId: "gy", pos: 1, total: 2, round: 1, rounds: 2 },
        m,
      ),
    ).toContain("gy");
  });

  it("renders the 3 new batch milestone notice kinds to non-empty text (en)", () => {
    const m = en;
    const started = renderNotice(
      { kind: "batchRunStarted", runId: "r1", planId: "plan-a", tasks: 5 },
      m,
    );
    expect(started.length).toBeGreaterThan(0);
    expect(started).toContain("plan-a");

    const paused = renderNotice(
      { kind: "batchPoolPaused", runId: "r1", agent: "claude", resumeAt: 9999 },
      m,
    );
    expect(paused.length).toBeGreaterThan(0);
    expect(paused).toContain("claude");

    const complete = renderNotice(
      { kind: "batchRunComplete", runId: "r1", summary: "Batch r1 done: 3 done, 0 failed" },
      m,
    );
    expect(complete.length).toBeGreaterThan(0);
    expect(complete).toContain("Batch r1 done");
  });
});
