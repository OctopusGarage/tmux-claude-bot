export const meta = {
  name: "audit",
  description:
    "Adversarial whole-project audit aimed at THIS codebase's blind-spot bug classes (the ones coverage/lint/knip miss), with a refute-biased verify pass.",
  phases: [
    { title: "Find", detail: "one finder per bug-class dimension, in parallel" },
    { title: "Verify", detail: "adversarially refute each candidate as it lands" },
  ],
};

const scope = typeof args === "string" && args.trim() ? args.trim() : "the whole project";

const MAP = [
  "Project: a TypeScript chat-bot driving Claude Code in tmux.",
  "Layering: src/adapters/{telegram,lark} (thin per-channel I/O) -> src/core (protocol-agnostic logic) -> src/shared (leaf utils). The two adapters historically drift.",
  "State files live under appStateDir() (TCB_STATE_DIR ?? ~/.tmux-claude-bot) and .queue/: session_path_map.json, group_bindings.json, workspaces.json, reply_target_map.json, recent_projects.txt, .current_project, .instance.lock, .env.",
  "session_path_map.json is written by BOTH the bot and the claude-tmux helper.",
  "Existing gates: vitest+coverage, biome, knip, dependency-cruiser, Stryker (npm run mutation). They verify local/static/single-process properties only.",
].join("\n");

const FINDINGS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          file: { type: "string" },
          line: { type: "number" },
          summary: { type: "string" },
          failure_scenario: { type: "string" },
        },
        required: ["file", "summary", "failure_scenario"],
      },
    },
  },
  required: ["findings"],
};

const VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    verdict: { type: "string", enum: ["CONFIRMED", "PLAUSIBLE", "REFUTED"] },
    reason: { type: "string" },
    suggested_guard: { type: "string" },
  },
  required: ["verdict", "reason", "suggested_guard"],
};

// The dimensions are aimed at where THIS project actually breaks — the axes the
// static gates are blind to — plus general correctness and the duplication that
// breeds the drift class.
const DIMENSIONS = [
  {
    key: "env-startup",
    focus:
      "Real-environment & startup. A blank `KEY=` line (dotenv injects \"\") or a non-default install path (TCB_STATE_DIR) crashing or mis-resolving at boot. Config-schema fields that reject \"\" instead of falling back to a default. Anything that reads process.env / .env / a path at module-load time.",
  },
  {
    key: "adapter-drift",
    focus:
      "Cross-adapter drift. Logic present in BOTH src/adapters/telegram and src/adapters/lark that should behave identically but doesn't (hardcoded action lists, ack/dedup handling, command routing, reply surfaces). Anything an adapter hardcodes that core already derives.",
  },
  {
    key: "concurrency",
    focus:
      "Cross-process / concurrency. The single-instance lock, state-file read-modify-write races, two processes (bot + claude-tmux helper) touching the same file, debounce/queue timing windows.",
  },
  {
    key: "restart-persistence",
    focus:
      "Cross-restart persistence. State lost on restart that the behavior needs (or kept that shouldn't be); a persisted format that won't round-trip after a restart. Each persisted store should survive a restart for whatever depends on it.",
  },
  {
    key: "unasserted-deadcode",
    focus:
      "Executed-but-unasserted & contract illusions. Code that runs but whose effect nothing asserts; retry/fallback/guard branches that can never fire given the actual caller contract; comments that make a false or stale claim.",
  },
  {
    key: "correctness",
    focus:
      "General correctness. Inverted/wrong conditions, off-by-one, missing await, null/undefined on a reachable error or cold-cache path, falsy-zero treated as missing, unescaped regex metachars, wrong-variable copy-paste.",
  },
  {
    key: "duplication-cleanup",
    focus:
      "Reuse & simplification. Logic duplicated across adapters instead of extracted to core, dead code, derivable/redundant state, special cases layered on shared infra that should be generalized.",
  },
];

function finderPrompt(d) {
  return [
    `You are auditing ${scope} of a TypeScript chat-bot for ONE class of problem.`,
    "",
    MAP,
    "",
    `Your dimension: ${d.focus}`,
    "",
    "Read the relevant source with Grep/Read (focus on src/; consult tests/ only to judge whether something is actually covered/asserted). Report ONLY problems in this dimension that have a concrete, constructible failure scenario — never style nits. Be specific: exact file, line, and the input/timing/state that triggers it. Cap at the 8 most serious. If you find nothing real, return an empty findings array. Do NOT speculate beyond what the code shows.",
  ].join("\n");
}

function verifyPrompt(f) {
  return [
    "Adversarially verify this audit finding by reading the actual code. Try hard to REFUTE it.",
    "",
    `Finding: ${f.summary}`,
    `Location: ${f.file}${f.line ? `:${f.line}` : ""}`,
    `Claimed failure: ${f.failure_scenario}`,
    "",
    "Read the cited code AND its callers. Return exactly one verdict:",
    "- REFUTED if the code shows it can't happen (wrong claim, impossible path, already guarded, or pure style with no observable effect). Default to REFUTED when you cannot construct the failure.",
    "- CONFIRMED if you can construct the exact input/timing/state that triggers it.",
    "- PLAUSIBLE if it's a realistic but not-fully-constructible race / rare-path issue.",
    "In suggested_guard, name the CHEAPEST automation that would catch this class next time: a specific test (boundary/parity/restart/property), a dependency-cruiser or biome rule, a schema check, mutation testing, or a structural refactor (logic into core). Keep it one sentence.",
  ].join("\n");
}

// Pipeline (no barrier): each dimension's findings start verifying the moment
// that finder returns, so a slow finder never blocks the others' verification.
const perDimension = await pipeline(
  DIMENSIONS,
  (d) => agent(finderPrompt(d), { label: `find:${d.key}`, phase: "Find", schema: FINDINGS_SCHEMA }),
  (found, d) =>
    parallel(
      ((found && found.findings) || []).map((f) => () =>
        agent(verifyPrompt(f), { label: `verify:${d.key}`, phase: "Verify", schema: VERDICT_SCHEMA }).then(
          (v) => ({
            dimension: d.key,
            file: f.file,
            line: f.line,
            summary: f.summary,
            failure_scenario: f.failure_scenario,
            verdict: v.verdict,
            reason: v.reason,
            suggested_guard: v.suggested_guard,
          }),
        ),
      ),
    ),
);

const all = perDimension.flat().filter(Boolean);
const rank = { CONFIRMED: 0, PLAUSIBLE: 1, REFUTED: 2 };
const survived = all
  .filter((f) => f.verdict !== "REFUTED")
  .sort((a, b) => rank[a.verdict] - rank[b.verdict]);

log(
  `audit done: ${all.length} candidates -> ${survived.length} survived verification (${all.length - survived.length} refuted)`,
);

return {
  scope,
  candidates: all.length,
  confirmed: survived,
  refuted: all.length - survived.length,
};
