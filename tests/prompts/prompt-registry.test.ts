import { describe, expect, it } from "vitest";
import { LOOP_TASK_SCHEDULER_JOB_KINDS } from "../../src/core/loop/task-family.js";
import {
  actionScopeAtMost,
  governedPromptById,
  governedPromptSpecs,
  governedPromptsForTaskKind,
} from "../../src/core/prompts/registry.js";

describe("governed prompt registry", () => {
  it("has unique stable ids", () => {
    const ids = governedPromptSpecs().map((prompt) => prompt.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it("catalogs every loop scheduler task kind", () => {
    for (const taskKind of LOOP_TASK_SCHEDULER_JOB_KINDS) {
      expect(governedPromptsForTaskKind(taskKind).map((prompt) => prompt.id)).not.toEqual([]);
    }
  });

  it("keeps read-only prompt categories read-only", () => {
    const readOnlyPromptIds = [
      "loop.policy.opportunity-discovery",
      "opportunity.discussion.single",
      "opportunity.discussion.batch",
      "workflow.audit.finder",
      "workflow.audit.verifier",
    ] as const;

    for (const id of readOnlyPromptIds) {
      expect(governedPromptById(id).actionScope).toBe("read-only");
    }
  });

  it("does not let automation governance review auto-merge", () => {
    const spec = governedPromptById("loop.policy.automation-governance-review");

    expect(actionScopeAtMost(spec.actionScope, "pr-create")).toBe(true);
  });

  it("marks legacy loop prompts explicitly", () => {
    const legacyPromptIds = governedPromptSpecs()
      .filter((prompt) => prompt.id.startsWith("legacy."))
      .map((prompt) => prompt.id);

    expect(legacyPromptIds.length).toBeGreaterThan(0);
    for (const id of legacyPromptIds) {
      expect(governedPromptById(id).legacy).toBe(true);
    }
  });
});
