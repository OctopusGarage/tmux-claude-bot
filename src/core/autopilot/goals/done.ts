import type { CheckRunner } from "../check-runner.js";
import { detectCheckCommand } from "./detect-check.js";
import type { DoneCondition } from "./types.js";

export type DoneCtx = {
  sentinels: string[];
  runCheck: CheckRunner;
  cwd: string | undefined;
  humanConfirmed: boolean;
  seqIndex: number;
};
export type DoneResult = { satisfied: boolean; pendingHumanGate: boolean; seqIndex: number };

function currentSeqStep(of: DoneCondition[], seqIndex: number): DoneCondition | undefined {
  return of[Math.min(seqIndex, of.length - 1)];
}

async function one(
  cond: DoneCondition,
  ctx: DoneCtx,
): Promise<{ satisfied: boolean; pendingHumanGate: boolean }> {
  switch (cond.kind) {
    case "sentinel":
      return { satisfied: ctx.sentinels.includes(cond.marker), pendingHumanGate: false };
    case "check":
      return { satisfied: (await ctx.runCheck(cond.cmd, ctx.cwd)).ok, pendingHumanGate: false };
    case "detectCheck": {
      const cmd = detectCheckCommand(cond.purpose, ctx.cwd);
      if (cmd === null) return { satisfied: false, pendingHumanGate: true };
      return { satisfied: (await ctx.runCheck(cmd, ctx.cwd)).ok, pendingHumanGate: false };
    }
    case "humanGate":
      return { satisfied: ctx.humanConfirmed, pendingHumanGate: !ctx.humanConfirmed };
    case "all": {
      let pending = false;
      for (const sub of cond.of) {
        const r = await one(sub, ctx);
        if (r.pendingHumanGate) pending = true;
        if (!r.satisfied) return { satisfied: false, pendingHumanGate: pending };
      }
      return { satisfied: true, pendingHumanGate: false };
    }
    case "seq": {
      const step = currentSeqStep(cond.of, ctx.seqIndex);
      if (step === undefined) return { satisfied: true, pendingHumanGate: false };
      return one(step, ctx);
    }
  }
}

export async function evaluateDone(cond: DoneCondition, ctx: DoneCtx): Promise<DoneResult> {
  if (cond.kind !== "seq") {
    const r = await one(cond, ctx);
    return { ...r, seqIndex: ctx.seqIndex };
  }
  const step = currentSeqStep(cond.of, ctx.seqIndex);
  if (step === undefined)
    return { satisfied: true, pendingHumanGate: false, seqIndex: ctx.seqIndex };
  const r = await one(step, ctx);
  if (!r.satisfied)
    return { satisfied: false, pendingHumanGate: r.pendingHumanGate, seqIndex: ctx.seqIndex };
  const next = ctx.seqIndex + 1;
  return { satisfied: next >= cond.of.length, pendingHumanGate: false, seqIndex: next };
}
