import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { appStateDir } from "../../shared/state-dir.js";
import { writeFileAtomicSync } from "../../shared/utils/atomic-write.js";
import type { ProcessInstance } from "../resource-guardian/ownership.js";
import { parseResourceProcessPs, sameProcessInstance } from "../resource-guardian/ownership.js";
import type { LoopWorkOrder } from "./work-order-contract.js";

const schema = z.object({
  schemaVersion: z.literal(1),
  workOrderId: z.string(),
  workerSession: z.string().optional(),
  resourcePaths: z.array(z.string()).min(1),
  reason: z.string(),
  createdAt: z.number(),
  processes: z
    .array(
      z.object({
        pid: z.number().int().positive(),
        startedAt: z.string(),
        pgid: z.number().int().positive().optional(),
      }),
    )
    .default([]),
});
const canonicalPath = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};
const root = () => join(appStateDir(), "loop-execution-quarantines");
const file = (id: string) => join(root(), `${createHash("sha256").update(id).digest("hex")}.json`);

/** Separate from failure retention: uncertain subprocess ownership never expires. */
export function quarantineLoopExecution(
  workOrder: LoopWorkOrder,
  reason: string,
  processes: ProcessInstance[] = [],
): void {
  const previous = existsSync(file(workOrder.id))
    ? schema.parse(JSON.parse(readFileSync(file(workOrder.id), "utf8")))
    : undefined;
  const identities = new Map(
    [...(previous?.processes ?? []), ...processes].map((process) => [
      `${process.pid}:${process.startedAt}`,
      process,
    ]),
  );
  const record = {
    schemaVersion: 1,
    workOrderId: workOrder.id,
    workerSession: workOrder.workerSession,
    resourcePaths: [
      workOrder.projectPath,
      ...(workOrder.executionIsolation?.sourceWorktree === undefined
        ? []
        : [workOrder.executionIsolation.sourceWorktree]),
    ].map(canonicalPath),
    reason,
    processes: [...identities.values()],
    createdAt: previous?.createdAt ?? Date.now(),
  };
  mkdirSync(root(), { recursive: true });
  writeFileAtomicSync(file(workOrder.id), JSON.stringify(record));
}

export function listLoopExecutionQuarantines(): Array<z.infer<typeof schema>> {
  if (!existsSync(root())) return [];
  return readdirSync(root())
    .filter((name) => name.endsWith(".json"))
    .map((name) => schema.parse(JSON.parse(readFileSync(join(root(), name), "utf8"))));
}

export function loopExecutionPathQuarantined(path: string): boolean {
  try {
    return listLoopExecutionQuarantines().some((record) =>
      record.resourcePaths.includes(canonicalPath(path)),
    );
  } catch {
    return true;
  }
}

export function releaseLoopExecutionQuarantine(
  workOrderId: string,
  processesStopped: boolean,
): void {
  if (!processesStopped)
    throw new Error("Explicit confirmation that all external processes stopped is required");
  const record = schema.parse(JSON.parse(readFileSync(file(workOrderId), "utf8")));
  if (record.processes.length > 0) {
    const current = parseResourceProcessPs(
      execFileSync("ps", ["-axo", "pid=,ppid=,pgid=,lstart=,%cpu=,rss=,command="], {
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, LC_ALL: "C", LANG: "C" },
      }),
    );
    if (!current.some((entry) => entry.pid === process.pid))
      throw new Error("Unable to verify current process identities");
    if (
      record.processes.some((expected) =>
        current.some((process) =>
          sameProcessInstance(
            {
              pid: expected.pid,
              startedAt: expected.startedAt,
              ...(expected.pgid === undefined ? {} : { pgid: expected.pgid }),
            },
            process,
          ),
        ),
      )
    )
      throw new Error("Known external processes are still running; quarantine retained");
  }
  unlinkSync(file(workOrderId));
}

export function hasLoopExecutionQuarantine(workOrderId: string): boolean {
  return existsSync(file(workOrderId));
}

/** Internal executor-only release after a correlated terminal receipt and verified child stop. */
export function clearProvenLoopExecutionQuarantine(
  workOrderId: string,
  proof: { receiptValidated: true; knownProcessesStopped: true },
): void {
  if (!proof.receiptValidated || !proof.knownProcessesStopped)
    throw new Error("External lifecycle proof is required");
  unlinkSync(file(workOrderId));
}
