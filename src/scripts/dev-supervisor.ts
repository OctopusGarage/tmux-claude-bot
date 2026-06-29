import { spawn } from "node:child_process";
import { mkdirSync, watch, writeFileSync } from "node:fs";
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

export interface ChildHandle {
  kill(): void;
  onExit(cb: () => void): void;
}

export interface SupervisorDeps {
  startChild(): ChildHandle;
  runTypecheck(): Promise<number>;
  watchSrc(onChange: (rel: string) => void): () => void;
  writeStatus(s: SupervisorStatus): void;
  now(): number;
  debounceMs: number;
  backoff: BackoffConfig;
}

type SpawnedChild = { child: ChildHandle; markIntentional: () => void };

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

export function startSupervisor(deps: SupervisorDeps): { stop(): void } {
  const crashes: number[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let current = spawnChild(deps, crashes, (next) => {
    current = next;
  });

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
    current.markIntentional();
    current.child.kill();
    current = spawnChild(deps, crashes, (next) => {
      current = next;
    });
    deps.writeStatus(
      buildStatus({ state: "running", lastReloadAtMs: deps.now(), lastError: null }, deps.now()),
    );
    log.info("reloaded after clean typecheck");
  }

  const unwatch = deps.watchSrc((rel) => {
    if (!shouldTriggerReload(rel)) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void onSettled(), deps.debounceMs);
  });

  return {
    stop() {
      if (timer) clearTimeout(timer);
      unwatch();
      current.markIntentional();
      current.child.kill();
    },
  };
}

/** Real-I/O deps used when run as a process (not exercised by unit tests). */
function realDeps(): SupervisorDeps {
  const repo = process.cwd();
  const srcDir = join(repo, "src");
  const statusFile = join(process.env.TCB_STATE_DIR ?? repo, "dev-supervisor.json");
  return {
    startChild() {
      const cp = spawn(process.execPath, [join(repo, "node_modules/.bin/tsx"), "src/index.ts"], {
        cwd: repo,
        stdio: "inherit",
      });
      cp.on("error", (err) => log.error("child spawn failed", { err }));
      return {
        kill: () => cp.kill("SIGTERM"),
        onExit: (cb) => cp.once("exit", cb),
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
    now: () => Date.now(),
    debounceMs: 300,
    backoff: { windowMs: 10_000, maxInWindow: 3, delayMs: 1000 },
  };
}

// Entry: only run when invoked directly (not when imported by tests).
if (
  process.argv[1]?.endsWith("dev-supervisor.ts") ||
  process.argv[1]?.endsWith("dev-supervisor.js")
) {
  log.info("dev supervisor starting", { data: { cwd: process.cwd() } });
  startSupervisor(realDeps());
}
