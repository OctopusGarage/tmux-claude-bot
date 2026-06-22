import type { Messages } from "../../i18n/index.js";
import { listGoals } from "./catalog.js";
import { goalTitle } from "./goal-title.js";

export function formatGoalsList(msgs: Messages): string {
  const lines = listGoals().map((g) => `• ${g.id} — ${goalTitle(msgs, g)}`);
  return `${msgs.goalsTitle}\n${lines.join("\n")}`;
}
