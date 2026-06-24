import { z } from "zod";
import type { Goal } from "./types.js";

const intentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("prompt"), text: z.string().min(1) }),
  z.object({ kind: z.literal("skill"), name: z.string().min(1), fallback: z.string().min(1) }),
]);

const doneSchema: z.ZodType = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("sentinel"), marker: z.string().min(1) }),
    z.object({ kind: z.literal("check"), cmd: z.string().min(1) }),
    z.object({ kind: z.literal("detectCheck"), purpose: z.enum(["coverage", "test"]) }),
    z.object({ kind: z.literal("humanGate") }),
    z.object({ kind: z.literal("all"), of: z.array(doneSchema).min(1) }),
    z.object({ kind: z.literal("seq"), of: z.array(doneSchema).min(1) }),
  ]),
);

const goalSchema = z.object({
  id: z.string().min(1),
  titleKey: z.string().min(1),
  phases: z
    .array(
      z.object({
        id: z.string().min(1),
        intent: intentSchema,
        done: doneSchema,
        autonomy: z.enum(["conservative", "aggressive"]).optional(),
      }),
    )
    .min(1),
  budget: z
    .object({
      maxIterations: z.number().int().positive().optional(),
      maxWallClockMs: z.number().int().positive().optional(),
    })
    .optional(),
});

export function parseGoal(obj: unknown): { ok: true; goal: Goal } | { ok: false; error: string } {
  const r = goalSchema.safeParse(obj);
  if (r.success) return { ok: true, goal: r.data as Goal };
  return {
    ok: false,
    error: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
  };
}
