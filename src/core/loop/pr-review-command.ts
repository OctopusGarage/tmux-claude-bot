import { readFileSync, writeFileSync } from "node:fs";
import { parse, stringify } from "yaml";
import { tildeifyHomeDeep } from "../../shared/utils/path.js";
import { parseLoopConfigYaml, taskImplementationSchema } from "./config.js";
import type { LoopCommandResult } from "./loop-command.js";

/** Dedicated non-secret reviewer selection; scope and identity must be unambiguous. */
export function runPrReviewerCommand(input: {
  action: "get" | "set";
  file: string;
  scope: string;
  id: string;
  selection?: unknown;
}): LoopCommandResult {
  try {
    if (input.scope !== "project" && input.scope !== "repository") throw new Error("invalid scope");
    const text = readFileSync(input.file, "utf8");
    const config = parseLoopConfigYaml(text);
    const matches = (
      input.scope === "project" ? config.projects : config.prReview.repositories
    ).filter((entry) => entry.id === input.id);
    if (matches.length !== 1) throw new Error("review target must be unique");
    const target = matches[0];
    if (target === undefined) throw new Error("missing target");
    let reviewer = ("pullRequestReview" in target
      ? target.pullRequestReview.reviewer
      : target.reviewer) ?? { kind: "native" as const };
    if (input.action === "set") {
      reviewer = taskImplementationSchema.parse(input.selection);
      const doc = parse(text) as {
        projects?: Array<{ id: string; pullRequestReview?: Record<string, unknown> }>;
        prReview?: { repositories?: Array<{ id: string; reviewer?: unknown }> };
      };
      if (input.scope === "project") {
        const entries = doc.projects?.filter((entry) => entry.id === input.id) ?? [];
        const project = entries[0];
        if (entries.length !== 1 || project === undefined) throw new Error("ambiguous target");
        project.pullRequestReview = { ...project.pullRequestReview, reviewer };
      } else {
        const entries = doc.prReview?.repositories?.filter((entry) => entry.id === input.id) ?? [];
        const repository = entries[0];
        if (entries.length !== 1 || repository === undefined) throw new Error("ambiguous target");
        repository.reviewer = reviewer;
      }
      const next = stringify(doc);
      parseLoopConfigYaml(next);
      writeFileSync(input.file, next);
    }
    const safe =
      reviewer.kind === "native"
        ? reviewer
        : {
            ...reviewer,
            ...(reviewer.params === undefined
              ? {}
              : {
                  params: Object.fromEntries(
                    Object.keys(reviewer.params).map((key) => [key, "<redacted>"]),
                  ),
                }),
          };
    return {
      exitCode: 0,
      stdout: JSON.stringify(
        tildeifyHomeDeep({ scope: input.scope, id: input.id, reviewer: safe }),
      ),
    };
  } catch {
    return {
      exitCode: 1,
      stderr:
        "PR reviewer configuration rejected; check unique scope/id, supervised execution, and non-secret selection.",
    };
  }
}
