import { statSync } from "node:fs";
import type { Goal } from "./types.js";
import { loadUserGoals, resolveGoalsDir } from "./user-goals.js";

// Built-in goal catalog. titleKey references an i18n Messages key added in a
// later task. Phase-1 conservative finalization applies; fuzzy goals use a
// human gate because there is no objective "done".
const GOALS: Goal[] = [
  {
    id: "test-coverage",
    titleKey: "goalTestCoverage",
    phases: [
      {
        id: "raise-coverage",
        intent: {
          kind: "prompt",
          text: "Detect this project's test and coverage tooling first (the test runner and how to produce a coverage report). Then continue raising test coverage: run the coverage report, add tests for the lowest-covered files, and re-run until coverage stops improving. Aim for roughly 80% line coverage as a target. When the target is met and tests pass, output the marker [GOAL_DONE].",
        },
        done: {
          kind: "all",
          of: [
            { kind: "sentinel", marker: "GOAL_DONE" },
            { kind: "detectCheck", purpose: "coverage" },
          ],
        },
      },
    ],
  },
  {
    id: "fix-tests",
    titleKey: "goalFixTests",
    phases: [
      {
        id: "make-green",
        intent: {
          kind: "prompt",
          text: "Detect this project's test command first. Then find and fix the failing tests: run the suite, diagnose each failure, fix the root cause, and re-run until all tests pass. When green, output the marker [GOAL_DONE].",
        },
        done: {
          kind: "all",
          of: [
            { kind: "sentinel", marker: "GOAL_DONE" },
            { kind: "detectCheck", purpose: "test" },
          ],
        },
      },
    ],
  },
  {
    id: "code-review",
    titleKey: "goalCodeReview",
    phases: [
      {
        id: "review",
        intent: {
          kind: "skill",
          name: "code-review",
          fallback:
            "Review the current diff for correctness bugs and quality issues; list findings.",
        },
        done: { kind: "sentinel", marker: "REVIEW_DONE" },
      },
      {
        id: "fix",
        intent: {
          kind: "prompt",
          text: "Fix the confirmed findings from the review. When done, output the marker [GOAL_DONE].",
        },
        done: {
          kind: "seq",
          of: [{ kind: "sentinel", marker: "GOAL_DONE" }, { kind: "humanGate" }],
        },
      },
    ],
  },
  {
    id: "add-feature",
    titleKey: "goalAddFeature",
    phases: [
      {
        id: "implement",
        intent: {
          kind: "prompt",
          text: "Continue implementing the requested feature, with tests, until complete. When you believe it is complete and tests pass, output the marker [GOAL_DONE].",
        },
        done: {
          kind: "seq",
          of: [{ kind: "sentinel", marker: "GOAL_DONE" }, { kind: "humanGate" }],
        },
      },
    ],
  },
  {
    id: "refactor-elegant",
    titleKey: "goalRefactorElegant",
    phases: [
      {
        id: "refactor",
        intent: {
          kind: "prompt",
          text: "Refactor the code under discussion to be clean, simple, and professional without changing behavior; keep tests green. When you believe it is done, output the marker [GOAL_DONE].",
        },
        done: {
          kind: "seq",
          of: [{ kind: "sentinel", marker: "GOAL_DONE" }, { kind: "humanGate" }],
        },
      },
    ],
  },
  {
    id: "ui-polish",
    titleKey: "goalUiPolish",
    phases: [
      {
        id: "polish",
        intent: {
          kind: "prompt",
          text: "Polish the UI under discussion (layout, spacing, copy, states) without breaking behavior. When you believe it is done, output the marker [GOAL_DONE].",
        },
        done: {
          kind: "seq",
          of: [{ kind: "sentinel", marker: "GOAL_DONE" }, { kind: "humanGate" }],
        },
      },
    ],
  },
];

let userCache: { dir: string; mtimeMs: number; goals: Goal[] } | null = null;
let lastStatMs = 0;
const STAT_DEBOUNCE_MS = 2000;

function userGoals(): Goal[] {
  const dir = resolveGoalsDir();
  // listGoals/getGoal run on every supervisor tick × session and every button tap;
  // skip the mtime statSync (the only per-call cost) within a short window — still
  // picks up a newly-added/edited user goal within ~2s, off the hot path.
  const nowMs = Date.now();
  if (userCache && userCache.dir === dir && nowMs - lastStatMs < STAT_DEBOUNCE_MS) {
    return userCache.goals;
  }
  lastStatMs = nowMs;
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(dir).mtimeMs;
  } catch {
    mtimeMs = 0;
  }
  if (userCache && userCache.dir === dir && userCache.mtimeMs === mtimeMs) return userCache.goals;
  const builtinIds = new Set(GOALS.map((g) => g.id));
  const goals = loadUserGoals(dir).filter((g) => !builtinIds.has(g.id));
  userCache = { dir, mtimeMs, goals };
  return goals;
}

export function listGoals(): Goal[] {
  return [...GOALS, ...userGoals()];
}

export function getGoal(id: string): Goal | undefined {
  return GOALS.find((g) => g.id === id) ?? userGoals().find((g) => g.id === id);
}
