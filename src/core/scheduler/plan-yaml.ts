import { parse, stringify } from "yaml";
import { z } from "zod";
import type { Plan } from "./types.js";

const agentSchema = z.enum(["claude", "codex"]);

const scheduleSchema = z.union([
  z.object({ kind: z.literal("now") }),
  z.object({ kind: z.literal("at"), at: z.number() }),
  z.object({ kind: z.literal("cron"), cron: z.string().min(1) }),
]);

const projectSchema = z.object({
  path: z.string().min(1),
  agent: agentSchema,
  goals: z.array(z.string().min(1)).min(1),
  rounds: z.number().int().positive().optional(),
  retries: z.number().int().nonnegative().optional(),
  priority: z.number().int().optional(),
});

// pools is Partial<Record<AgentKind, number>> — neither key is required.
// z.record(agentSchema, …) would infer { claude: number; codex: number } (both
// required), which conflicts with the Plan type.  Use a plain object schema
// with both keys optional, then cast via `as Plan`.
const planSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  pools: z
    .object({
      claude: z.number().int().positive().optional(),
      codex: z.number().int().positive().optional(),
    })
    .refine((p) => p.claude !== undefined || p.codex !== undefined, {
      message: "pools must define at least one agent",
    }),
  schedule: scheduleSchema.optional(),
  defaults: z
    .object({
      rounds: z.number().int().positive().optional(),
      retries: z.number().int().nonnegative().optional(),
    })
    .optional(),
  projects: z.array(projectSchema).min(1),
});

/** Parse + validate a YAML batch plan. Throws Error (precise message) on any failure. */
export function parsePlanYaml(text: string): Plan {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (e) {
    throw new Error(`invalid YAML: ${e instanceof Error ? e.message : String(e)}`);
  }
  const parsed = planSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `invalid plan: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  return parsed.data as Plan;
}

export function planToYaml(plan: Plan): string {
  return stringify(plan);
}
