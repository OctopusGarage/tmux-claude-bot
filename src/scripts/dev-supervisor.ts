import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type BackoffConfig,
  buildStatus,
  decideGate,
  nextCrashAction,
  type SupervisorStatus,
  shouldTriggerReload,
} from "../core/dev/supervisor-core.js";
import { createLogger } from "../shared/utils/logger.js";

const log = createLogger("dev.supervisor");
const CHILD_SHUTDOWN_GRACE_MS = 10_000;
const SUPERVISOR_EXIT_GRACE_MS = CHILD_SHUTDOWN_GRACE_MS + 2_000;

export interface ChildHandle {
  kill(signal?: NodeJS.Signals): void;
  onExit(cb: () => void): void;
  waitForExit?(timeoutMs?: number): Promise<boolean>;
}

export interface SupervisorDeps {
  startChild(): ChildHandle;
  runTypecheck(): Promise<number>;
  watchSrc(onChange: (rel: string) => void): () => void;
  writeStatus(s: SupervisorStatus): void;
  shouldDeferReload?(): boolean;
  now(): number;
  debounceMs: number;
  reloadDeferRecheckMs?: number;
  backoff: BackoffConfig;
}

type SpawnedChild = { child: ChildHandle; markIntentional: () => void };
type SupervisorHandle = { stop(signal?: NodeJS.Signals): Promise<void> };
type SupervisorSignalTarget = {
  once(event: NodeJS.Signals, cb: () => void): unknown;
};

/** Spawn a child and return the handle plus a setter to mark its death as intentional.
 * The onExit closure checks a per-child `intentional` boolean — calling
 * `markIntentional()` before `kill()` prevents the exit from being counted as a crash,
 * eliminating the async race that existed with a shared `reloading` flag. */
function spawnChild(
  deps: SupervisorDeps,
  crashes: number[],
  onCrashRespawn: (next: SpawnedChild) => void,
): SpawnedChild {
  const child = deps.startChild();
  let intentional = false;
  child.onExit(() => {
    if (intentional) return;
    crashes.push(deps.now());
    const decision = nextCrashAction(crashes, deps.now(), deps.backoff);
    if (decision.action === "wait") {
      deps.writeStatus(
        buildStatus(
          { state: "crash-wait", lastReloadAtMs: null, lastError: "child crash-looping" },
          deps.now(),
        ),
      );
      log.error("child crash-looping; waiting for next code change");
      return;
    }
    setTimeout(() => {
      onCrashRespawn(spawnChild(deps, crashes, onCrashRespawn));
    }, decision.delayMs);
  });
  return {
    child,
    markIntentional: () => {
      intentional = true;
    },
  };
}

export function startSupervisor(deps: SupervisorDeps): SupervisorHandle {
  const crashes: number[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let pending = false;
  let stopped = false;
  let current = spawnChild(deps, crashes, (next) => {
    current = next;
  });
  const reloadDeferRecheckMs = deps.reloadDeferRecheckMs ?? 30_000;

  function scheduleDeferredReloadCheck(): void {
    timer = setTimeout(() => {
      pending = true;
      void maybeRun();
    }, reloadDeferRecheckMs);
    timer.unref();
  }

  async function onSettled(): Promise<void> {
    const code = await deps.runTypecheck();
    if (decideGate(code) === "hold") {
      deps.writeStatus(
        buildStatus(
          { state: "typecheck-failed", lastReloadAtMs: null, lastError: `tsc exit ${code}` },
          deps.now(),
        ),
      );
      log.warn("typecheck failed; holding last-good child", { data: { code } });
      return;
    }
    if (deps.shouldDeferReload?.() === true) {
      deps.writeStatus(
        buildStatus(
          {
            state: "reload-deferred",
            lastReloadAtMs: null,
            lastError: "active automation is using the bot process",
          },
          deps.now(),
        ),
      );
      log.warn("clean typecheck reload deferred because automation is active");
      scheduleDeferredReloadCheck();
      return;
    }
    const old = current;
    old.markIntentional();
    old.child.kill("SIGTERM");
    const exited = await old.child.waitForExit?.(SUPERVISOR_EXIT_GRACE_MS);
    if (exited === false) {
      log.warn("old child did not exit before reload respawn");
    }
    crashes.length = 0;
    current = spawnChild(deps, crashes, (next) => {
      current = next;
    });
    deps.writeStatus(
      buildStatus({ state: "running", lastReloadAtMs: deps.now(), lastError: null }, deps.now()),
    );
    log.info("reloaded after clean typecheck");
  }

  async function maybeRun(): Promise<void> {
    if (running) return;
    while (pending) {
      pending = false;
      running = true;
      try {
        await onSettled();
      } finally {
        running = false;
      }
    }
  }

  const unwatch = deps.watchSrc((rel) => {
    if (!shouldTriggerReload(rel)) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      pending = true;
      void maybeRun();
    }, deps.debounceMs);
  });

  return {
    async stop(signal = "SIGTERM") {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
      unwatch();
      current.markIntentional();
      current.child.kill(signal);
      const exited = await current.child.waitForExit?.(SUPERVISOR_EXIT_GRACE_MS);
      if (exited === false) {
        log.warn("child did not exit before supervisor shutdown completed");
      }
    },
  };
}

