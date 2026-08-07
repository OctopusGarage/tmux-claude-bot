export type AutomationNotificationIntent = {
  level: "success" | "warning";
  title: string;
  sections: Array<{ kind: "summary" | "issues"; lines: string[] }>;
};

export function buildAutomationNotificationIntent(input: {
  title: string;
  status: "ok" | "attention";
  summary: string[];
  issues?: string[];
}): AutomationNotificationIntent {
  return {
    level: input.status === "attention" ? "warning" : "success",
    title: input.title,
    sections: [
      { kind: "summary", lines: input.summary },
      ...(input.issues === undefined || input.issues.length === 0
        ? []
        : [{ kind: "issues" as const, lines: input.issues }]),
    ],
  };
}
