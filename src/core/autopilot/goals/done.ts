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
export type DoneResult = {
  satisfied: boolean;
  pendingHumanGate: boolean;
  // A check whose result isn't in yet (in-flight). Not satisfied, but the goal
  // should WAIT for it rather than re-inject — distinct from a real failure.
  pendingCheck: boolean;
  seqIndex: number;
};

function currentSeqStep(of: DoneCondition[], seqIndex: number): DoneCondition | undefined {
  return of[Math.min(seqIndex, of.length - 1)];
}

async function one(
  cond: DoneCondition,
  ctx: DoneCtx,
): Promise<{ satisfied: boolean; pendingHumanGate: boolean; pendingCheck: boolean }> {
  switch (cond.kind) {
    case "sentinel":
      return {
        satisfied: ctx.sentinels.includes(cond.marker),
        pendingHumanGate: false,
        pendingCheck: false,
      };
    case "check": {
      const r = await ctx.runCheck(cond.cmd, ctx.cwd);
      return { satisfied: r.ok, pendingHumanGate: false, pendingCheck: r.pending ?? false };
    }
    case "detectCheck": {
      const cmd = detectCheckCommand(cond.purpose, ctx.cwd);
      // Undetectable project → fall back to a human gate. Mirror the humanGate
      // case (consult humanConfirmed) so a /autopilot confirm actually releases
      // it; a bare pendingHumanGate:true would re-notify every tick and never
      // be satisfied, trapping the goal in a confirm loop.
      if (cmd === null)
        return {
          satisfied: ctx.humanConfirmed,
          pendingHumanGate: !ctx.humanConfirmed,
          pendingCheck: false,
        };
      const r = await ctx.runCheck(cmd, ctx.cwd);
      return { satisfied: r.ok, pendingHumanGate: false, pendingCheck: r.pending ?? false };
    }
    case "humanGate":
      return {
        satisfied: ctx.humanConfirmed,
        pendingHumanGate: !ctx.humanConfirmed,
        pendingCheck: false,
      };
    case "all": {
      let pendingGate = false;
      let pendingChk = false;
      for (const sub of cond.of) {
        const r = await one(sub, ctx);
        if (r.pendingHumanGate) pendingGate = true;
        if (r.pendingCheck) pendingChk = true;
        if (!r.satisfied)
          return { satisfied: false, pendingHumanGate: pendingGate, pendingCheck: pendingChk };
      }
      return { satisfied: true, pendingHumanGate: false, pendingCheck: false };
    }
    case "seq": {
      const step = currentSeqStep(cond.of, ctx.seqIndex);
      if (step === undefined)
        return { satisfied: true, pendingHumanGate: false, pendingCheck: false };
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
    return {
      satisfied: true,
      pendingHumanGate: false,
      pendingCheck: false,
      seqIndex: ctx.seqIndex,
    };
  const r = await one(step, ctx);
  if (!r.satisfied)
    return {
      satisfied: false,
      pendingHumanGate: r.pendingHumanGate,
      pendingCheck: r.pendingCheck,
      seqIndex: ctx.seqIndex,
    };
  const next = ctx.seqIndex + 1;
  return {
    satisfied: next >= cond.of.length,
    pendingHumanGate: false,
    pendingCheck: false,
    seqIndex: next,
  };
}
