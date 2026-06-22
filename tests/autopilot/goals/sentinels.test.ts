import { describe, expect, it } from "vitest";
import { extractSentinels } from "../../../src/core/autopilot/goals/sentinels.js";

describe("extractSentinels", () => {
  it("pulls bracketed uppercase markers, dedupes, ignores prose", () => {
    expect(extractSentinels("done. [GOAL_DONE] and [REVIEW_DONE] again [GOAL_DONE]")).toEqual([
      "GOAL_DONE",
      "REVIEW_DONE",
    ]);
    expect(extractSentinels("nothing here [lowercase] [A]")).toEqual([]); // too short / not uppercase
  });
});
