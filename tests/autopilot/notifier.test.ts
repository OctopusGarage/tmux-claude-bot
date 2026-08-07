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
    await reg.broadcast({ kind: "batchRunStarted", runId: "r1", planId: "p1", tasks: 2 });
    expect(got.sort()).toEqual(["a:batchRunStarted", "b:batchRunStarted"]);
  });

  it("renders the batch milestone notice kinds to non-empty text (en)", () => {
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