export function installSupervisorSignalHandlers(
  supervisor: SupervisorHandle,
  signalTarget: SupervisorSignalTarget = process,
  exit: (code: number) => never = process.exit,
): void {
  let handled = false;
  const handle = (signal: NodeJS.Signals): void => {
    if (handled) return;
    handled = true;
    log.info("dev supervisor shutdown signal received", { data: { signal } });
    void supervisor.stop(signal).finally(() => exit(0));
  };
  signalTarget.once("SIGINT", () => handle("SIGINT"));
  signalTarget.once("SIGTERM", () => handle("SIGTERM"));
}

function killProcessTree(cp: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (cp.pid === undefined) {
    cp.kill(signal);
    return;
  }
  try {
    process.kill(-cp.pid, signal);
    return;
  } catch (err) {
    if (isProcessMissingError(err)) return;
    log.warn("process group termination failed; falling back to child kill", { err });
  }
  cp.kill(signal);
}

function isProcessMissingError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "ESRCH"
  );
}

/** Real-I/O deps used when run as a process (not exercised by unit tests). */
function realDeps(): SupervisorDeps {
  const repo = process.cwd();
  const srcDir = join(repo, "src");
  const stateDir = process.env.TCB_STATE_DIR ?? repo;
  const statusFile = join(stateDir, "dev-supervisor.json");
  return {
    startChild() {
      const cp = spawn(process.execPath, [join(repo, "node_modules/.bin/tsx"), "src/index.ts"], {
        cwd: repo,
        detached: true,
        stdio: "inherit",
      });
      cp.on("error", (err) => log.error("child spawn failed", { err }));
      let exited = false;
      let escalationTimer: ReturnType<typeof setTimeout> | null = null;
      const exitCallbacks: Array<() => void> = [];
      cp.once("exit", () => {
        exited = true;
        if (escalationTimer) clearTimeout(escalationTimer);
        for (const cb of exitCallbacks.splice(0)) cb();
      });
      return {
        kill(signal = "SIGTERM") {
          killProcessTree(cp, signal);
          if (signal === "SIGKILL" || exited || escalationTimer !== null) return;
          escalationTimer = setTimeout(() => {
            if (exited) return;
            log.warn("child did not exit after graceful signal; escalating to SIGKILL");
            killProcessTree(cp, "SIGKILL");
          }, CHILD_SHUTDOWN_GRACE_MS);
          escalationTimer.unref();
        },
        onExit: (cb) => {
          if (exited) {
            cb();
            return;
          }
          exitCallbacks.push(cb);
        },
        waitForExit(timeoutMs = SUPERVISOR_EXIT_GRACE_MS) {
          if (exited) return Promise.resolve(true);
          return new Promise((resolve) => {
            const timeout = setTimeout(() => resolve(false), timeoutMs);
            exitCallbacks.push(() => {
              clearTimeout(timeout);
              resolve(true);
            });
          });
        },
      };
    },
    runTypecheck() {
      return new Promise((resolve) => {
        const cp = spawn(process.execPath, [join(repo, "node_modules/.bin/tsc"), "--noEmit"], {
          cwd: repo,
          stdio: "inherit",
        });
        cp.on("error", (err) => {
          log.error("typecheck spawn failed", { err });
          resolve(1);
        });
        cp.once("exit", (code) => resolve(code ?? 1));
      });
    },
    watchSrc(onChange) {
      const w = watch(srcDir, { recursive: true }, (_e, file) => {
        if (file) onChange(String(file));
      });
      return () => w.close();
    },
    writeStatus(s) {
      try {
        mkdirSync(join(statusFile, ".."), { recursive: true });
        writeFileSync(statusFile, `${JSON.stringify(s, null, 2)}\n`);
      } catch (err) {
        log.debug("status write failed", { err });
      }
    },
    shouldDeferReload: () => hasActiveAutomation(stateDir),
    now: () => Date.now(),
    debounceMs: 300,
    backoff: { windowMs: 10_000, maxInWindow: 3, delayMs: 1000 },
  };
}

function hasActiveAutomation(stateDir: string): boolean {
  return hasActiveSupervisorLease(join(stateDir, "loop-supervisor-worker-leases.json"));
}

function hasActiveSupervisorLease(file: string): boolean {
  if (!existsSync(file)) return false;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      leases?: { status?: unknown }[];
    };
    return Array.isArray(parsed.leases) && parsed.leases.some((lease) => lease.status === "active");
  } catch (err) {
    log.warn("could not inspect active automation leases; deferring reload", { err });
    return true;
  }
}

// Entry: only run when invoked directly (not when imported by tests).
if (
  process.argv[1]?.endsWith("dev-supervisor.ts") ||
  process.argv[1]?.endsWith("dev-supervisor.js")
) {
  log.info("dev supervisor starting", { data: { cwd: process.cwd() } });
  installSupervisorSignalHandlers(startSupervisor(realDeps()));
}
