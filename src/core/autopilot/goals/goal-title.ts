import type { Messages } from "../../i18n/index.js";
import type { Goal } from "./types.js";

// Resolve a goal's localized title from its titleKey. Switch keeps it type-safe
// (dynamic msgs[key] indexing isn't typeable).
export function goalTitle(msgs: Messages, goal: Goal): string {
  switch (goal.titleKey) {
    case "goalTestCoverage":
      return msgs.goalTestCoverage;
    case "goalFixTests":
      return msgs.goalFixTests;
    case "goalCodeReview":
      return msgs.goalCodeReview;
    case "goalAddFeature":
      return msgs.goalAddFeature;
    case "goalRefactorElegant":
      return msgs.goalRefactorElegant;
    case "goalUiPolish":
      return msgs.goalUiPolish;
    default:
      return goal.titleKey;
  }
}
