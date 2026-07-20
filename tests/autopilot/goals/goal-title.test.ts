import { describe, expect, it } from "vitest";
import { listGoals } from "../../../src/core/autopilot/goals/catalog.js";
import { goalTitle } from "../../../src/core/autopilot/goals/goal-title.js";
import { messages } from "../../../src/core/i18n/index.js";

describe("goalTitle", () => {
  // Guard: goalTitle is a switch over titleKey, so a new built-in goal that adds
  // its i18n key but forgets a switch case silently falls through to `default`
  // (returns the raw titleKey, shown verbatim in the autopilot panel). Iterate
  // every catalog goal so that gap fails CI instead of leaking a raw key.
  it("resolves a real localized title for every built-in goal (no raw titleKey leak)", () => {
    const msgs = messages("telegram");
    for (const g of listGoals()) {
      const title = goalTitle(msgs, g);
      expect(title, `${g.id} (${g.titleKey}) fell through to the raw key`).not.toBe(g.titleKey);
      expect(title.length).toBeGreaterThan(0);
    }
  });
});
