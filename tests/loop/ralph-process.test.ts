import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  mkdtempSync as createTempDirectory,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listLoopExecutionQuarantines,
  quarantineLoopExecution,
} from "../../src/core/loop/execution-quarantine.js";
import {
  RalphProcessOwnershipError,
  runRalphProcess as runRalphProcessProduction,
} from "../../src/core/loop/ralph-process.js";
import type { LoopWorkOrder } from "../../src/core/loop/work-order.js";
import * as ownership from "../../src/core/resource-guardian/ownership.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const originalStateDir = process.env.TCB_STATE_DIR;
const originalLogDir = process.env.TCB_LOG_DIR;
const fixtureRoots: string[] = [];
const fixtureProcesses = new Map<number, ownership.ProcessIdentity>();
function mkdtempSync(prefix: string): string {
  const root = createTempDirectory(prefix);
  fixtureRoots.push(root);
  return root;
}
const runRalphProcess: typeof runRalphProcessProduction = (input) =>
  runRalphProcessProduction({
    ...input,
    onOwnedProcesses: (processes) => {
      for (const process of processes) fixtureProcesses.set(process.pid, process);
      input.onOwnedProcesses?.(processes);
    },
  });
beforeEach(() => {
  fixtureProcesses.clear();
  vi.mocked(childProcess.spawn).mockClear();
  const root = mkdtempSync(join(tmpdir(), "tcb-ralph-process-state-"));
  process.env.TCB_STATE_DIR = join(root, "state");
  process.env.TCB_LOG_DIR = join(root, "logs");
});
afterEach(async () => {
  const actual = await vi.importActual<typeof childProcess>("node:child_process");
  const children = vi
    .mocked(childProcess.spawn)
    .mock.results.flatMap((result) =>
      result.type === "return" && result.value instanceof actual.ChildProcess
        ? [result.value as childProcess.ChildProcess]
        : [],
    );
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.mocked(childProcess.spawn).mockImplementation(actual.spawn);
  try {
    if (fixtureProcesses.size > 0) {
      const current = await ownership.createProcessIdentityProbe({})();
      for (const owned of fixtureProcesses.values()) {
        if (
          owned.pid === process.pid ||
          !current.processes.some(
            (entry) =>
              entry.pid === owned.pid &&
              entry.startedAt === owned.startedAt &&
              entry.pgid === owned.pgid,
          )
        )
          continue;
        try {
          process.kill(owned.pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
    }
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      child.kill("SIGKILL");
      await Promise.race([
        new Promise<void>((resolve) => child.once("close", () => resolve())),
        delay(1000),
      ]);
      if (child.exitCode === null && child.signalCode === null)
        throw new Error("Owned fixture child did not stop; temporary roots retained");
    }
    for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  } finally {
    if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
    else process.env.TCB_STATE_DIR = originalStateDir;
    if (originalLogDir === undefined) delete process.env.TCB_LOG_DIR;
    else process.env.TCB_LOG_DIR = originalLogDir;
  }
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function mockProbeTimeouts(
  outcomes: Array<"success" | "timeout">,
  fields: Record<string, unknown> = {},
  elapsedMs = 5001,
  ownedTimeout = true,
) {
  const actualProbe = ownership.createProcessIdentityProbe({});
  let clock = 0;
  let calls = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  const probe = vi.fn(async () => {
    const outcome = outcomes[calls++];
    if (outcome === "timeout") {
      clock += elapsedMs;
      throw ownedTimeout
        ? Object.assign(new ownership.ResourceProcessProbeTimeoutError(true, "SIGTERM"), fields)
        : Object.assign(new Error("injected ps timeout"), {
            code: null,
            killed: true,
            signal: "SIGTERM",
            ...fields,
          });
    }
    return actualProbe();
  });
  vi.spyOn(ownership, "createProcessIdentityProbe").mockReturnValue(probe);
  return {
    probe,
    advance: () => {
      clock += 5001;
    },
  };
}

function boundedFixture(
  onOwnedProcesses?: Parameters<typeof runRalphProcess>[0]["onOwnedProcesses"],
) {
  return {
    executable: process.execPath,
    args: ["-e", "setTimeout(()=>{},350)"],
    cwd: mkdtempSync(join(tmpdir(), "tcb-ralph-monitor-timeout-")),
    timeoutMs: 2000,
    signal: new AbortController().signal,
    ...(onOwnedProcesses === undefined ? {} : { onOwnedProcesses }),
  };
}

function retryWarnings(): number {
  const dir = process.env.TCB_LOG_DIR;
  if (dir === undefined || !existsSync(dir)) return 0;
  const logs = readdirSync(dir)
    .map((name) => readFileSync(join(dir, name), "utf8"))
    .join("\n");
  return logs.match(/RalphWorks ownership probe timed out; retrying once/g)?.length ?? 0;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function crossingCloseFixture(closeBeforePending = false, exitStatus = 0) {
  const root = mkdtempSync(join(tmpdir(), "tcb-crossing-close-"));
  const exitFile = join(root, "exit");
  const originalSpawn = (await vi.importActual<typeof childProcess>("node:child_process")).spawn;
  let child: childProcess.ChildProcess | undefined;
  const closed = deferred<void>();
  vi.mocked(childProcess.spawn).mockImplementation(
    (...args: Parameters<typeof childProcess.spawn>) => {
      child = originalSpawn(...args);
      child.once("close", () => closed.resolve());
      return child;
    },
  );
  const pending =
    deferred<Awaited<ReturnType<ReturnType<typeof ownership.createProcessIdentityProbe>>>>();
  const entered = deferred<void>();
  let active = 0;
  let maximumActive = 0;
  let calls = 0;
  const probe = vi.fn(async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    try {
      calls += 1;
      if (calls === 2) {
        entered.resolve();
        return await pending.promise;
      }
      return {
        capturedAt: Date.now(),
        thermal: "unknown" as const,
        processes:
          calls === 1 && child?.pid !== undefined
            ? [
                {
                  pid: child.pid,
                  ppid: process.pid,
                  pgid: child.pid,
                  startedAt: "fixture-start",
                  cpuPct: 0,
                  rssKb: 0,
                  command: "owned-node-fixture",
                },
              ]
            : [],
      };
    } finally {
      active -= 1;
    }
  });
  vi.spyOn(ownership, "createProcessIdentityProbe").mockReturnValue(probe);
  const persist = vi.fn();
  const controller = new AbortController();
  const result = runRalphProcess({
    executable: process.execPath,
    args: [
      "-e",
      `const fs=require('node:fs');setInterval(()=>{if(fs.existsSync(process.argv[1]))process.exit(${exitStatus})},5);setTimeout(()=>process.exit(2),1500)`,
      exitFile,
    ],
    cwd: root,
    timeoutMs: 2000,
    signal: controller.signal,
    onOwnedProcesses: persist,
  });
  const observed = result.then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error }),
  );
  if (!closeBeforePending) await entered.promise;
  writeFileSync(exitFile, "exit");
  await closed.promise;
  await entered.promise;
  return {
    result: observed,
    rejectPending: (error: Error) => pending.reject(error),
    resolvePending: () => pending.resolve({ processes: [] }),
    probe,
    persist,
    controller,
    maxActive: () => maximumActive,
  };
}

describe("RalphWorks process ownership", () => {
  it.each([false, true])(
    "refreshes a successful root table crossing close when previously owned=%s",
    async (previouslyOwned) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const child = Object.assign(new EventEmitter(), {
        pid: 987654321,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn(() => true),
      });
      vi.mocked(childProcess.spawn).mockReturnValue(child as unknown as childProcess.ChildProcess);
      const identity = { pid: child.pid, ppid: 1, pgid: child.pid, startedAt: "original" };
      const stale = deferred<{ processes: ownership.ProcessIdentity[] }>();
      const fresh = deferred<{ processes: ownership.ProcessIdentity[] }>();
      const entered = deferred<void>();
      const persisted = deferred<void>();
      const persist = vi.fn(() => persisted.resolve());
      const probe = vi.fn();
      if (previouslyOwned) probe.mockResolvedValueOnce({ processes: [identity] });
      probe
        .mockImplementationOnce(() => {
          entered.resolve();
          return stale.promise;
        })
        .mockImplementationOnce(() => fresh.promise)
        .mockResolvedValue({ processes: [] });
      vi.spyOn(ownership, "createProcessIdentityProbe").mockReturnValue(probe);
      let settled = false;
      const result = runRalphProcess({ ...boundedFixture(persist), timeoutMs: 10000 }).then(
        (value) => {
          settled = true;
          return { value, error: undefined };
        },
        (error: unknown) => {
          settled = true;
          return { value: undefined, error };
        },
      );
      try {
        if (previouslyOwned) {
          await persisted.promise;
          await vi.advanceTimersByTimeAsync(100);
        }
        await entered.promise;
        child.emit("exit", 0);
        child.emit("close", 0);
        stale.resolve({ processes: [identity] });
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).toBe(false);
        fresh.resolve({ processes: [] });
        const outcome = await result;
        expect(outcome.error).toBeUndefined();
        expect(outcome.value).toMatchObject({ status: 0 });
        expect(probe).toHaveBeenCalledTimes(previouslyOwned ? 3 : 2);
        expect(persist).toHaveBeenCalledTimes(previouslyOwned ? 1 : 0);
        expect(child.kill).not.toHaveBeenCalled();
      } finally {
        stale.resolve({ processes: [] });
        fresh.resolve({ processes: [] });
        await vi.advanceTimersByTimeAsync(3500);
        await result;
      }
    },
  );

  it("invalidates exit and close crossings separately without overlapping probes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const child = Object.assign(new EventEmitter(), {
      pid: 987654321,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => true),
    });
    vi.mocked(childProcess.spawn).mockReturnValue(child as unknown as childProcess.ChildProcess);
    const first = deferred<{ processes: ownership.ProcessIdentity[] }>();
    const second = deferred<{ processes: ownership.ProcessIdentity[] }>();
    const third = deferred<{ processes: ownership.ProcessIdentity[] }>();
    const tables = [first, second, third];
    let active = 0,
      maximum = 0,
      calls = 0,
      closed = false;
    const probe = vi.fn(async () => {
      active++;
      maximum = Math.max(maximum, active);
      try {
        const table = tables[calls++];
        if (table === undefined) throw new Error("unexpected extra probe");
        return await table.promise;
      } finally {
        active--;
      }
    });
    vi.spyOn(ownership, "createProcessIdentityProbe").mockReturnValue(probe);
    const persist = vi.fn();
    const result = runRalphProcess({ ...boundedFixture(persist), timeoutMs: 10000 }).then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );
    try {
      child.emit("exit", 0);
      first.resolve({
        processes: [{ pid: child.pid, ppid: 1, pgid: child.pid, startedAt: "old" }],
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(probe).toHaveBeenCalledTimes(2);
      child.emit("close", 0);
      closed = true;
      second.resolve({ processes: [] });
      await vi.advanceTimersByTimeAsync(0);
      expect(probe).toHaveBeenCalledTimes(3);
      third.resolve({ processes: [] });
      expect((await result).error).toBeUndefined();
      expect(maximum).toBe(1);
      expect(persist).not.toHaveBeenCalled();
    } finally {
      if (!closed) child.emit("close", 0);
      for (const table of tables) table.resolve({ processes: [] });
      await vi.advanceTimersByTimeAsync(3500);
      await result;
    }
  });

  it("keeps a fresh post-close reused group uncertain after discarding the stale original root", async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 987654321,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => true),
    });
    vi.mocked(childProcess.spawn).mockReturnValue(child as unknown as childProcess.ChildProcess);
    const stale = deferred<{ processes: ownership.ProcessIdentity[] }>();
    const identity = { pid: child.pid, ppid: 1, pgid: child.pid, startedAt: "original" };
    const probe = vi
      .fn()
      .mockImplementationOnce(() => stale.promise)
      .mockResolvedValue({ processes: [{ ...identity, startedAt: "replacement" }] });
    vi.spyOn(ownership, "createProcessIdentityProbe").mockReturnValue(probe);
    const signal = vi.spyOn(process, "kill").mockReturnValue(true);
    const persist = vi.fn();
    const result = runRalphProcess(boundedFixture(persist)).catch((error: unknown) => error);
    child.emit("exit", 0);
    child.emit("close", 0);
    stale.resolve({ processes: [identity] });
    expect(await result).toBeInstanceOf(RalphProcessOwnershipError);
    expect(persist).not.toHaveBeenCalled();
    expect(signal).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("finishes a real fast CLI after a captured root table arrives behind its close event", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tcb-fast-cli-close-"));
    const exitFile = join(dir, "exit");
    const actualSpawn = (await vi.importActual<typeof childProcess>("node:child_process")).spawn;
    const actualProbe = ownership.createProcessIdentityProbe({});
    const closed = deferred<void>();
    let child: childProcess.ChildProcess | undefined,
      calls = 0;
    vi.mocked(childProcess.spawn).mockImplementation(
      (...args: Parameters<typeof childProcess.spawn>) => {
        child = actualSpawn(...args);
        child.once("close", () => closed.resolve());
        return child;
      },
    );
    vi.spyOn(ownership, "createProcessIdentityProbe").mockReturnValue(async () => {
      const table = await actualProbe();
      if (++calls === 1) {
        expect(table.processes.some((entry) => entry.pid === child?.pid)).toBe(true);
        writeFileSync(exitFile, "exit");
        await closed.promise;
      }
      return table;
    });
    const persist = vi.fn();
    const result = runRalphProcess({
      executable: process.execPath,
      args: [
        "-e",
        `setInterval(()=>{if(require('node:fs').existsSync(process.argv[1]))process.exit(0)},1)`,
        exitFile,
      ],
      cwd: dir,
      signal: new AbortController().signal,
      timeoutMs: 5000,
      onOwnedProcesses: persist,
    }).then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );
    try {
      const outcome = await result;
      expect(outcome.error).toBeUndefined();
      expect(outcome.value).toMatchObject({ status: 0 });
      expect(persist).not.toHaveBeenCalled();
      expect(calls).toBe(2);
    } finally {
      child?.kill("SIGKILL");
      await result;
    }
  });

  it("captures an ordinary child born between polls before terminating its shell-like root", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const dir = mkdtempSync(join(tmpdir(), "tcb-between-polls-"));
    const ready = join(dir, "ready");
    const trigger = join(dir, "spawn");
    const ids = join(dir, "child.pid");
    const actualSpawn = (await vi.importActual<typeof childProcess>("node:child_process")).spawn;
    const actualProbe = ownership.createProcessIdentityProbe({});
    const observed = new Set<number>();
    let root: childProcess.ChildProcess | undefined;
    let descendant: ownership.ProcessIdentity | undefined;
    let childPersistedBeforeTerm = false;
    vi.mocked(childProcess.spawn).mockImplementation(
      (...args: Parameters<typeof childProcess.spawn>) => {
        root = actualSpawn(...args);
        const kill = root.kill.bind(root);
        vi.spyOn(root, "kill").mockImplementation((signal) => {
          if (signal === "SIGTERM")
            childPersistedBeforeTerm = descendant !== undefined && observed.has(descendant.pid);
          return kill(signal);
        });
        return root;
      },
    );
    const controller = new AbortController();
    const result = runRalphProcess({
      executable: process.execPath,
      args: [
        "-e",
        `const fs=require('node:fs'),cp=require('node:child_process');fs.writeFileSync(${JSON.stringify(ready)},'ready');const poll=setInterval(()=>{if(fs.existsSync(${JSON.stringify(trigger)})){clearInterval(poll);const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(ids)},String(child.pid));}},5);setInterval(()=>{},1000);`,
      ],
      cwd: dir,
      timeoutMs: 10000,
      signal: controller.signal,
      onOwnedProcesses: (processes) => {
        for (const entry of processes) observed.add(entry.pid);
      },
    }).then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );
    try {
      const deadline = Date.now() + 3000;
      while (
        (!existsSync(ready) || root?.pid === undefined || !observed.has(root.pid)) &&
        Date.now() < deadline
      )
        await delay(10);
      expect(existsSync(ready)).toBe(true);
      expect(root?.pid !== undefined && observed.has(root.pid)).toBe(true);
      writeFileSync(trigger, "spawn");
      while (!existsSync(ids) && Date.now() < deadline) await delay(10);
      const pid = Number(readFileSync(ids, "utf8"));
      descendant = (await actualProbe()).processes.find((entry) => entry.pid === pid);
      expect(descendant).toMatchObject({ ppid: root?.pid, pgid: root?.pid });
      expect(observed.has(pid)).toBe(false);
      controller.abort();
      const outcome = await Promise.race([
        result,
        delay(4000).then(() => {
          throw new Error("fixture stop did not settle");
        }),
      ]);
      expect(outcome.error).toBeUndefined();
      expect(outcome.value?.stopped).toEqual({ reason: "cancelled", knownProcessesStopped: true });
      expect(alive(pid)).toBe(false);
      expect(childPersistedBeforeTerm).toBe(true);
    } finally {
      controller.abort();
      root?.kill("SIGKILL");
      if (descendant !== undefined) {
        const current = (await actualProbe()).processes.find(
          (entry) => entry.pid === descendant?.pid,
        );
        if (current !== undefined && ownership.sameProcessInstance(descendant, current))
          process.kill(current.pid, "SIGKILL");
      }
      await vi.advanceTimersByTimeAsync(3500);
      await result;
    }
  });

  it.each(["timer", "late-census", "missing-root"] as const)(
    "retains uncertainty when the pre-stop census loses the %s boundary",
    async (boundary) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const child = Object.assign(new EventEmitter(), {
        pid: 987654321,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn(() => {
          queueMicrotask(() => {
            child.emit("exit", 0);
            child.emit("close", 0);
          });
          return true;
        }),
      });
      vi.mocked(childProcess.spawn).mockReturnValue(child as unknown as childProcess.ChildProcess);
      const pending = deferred<{ processes: ownership.ProcessIdentity[] }>();
      const probe = vi
        .fn()
        .mockResolvedValueOnce({
          processes: [{ pid: child.pid, ppid: 1, pgid: child.pid, startedAt: "original" }],
        })
        .mockImplementationOnce(() => pending.promise)
        .mockResolvedValue({ processes: [] });
      vi.spyOn(ownership, "createProcessIdentityProbe").mockReturnValue(probe);
      const controller = new AbortController();
      const persisted = deferred<void>();
      const result = runRalphProcess({
        ...boundedFixture(() => persisted.resolve()),
        timeoutMs: 10000,
        signal: controller.signal,
      }).then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      );
      try {
        await persisted.promise;
        await vi.advanceTimersByTimeAsync(0);
        controller.abort();
        if (boundary === "timer") await vi.advanceTimersByTimeAsync(250);
        else if (boundary === "late-census")
          vi.spyOn(Date, "now").mockReturnValue(Date.now() + 251);
        pending.resolve({ processes: [] });
        const outcome = await result;
        expect(outcome.value).toBeUndefined();
        expect(outcome.error).toBeInstanceOf(RalphProcessOwnershipError);
        expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
        // The post-TERM table crosses close and requires one fresh proof read.
        expect(probe).toHaveBeenCalledTimes(4);
      } finally {
        pending.resolve({ processes: [] });
        child.emit("close", 0);
        await vi.advanceTimersByTimeAsync(3500);
        await result;
      }
    },
  );

  it("quarantines an unknown same-group survivor without treating its PGID as signal authority", async () => {
    let live = true;
    const child = Object.assign(new EventEmitter(), {
      pid: 987654321,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => {
        live = false;
        queueMicrotask(() => {
          child.emit("exit", 0);
          child.emit("close", 0);
        });
        return true;
      }),
    });
    vi.mocked(childProcess.spawn).mockReturnValue(child as unknown as childProcess.ChildProcess);
    const signal = vi.spyOn(process, "kill").mockReturnValue(true);
    const root = { pid: child.pid, ppid: 1, pgid: child.pid, startedAt: "root" };
    const unknown = {
      pid: child.pid + 1,
      ppid: 1,
      pgid: child.pid,
      startedAt: "unobserved-or-recycled",
    };
    vi.spyOn(ownership, "createProcessIdentityProbe").mockReturnValue(async () => ({
      processes: live ? [root] : [unknown],
    }));
    const persisted = deferred<void>();
    const persist = vi.fn(() => persisted.resolve());
    const controller = new AbortController();
    const result = runRalphProcess({ ...boundedFixture(persist), signal: controller.signal }).then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );
    await persisted.promise;
    await delay(0);
    controller.abort();
    const outcome = await result;
    expect(outcome.value).toBeUndefined();
    expect(outcome.error).toBeInstanceOf(RalphProcessOwnershipError);
    expect(persist).toHaveBeenCalledExactlyOnceWith([root]);
    expect(signal).not.toHaveBeenCalled();
  });

  it("retains the first cleanup probe error when root exit cannot close inherited pipes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const child = Object.assign(new EventEmitter(), {
      pid: 987654321,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => {
        queueMicrotask(() => child.emit("exit", 0));
        return true;
      }),
    });
    vi.mocked(childProcess.spawn).mockReturnValue(child as unknown as childProcess.ChildProcess);
    const probe = vi
      .fn()
      .mockResolvedValueOnce({
        processes: [{ pid: child.pid, ppid: 1, pgid: child.pid, startedAt: "original" }],
      })
      .mockRejectedValue(Object.assign(new Error("cleanup probe failed"), { code: "EAGAIN" }));
    vi.spyOn(ownership, "createProcessIdentityProbe").mockReturnValue(probe);
    const persisted = deferred<void>();
    const controller = new AbortController();
    const result = runRalphProcess({
      ...boundedFixture(() => persisted.resolve()),
      timeoutMs: 20000,
      signal: controller.signal,
    }).then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );
    try {
      await persisted.promise;
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      await vi.advanceTimersByTimeAsync(3250);
      const outcome = await result;
      expect(outcome.value).toBeUndefined();
      expect(outcome.error).toMatchObject({
        diagnostic: { stage: "process-probe", code: "EAGAIN" },
      });
      expect(probe).toHaveBeenCalledTimes(2);
      expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    } finally {
      child.emit("close", 0);
      await result;
    }
  });

  it("rejects stop proof after its absolute budget even before the deadline timer runs", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = await crossingCloseFixture(true);
    f.controller.abort();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 4000);
    f.resolvePending();
    const outcome = await f.result;
    expect(outcome.value).toBeUndefined();
    expect(outcome.error).toBeInstanceOf(RalphProcessOwnershipError);
  });

  it("does not adopt a recycled root PID after exit while inherited pipes delay close", async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 987654321,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => true),
    });
    vi.mocked(childProcess.spawn).mockReturnValue(child as unknown as childProcess.ChildProcess);
    const pending =
      deferred<Awaited<ReturnType<ReturnType<typeof ownership.createProcessIdentityProbe>>>>();
    const probe = vi
      .fn()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValue({ processes: [] });
    vi.spyOn(ownership, "createProcessIdentityProbe").mockReturnValue(probe);
    const persist = vi.fn();
    const result = runRalphProcess(boundedFixture(persist));
    child.emit("exit", 0);
    pending.resolve({
      processes: [
        { pid: child.pid, ppid: 1, pgid: child.pid, startedAt: "replacement-root" },
        { pid: child.pid + 1, ppid: child.pid, pgid: child.pid + 1, startedAt: "foreign-child" },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(persist).not.toHaveBeenCalled();
    child.emit("close", 0);
    await expect(result).resolves.toMatchObject({ status: 0 });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it.each(["startedAt", "pgid"] as const)(
    "never signals a recorded descendant after its %s changes",
    async (field) => {
      let rootAlive = true;
      const child = Object.assign(new EventEmitter(), {
        pid: 987654321,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn(() => {
          rootAlive = false;
          queueMicrotask(() => {
            child.emit("exit", 0);
            child.emit("close", 0);
          });
          return true;
        }),
      });
      vi.mocked(childProcess.spawn).mockReturnValue(child as unknown as childProcess.ChildProcess);
      const signal = vi.spyOn(process, "kill").mockReturnValue(true);
      const root = { pid: child.pid, ppid: 1, pgid: child.pid, startedAt: "root" };
      const descendant = {
        pid: child.pid + 1,
        ppid: child.pid,
        pgid: child.pid + 1,
        startedAt: "original",
      };
      const replacement = {
        ...descendant,
        [field]: field === "pgid" ? descendant.pgid + 1 : "replacement",
      };
      const probe = vi
        .fn()
        .mockResolvedValueOnce({ processes: [root, descendant] })
        .mockImplementation(async () => ({
          processes: rootAlive ? [root, replacement] : [replacement],
        }));
      vi.spyOn(ownership, "createProcessIdentityProbe").mockReturnValue(probe);
      const persisted = deferred<void>();
      const controller = new AbortController();
      const result = runRalphProcess({
        ...boundedFixture(() => persisted.resolve()),
        signal: controller.signal,
      });
      await persisted.promise;
      controller.abort();
      await expect(result).resolves.toMatchObject({
        stopped: { reason: "cancelled", knownProcessesStopped: true },
      });
      expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
      expect(signal).not.toHaveBeenCalled();
    },
  );

  it.each(["cancelled", "timed_out"] as const)(
    "bounds %s cleanup while its only identity probe remains pending",
    async (reason) => {
      const dir = mkdtempSync(join(tmpdir(), "tcb-pending-stop-"));
      const ready = join(dir, "ready");
      const term = join(dir, "term");
      const actualSpawn = (await vi.importActual<typeof childProcess>("node:child_process")).spawn;
      let root: childProcess.ChildProcess | undefined;
      vi.mocked(childProcess.spawn).mockImplementation(
        (...args: Parameters<typeof childProcess.spawn>) => {
          root = actualSpawn(...args);
          return root;
        },
      );
      const pending =
        deferred<Awaited<ReturnType<ReturnType<typeof ownership.createProcessIdentityProbe>>>>();
      const probe = vi.fn(() => pending.promise);
      vi.spyOn(ownership, "createProcessIdentityProbe").mockReturnValue(probe);
      const persist = vi.fn();
      const controller = new AbortController();
      const started = Date.now();
      const result = runRalphProcess({
        executable: process.execPath,
        args: [
          "-e",
          `const fs=require('node:fs');process.on('SIGTERM',()=>fs.writeFileSync(${JSON.stringify(term)},'term'));fs.writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000)`,
        ],
        cwd: dir,
        timeoutMs: reason === "timed_out" ? 300 : 10000,
        signal: controller.signal,
        onOwnedProcesses: persist,
      }).then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      );
      try {
        while (!existsSync(ready) && Date.now() < started + 2000)
          await new Promise((resolve) => setTimeout(resolve, 10));
        expect(existsSync(ready)).toBe(true);
        if (reason === "cancelled") controller.abort();
        const termDeadline = Date.now() + 700;
        while (!existsSync(term) && Date.now() < termDeadline)
          await new Promise((resolve) => setTimeout(resolve, 10));
        expect(existsSync(term)).toBe(true);
        const outcome = await Promise.race([
          result,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("stop exceeded bound")), 4000),
          ),
        ]);
        expect(outcome.value).toBeUndefined();
        expect(outcome.error).toBeInstanceOf(RalphProcessOwnershipError);
        expect(root?.pid === undefined || alive(root.pid)).toBe(false);
        expect(probe).toHaveBeenCalledOnce();
        expect(persist).not.toHaveBeenCalled();
        pending.resolve({
          processes:
            root?.pid === undefined
              ? []
              : [{ pid: root.pid, ppid: process.pid, pgid: root.pid, startedAt: "late" }],
        });
        await new Promise((resolve) => setTimeout(resolve, 120));
        expect(probe).toHaveBeenCalledOnce();
        expect(persist).not.toHaveBeenCalled();
      } finally {
        pending.resolve({ processes: [] });
        controller.abort();
        root?.kill("SIGKILL");
        await result;
      }
    },
  );

  it("lets the owned CLI finish detached-child escalation after probe failure without claiming stop proof", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tcb-failed-probe-detached-"));
    const ids = join(dir, "pids.json");
    const ready = join(dir, "ready");
    const term = join(dir, "term");
    const drained = join(dir, "drained");
    const detached = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000)`;
    const rootScript = `
      const fs=require('node:fs');
      const worker=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(detached)}],{detached:true,stdio:'ignore'});
      fs.writeFileSync(${JSON.stringify(ids)},JSON.stringify([process.pid,worker.pid]));
      process.once('SIGTERM',()=>{
        fs.writeFileSync(${JSON.stringify(term)},String(Date.now()));
        worker.kill('SIGTERM');
        setTimeout(()=>worker.kill('SIGKILL'),1000);
        worker.once('close',()=>{fs.writeFileSync(${JSON.stringify(drained)},'drained');process.exit(0)});
      });
      setInterval(()=>{},1000);
    `;
    const actualProbe = ownership.createProcessIdentityProbe({});
    const order = {
      id: "failed-probe-fixture",
      projectId: "fixture",
      projectPath: dir,
    } as LoopWorkOrder;
    quarantineLoopExecution(order, "fixture active");
    let inject = false;
    let failures = 0;
    vi.spyOn(ownership, "createProcessIdentityProbe").mockReturnValue(async () => {
      if (inject)
        throw Object.assign(new Error("probe unavailable"), {
          code: ++failures === 1 ? "EAGAIN" : "EACCES",
        });
      return actualProbe();
    });
    const controller = new AbortController();
    const observed = new Set<number>();
    const result = runRalphProcess({
      executable: process.execPath,
      args: ["-e", rootScript],
      cwd: dir,
      timeoutMs: 10000,
      signal: controller.signal,
      onOwnedProcesses: (processes) => {
        for (const entry of processes) observed.add(entry.pid);
        quarantineLoopExecution(order, "fixture active", processes);
      },
    }).then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );
    let pids: number[] = [];
    try {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        if (existsSync(ids)) pids = JSON.parse(readFileSync(ids, "utf8")) as number[];
        if (pids.length === 2 && pids.every((pid) => observed.has(pid)) && existsSync(ready)) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(pids).toHaveLength(2);
      expect(pids.every((pid) => observed.has(pid))).toBe(true);
      expect(existsSync(ready)).toBe(true);
      inject = true;
      const outcome = await result;
      expect(outcome.value).toBeUndefined();
      expect(outcome.error).toMatchObject({
        diagnostic: { stage: "process-probe", code: "EAGAIN" },
      });
      expect(existsSync(term)).toBe(true);
      expect(existsSync(drained)).toBe(true);
      expect(pids.map(alive)).toEqual([false, false]);
      expect(listLoopExecutionQuarantines()[0]?.processes.map((entry) => entry.pid)).toEqual(
        expect.arrayContaining(pids),
      );
    } finally {
      controller.abort();
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
      await result;
    }
  });

  it("recovers one confirmed probe timeout that crosses successful CLI close using one fresh snapshot", async () => {
    const f = await crossingCloseFixture();
    f.rejectPending(new ownership.ResourceProcessProbeTimeoutError(true, null));
    const completed = await f.result;
    expect(completed.error).toBeUndefined();
    expect(completed.value).toMatchObject({ status: 0, ownershipProbeRetries: { count: 1 } });
    expect(f.probe).toHaveBeenCalledTimes(3);
    expect(f.maxActive()).toBe(1);
    expect(f.persist).toHaveBeenCalledTimes(1);
  });

  it.each(["second-timeout", "parser", "untyped"] as const)(
    "fails closed when crossing-close recovery encounters %s",
    async (kind) => {
      const f = await crossingCloseFixture();
      f.probe.mockRejectedValueOnce(
        kind === "second-timeout"
          ? new ownership.ResourceProcessProbeTimeoutError(true, null)
          : kind === "parser"
            ? new SyntaxError("fixture parser failure")
            : Object.assign(new Error("fixture spawn failure"), { code: "EAGAIN" }),
      );
      f.rejectPending(new ownership.ResourceProcessProbeTimeoutError(true, null));
      const completed = await f.result;
      expect(completed.value).toBeUndefined();
      expect(completed.error).toBeInstanceOf(RalphProcessOwnershipError);
      expect(retryWarnings()).toBe(1);
    },
  );

  it("does not recover an ownership timeout after unsuccessful CLI exit", async () => {
    const f = await crossingCloseFixture(false, 2);
    f.rejectPending(new ownership.ResourceProcessProbeTimeoutError(true, null));
    const completed = await f.result;
    expect(completed.value).toBeUndefined();
    expect(completed.error).toBeInstanceOf(RalphProcessOwnershipError);
    expect(retryWarnings()).toBe(0);
  });

  it.each(["cancelled", "timed_out"] as const)(
    "does not begin final timeout recovery after %s",
    async (reason) => {
      const f = await crossingCloseFixture();
      if (reason === "cancelled") f.controller.abort();
      else vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5000);
      f.rejectPending(new ownership.ResourceProcessProbeTimeoutError(true, null));
      const completed = await f.result;
      expect(completed.value).toBeUndefined();
      expect(completed.error).toBeInstanceOf(RalphProcessOwnershipError);
      expect(retryWarnings()).toBe(0);
    },
  );

  it.each([
    { reason: "cancelled", code: "EACCES" },
    { reason: "timed_out", code: "EACCES" },
    { reason: "cancelled", code: "ETIMEDOUT" },
    { reason: "timed_out", code: "ETIMEDOUT" },
  ] as const)(
    "requires strict stop proof for $reason/$code during final recovery",
    async ({ reason, code }) => {
      const f = await crossingCloseFixture();
      const fresh = deferred<Awaited<ReturnType<typeof f.probe>>>();
      const entered = deferred<void>();
      f.probe
        .mockImplementationOnce(async () => {
          entered.resolve();
          return fresh.promise;
        })
        .mockRejectedValueOnce(
          code === "ETIMEDOUT"
            ? new ownership.ResourceProcessProbeTimeoutError(true, null)
            : Object.assign(new Error("strict stop proof failed"), { code }),
        );
      f.rejectPending(new ownership.ResourceProcessProbeTimeoutError(true, null));
      await entered.promise;
      if (reason === "cancelled") f.controller.abort();
      else vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5000);
      fresh.resolve({ processes: [] });
      const completed = await f.result;
      expect(completed.value).toBeUndefined();
      expect(completed.error).toMatchObject({
        diagnostic: { stage: "process-probe", code },
      });
    },
  );

  it("cannot accept final-only recovery after the original deadline without a timer callback", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = await crossingCloseFixture(true);
    const fresh = deferred<Awaited<ReturnType<typeof f.probe>>>();
    const entered = deferred<void>();
    f.probe.mockImplementationOnce(async () => {
      entered.resolve();
      return fresh.promise;
    });
    f.rejectPending(new ownership.ResourceProcessProbeTimeoutError(true, null));
    await entered.promise;
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5000);
    fresh.resolve({ processes: [] });
    const completed = await f.result;
    expect(completed.error).toBeUndefined();
    expect(completed.value).toMatchObject({
      stopped: { reason: "timed_out", knownProcessesStopped: true },
    });
  });

  it("recovers one probe-owned timeout even when the helper closes with SIGPIPE", async () => {
    mockProbeTimeouts(["success", "timeout", "success"], { signal: "SIGPIPE" });
    const result = await runRalphProcess(boundedFixture());
    expect(result.status).toBe(0);
    expect(result.ownershipProbeRetries?.count).toBe(1);
  });

  it("does not infer timeout ownership from an elapsed killed SIGTERM error", async () => {
    mockProbeTimeouts(["timeout", "success"], {}, 5001, false);
    await expect(runRalphProcess(boundedFixture())).rejects.toMatchObject({
      confirmedProbeTimeout: false,
    });
  });

  it("recovers one confirmed monitoring timeout using a fresh ownership snapshot", async () => {
    mockProbeTimeouts(["success", "timeout", "success"]);
    const persist = vi.fn();
    const result = await runRalphProcess(boundedFixture(persist));
    expect(result.status).toBe(0);
    expect(result).toMatchObject({
      ownershipProbeRetries: {
        count: 1,
        lastTimeout: { stage: "process-probe", code: "ETIMEDOUT", killed: true, signal: "SIGTERM" },
      },
    });
    expect(persist).toHaveBeenCalledOnce();
    const logDir = process.env.TCB_LOG_DIR;
    if (logDir === undefined) throw new Error("missing isolated log directory");
    expect(existsSync(logDir)).toBe(true);
    const logs = readdirSync(logDir)
      .map((file) => readFileSync(join(logDir, file), "utf8"))
      .join("");
    expect(logs).toContain("RalphWorks ownership probe timed out; retrying once");
    expect(logs).toContain('"stage":"process-probe"');
    expect(logs).not.toMatch(/injected ps timeout|stdout|stderr|cmd|\/private\//);
  });

  it("resets the consecutive timeout budget only after a fresh successful snapshot", async () => {
    mockProbeTimeouts(["timeout", "success", "timeout", "success"]);
    const result = await runRalphProcess(boundedFixture());
    expect(result.status).toBe(0);
    expect(result).toMatchObject({ ownershipProbeRetries: { count: 2 } });
  });

  it("fails closed after a second consecutive monitor timeout", async () => {
    mockProbeTimeouts(["timeout", "timeout", "success"]);
    await expect(runRalphProcess(boundedFixture())).rejects.toMatchObject({
      diagnostic: { stage: "process-probe", killed: true, signal: "SIGTERM" },
    });
  });

  it.each([
    { code: "EAGAIN" },
    { name: "AbortError", code: "ABORT_ERR" },
    { code: "ETIMEDOUT" },
    { code: "unrecognized" },
    { killed: false },
    { signal: "SIGKILL" },
  ])("does not retry an unconfirmed probe failure %j", async (fields) => {
    mockProbeTimeouts(["timeout", "success"], fields, 5001, false);
    await expect(runRalphProcess(boundedFixture())).rejects.toMatchObject({
      confirmedProbeTimeout: false,
    });
  });

  it("does not retry a killed probe before the actual ps timeout threshold", async () => {
    mockProbeTimeouts(["timeout", "success"], {}, 100, false);
    await expect(runRalphProcess(boundedFixture())).rejects.toMatchObject({
      confirmedProbeTimeout: false,
    });
  });

  it("does not retry an ordinary process snapshot parser error", async () => {
    mockProbeTimeouts(
      ["timeout", "success"],
      {
        code: undefined,
        killed: undefined,
        signal: undefined,
      },
      5001,
      false,
    );
    await expect(runRalphProcess(boundedFixture())).rejects.toMatchObject({
      confirmedProbeTimeout: false,
    });
  });

  it.each(["cancelled", "timed_out"] as const)(
    "honors %s while the monitor retry is in flight",
    async (reason) => {
      const freshProbe = ownership.createProcessIdentityProbe({});
      const { probe } = mockProbeTimeouts(["timeout"]);
      const originalProbe = probe.getMockImplementation();
      if (originalProbe === undefined) throw new Error("missing probe fixture implementation");
      let release!: () => void;
      let entered!: () => void;
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      const retryEntered = new Promise<void>((resolve) => {
        entered = resolve;
      });
      probe.mockImplementationOnce(originalProbe).mockImplementationOnce(async () => {
        entered();
        await waiting;
        return freshProbe();
      });
      const controller = new AbortController();
      const result = runRalphProcess({
        ...boundedFixture(),
        signal: controller.signal,
        timeoutMs: reason === "timed_out" ? 50 : 2000,
      });
      await retryEntered;
      if (reason === "cancelled") controller.abort();
      else await new Promise((resolve) => setTimeout(resolve, 100));
      release();
      await expect(result).resolves.toMatchObject({
        stopped: { reason, knownProcessesStopped: true },
        ownershipProbeRetries: { count: 1 },
      });
    },
  );

  it("cannot accept a child exit from stale evidence when the retry fails", async () => {
    const { probe } = mockProbeTimeouts(["timeout"]);
    const originalProbe = probe.getMockImplementation();
    if (originalProbe === undefined) throw new Error("missing probe fixture implementation");
    probe.mockImplementationOnce(originalProbe).mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      throw Object.assign(new Error("retry failed after child exit"), { code: "EAGAIN" });
    });
    const fixture = boundedFixture();
    fixture.args = ["-e", "setTimeout(()=>{},30)"];
    await expect(runRalphProcess(fixture)).rejects.toMatchObject({
      diagnostic: { stage: "process-probe", code: "EAGAIN" },
    });
  });

  it("does not retry a timeout-shaped ownership persistence failure", async () => {
    const { advance } = mockProbeTimeouts(["success"]);
    await expect(
      runRalphProcess(
        boundedFixture(() => {
          advance();
          throw Object.assign(new Error("persistence failure"), {
            code: null,
            killed: true,
            signal: "SIGTERM",
          });
        }),
      ),
    ).rejects.toMatchObject({ diagnostic: { stage: "ownership-persistence" } });
  });

  it("recovers one confirmed timeout during successful final ownership verification", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = await crossingCloseFixture(true);
    f.rejectPending(new ownership.ResourceProcessProbeTimeoutError(true, null));
    const completed = await f.result;
    expect(completed.error).toBeUndefined();
    expect(completed.value).toMatchObject({ status: 0, ownershipProbeRetries: { count: 1 } });
    expect(f.probe).toHaveBeenCalledTimes(3);
    expect(f.maxActive()).toBe(1);
  });

  it("retains sanitized probe failure diagnostics while stopping the command", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tcb-ralph-probe-failure-"));
    const probeError = Object.assign(new Error("secret command /private/user/path token=secret"), {
      code: "ETIMEDOUT",
      killed: true,
      signal: "SIGTERM",
      stdout: "secret stdout",
      stderr: "secret stderr",
      cmd: "secret command",
    });
    const probe = vi
      .fn()
      .mockRejectedValueOnce(probeError)
      .mockRejectedValue(Object.assign(new Error("secret cleanup failure"), { code: "EACCES" }));
    vi.spyOn(ownership, "createProcessIdentityProbe").mockReturnValue(probe);
    const error = await runRalphProcess({
      executable: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"],
      cwd: dir,
      timeoutMs: 5000,
      signal: new AbortController().signal,
    }).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(RalphProcessOwnershipError);
    expect(error).toMatchObject({
      diagnostic: {
        stage: "process-probe",
        errorName: "Error",
        code: "ETIMEDOUT",
        killed: true,
        signal: "SIGTERM",
        elapsedMs: expect.any(Number),
      },
    });
    expect((error as Error).message).toContain("stage=process-probe");
    expect((error as Error).message).not.toMatch(/secret|\/private\/|stdout|stderr|command=/);
    expect(JSON.stringify(error)).not.toMatch(/secret|\/private\//);
  });

  it("distinguishes a filesystem failure persisting owned processes from a probe failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tcb-ralph-persistence-failure-"));
    const actualProbe = ownership.createProcessIdentityProbe({});
    vi.spyOn(ownership, "createProcessIdentityProbe").mockReturnValue(actualProbe);
    const persist = vi.fn(() => writeFileSync(dir, "cannot replace a directory"));
    const error = await runRalphProcess({
      executable: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"],
      cwd: dir,
      timeoutMs: 5000,
      signal: new AbortController().signal,
      onOwnedProcesses: persist,
    }).catch((error: unknown) => error);

    expect(persist).toHaveBeenCalled();
    expect(error).toBeInstanceOf(RalphProcessOwnershipError);
    expect(error).toMatchObject({
      diagnostic: {
        stage: "ownership-persistence",
        errorName: "Error",
        code: "EISDIR",
        killed: null,
        signal: null,
        elapsedMs: expect.any(Number),
      },
    });
    expect((error as Error).message).toContain("stage=ownership-persistence");
    expect((error as Error).message).not.toContain(dir);
    expect(JSON.stringify(error)).not.toContain(dir);
  });

  it("stops observed detached descendants that ignore TERM before returning cancellation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tcb-ralph-process-"));
    const ids = join(dir, "pids.json");
    const grandchild = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
    const descendant = `const cp=require('node:child_process');process.on('SIGTERM',()=>{});const child=cp.spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(ids)},JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);`;
    const cli = join(dir, "cli");
    writeFileSync(
      cli,
      `#!${process.execPath}\nrequire('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{detached:true,stdio:'ignore'});setInterval(()=>{},1000);\n`,
    );
    chmodSync(cli, 0o755);
    const controller = new AbortController();
    const observed = new Set<number>();
    const execution = runRalphProcess({
      executable: cli,
      args: [],
      cwd: dir,
      timeoutMs: 5000,
      signal: controller.signal,
      onOwnedProcesses: (processes) => {
        for (const process of processes) observed.add(process.pid);
      },
    });
    // Observe either terminal outcome before cancellation to avoid unhandled rejections.
    const settled = execution.then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error }),
    );
    const deadline = Date.now() + 3000;
    while (!existsSync(ids) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    if (!existsSync(ids)) {
      controller.abort();
      const outcome = await settled;
      if (!outcome.ok) throw outcome.error;
      throw new Error(`fixture did not start: ${outcome.value.status} ${outcome.value.stderr}`);
    }
    const pids = JSON.parse(readFileSync(ids, "utf8")) as number[];
    try {
      while (!pids.every((pid) => observed.has(pid)) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
      expect(pids.every((pid) => observed.has(pid))).toBe(true);
      controller.abort();
      const outcome = await settled;
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw outcome.error;
      expect(outcome.value.stopped).toEqual({ reason: "cancelled", knownProcessesStopped: true });
      expect(pids.map(alive)).toEqual([false, false]);
    } finally {
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    }
  });
  it("returns a timed-out proof only after a bounded command has stopped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tcb-ralph-timeout-"));
    const result = await runRalphProcess({
      executable: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"],
      cwd: dir,
      timeoutMs: 1000,
      signal: new AbortController().signal,
    });
    expect(result.stopped).toEqual({ reason: "timed_out", knownProcessesStopped: true });
    expect(result.status).not.toBe(0);
  });
});
