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
          text: "First detect this project's test runner and how it produces a coverage report (prefer an existing coverage script if the project defines one) — but if you already analyzed coverage earlier in this goal, skip re-detection and continue from the next lowest-covered unit instead of starting over. Then work one file or module at a time, prioritizing business logic and error/branch paths over data access, utilities, and config: from the coverage report's uncovered-line detail take the lowest-covered unit, fully cover its branches and edge cases (null, empty, boundary inputs), re-run, then move on — don't re-test already-covered code or pad trivial getters. Match the existing test style, and make every test assert real behavior — never an assertion-free or over-mocked test that only proves the code runs. If a unit is genuinely untestable (external DB/network) or is dead/defensive code, note it instead of writing a meaningless test. Aim for roughly 80% line and 75% branch coverage, and re-run the coverage report until it stops improving. When the target is met and the suite passes, output the marker [GOAL_DONE].",
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
          text: "Detect this project's test command first; if you already diagnosed failures earlier in this goal, continue from the next one instead of restarting. Then find and fix the failing tests one at a time: run the suite, find a failure's root cause, fix that cause, and re-run. Never make a test pass by deleting, skipping, commenting out, or weakening its assertions — fix the underlying code or its setup. When the whole suite is green, output the marker [GOAL_DONE].",
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
          kind: "prompt",
          text: "Review the current diff/branch for correctness bugs and quality issues — use your code-review skill if one is available. List each confirmed finding with its file and a one-line description, then output the marker [REVIEW_DONE].",
        },
        done: { kind: "sentinel", marker: "REVIEW_DONE" },
      },
      {
        id: "fix",
        intent: {
          kind: "prompt",
          text: "Fix the confirmed findings from the review, one at a time; after each fix re-run the tests and keep the suite green. Don't introduce new issues or unrelated changes. When every confirmed finding is addressed, output the marker [FIX_DONE].",
        },
        done: { kind: "sentinel", marker: "FIX_DONE" },
      },
      {
        id: "simplify",
        intent: {
          kind: "prompt",
          text: "Now run a cleanup pass over the changes — use your simplify skill if one is available — improving reuse, simplification, efficiency, and altitude WITHOUT changing behavior; keep the test suite green. When the cleanup is complete, output the marker [GOAL_DONE].",
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
          text: "Continue implementing the requested feature with tests until complete; if you already started, resume from where you left off instead of restarting. Keep the test suite green as you go. When it is complete and all tests pass, output the marker [GOAL_DONE].",
        },
        done: {
          kind: "seq",
          of: [
            {
              kind: "all",
              of: [
                { kind: "sentinel", marker: "GOAL_DONE" },
                { kind: "detectCheck", purpose: "test" },
              ],
            },
            { kind: "humanGate" },
          ],
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
          text: "Refactor the code under discussion to be clean, simple, and professional WITHOUT changing its behavior or public API. The test suite must stay green — if a test fails, you changed behavior, so revert and take a smaller step. When done, output the marker [GOAL_DONE].",
        },
        done: {
          kind: "seq",
          of: [
            {
              kind: "all",
              of: [
                { kind: "sentinel", marker: "GOAL_DONE" },
                { kind: "detectCheck", purpose: "test" },
              ],
            },
            { kind: "humanGate" },
          ],
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
          text: "Polish the UI under discussion (layout, spacing, copy, states) without changing behavior or breaking existing tests. When done, output the marker [GOAL_DONE].",
        },
        done: {
          kind: "seq",
          of: [{ kind: "sentinel", marker: "GOAL_DONE" }, { kind: "humanGate" }],
        },
      },
    ],
  },
  {
    id: "improve-architecture",
    titleKey: "goalImproveArchitecture",
    phases: [
      {
        id: "audit",
        intent: {
          kind: "prompt",
          text: "Comprehensively review the whole project module by module — use your improve-codebase-architecture skill if one is available. Identify unreasonable designs, missing component extractions, and quality issues, plus any suspected hidden bugs. Write the findings to a markdown plan (one section per module; each item with a recommendation). When the audit is complete, output the marker [AUDIT_DONE].",
        },
        done: { kind: "sentinel", marker: "AUDIT_DONE" },
      },
      {
        id: "improve",
        intent: {
          kind: "prompt",
          text: "Work through the audit plan one module at a time. Refactor each module to be professional, elegant, clear, concise, maintainable, and extensible without changing behavior; keep the test suite green. For each suspected bug, first verify it is a real problem, then fix it with a test. For anything you deliberately leave unchanged, record the reason in the plan and a brief code comment so it isn't re-litigated later. Update the plan as you go. When every module is addressed, output the marker [GOAL_DONE].",
        },
        done: {
          kind: "seq",
          of: [
            {
              kind: "all",
              of: [
                { kind: "sentinel", marker: "GOAL_DONE" },
                { kind: "detectCheck", purpose: "test" },
              ],
            },
            { kind: "humanGate" },
          ],
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
