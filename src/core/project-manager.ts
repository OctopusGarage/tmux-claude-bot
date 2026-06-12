import * as fsAsync from "node:fs/promises";
import * as nodePath from "node:path";
import { appendRecentProject, readRecentProjectLines } from "./recentProjects.js";
import {
  getPathBySession,
  isCdAllowed,
  sessionNameFromPath,
  setPathForSession,
} from "./sessionPathMap.js";

const CURRENT_PROJECT_FILE = ".current_project";

// ─── current_project ───────────────────────────────────────────────────────────

/** Named chat channels. Kept for use in `chatScope()` and `messages()`. */
export type Channel = "telegram" | "lark";

/**
 * Build a per-chat scope key: `"telegram:${chatId}"` or `"lark:${chatId}"`.
 * Pass this wherever a `Channel` was previously used so that each chat gets its
 * own current-project pointer rather than sharing one per channel.
 */
export function chatScope(channel: Channel, chatId: string | number): string {
  return `${channel}:${chatId}`;
}

/**
 * Extract the base channel from a scope key like `"telegram:123"` → `"telegram"`.
 * Falls back to the full string for legacy bare-channel keys.
 */
export function channelFromScope(scope: string): Channel {
  if (scope.startsWith("telegram")) return "telegram";
  return "lark";
}

type CurrentMap = Record<string, string>;

/** "telegram:123" → "telegram"; null for bare-channel (already-legacy) scopes. */
function legacyKey(scope: string): string | null {
  const sep = scope.indexOf(":");
  return sep > 0 ? scope.slice(0, sep) : null;
}

/**
 * Per-chat "current project" pointer, stored as JSON in `.current_project`.
 * Keys are scope strings: `"telegram:${chatId}"` or `"lark:${chatId}"`.
 * Legacy files with bare `"telegram"` / `"lark"` keys are honored as a read
 * fallback for scoped keys and retired on the first scoped set()/clear().
 */
export class CurrentProjectManager {
  private readonly baseDir: string;
  private cache: CurrentMap | null = null;
  private lock: Promise<void> = Promise.resolve();

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  private async mutate(fn: (map: CurrentMap) => CurrentMap): Promise<void> {
    const prev = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      await this.write(fn({ ...(await this.read()) }));
    } finally {
      release();
    }
  }

  private filePath(): string {
    return nodePath.join(this.baseDir, CURRENT_PROJECT_FILE);
  }

  private async read(): Promise<CurrentMap> {
    if (this.cache !== null) return this.cache;
    try {
      const raw = (await fsAsync.readFile(this.filePath(), "utf-8")).trim();
      if (!raw) {
        this.cache = {};
      } else if (raw.startsWith("{")) {
        this.cache = JSON.parse(raw) as CurrentMap;
      } else {
        // Legacy single-string format → seed bare channel keys.
        this.cache = { telegram: raw, lark: raw };
      }
    } catch {
      this.cache = {};
    }
    return this.cache;
  }

  private async write(map: CurrentMap): Promise<void> {
    await fsAsync.writeFile(this.filePath(), `${JSON.stringify(map, null, 2)}\n`, "utf-8");
    this.cache = map;
  }

  async get(scope: string): Promise<string | null> {
    const map = await this.read();
    const hit = map[scope];
    if (hit) return hit;
    // Upgrade path: state files written before the per-chat scope refactor
    // hold bare channel keys ("telegram"). Fall back so a deploy doesn't make
    // every chat forget its current project. set()/clear() retire the legacy
    // key, so this fallback only fires until the first scoped write.
    const legacy = legacyKey(scope);
    return (legacy ? map[legacy] : undefined) ?? null;
  }

  async set(scope: string, sessionName: string): Promise<void> {
    await this.mutate((map) => {
      const next = { ...map, [scope]: sessionName };
      const legacy = legacyKey(scope);
      if (legacy) delete next[legacy];
      return next;
    });
  }

  /** Clear one scope's current project (e.g. it pointed at a removed session). */
  async clear(scope: string): Promise<void> {
    await this.mutate((map) => {
      delete map[scope];
      const legacy = legacyKey(scope);
      if (legacy) delete map[legacy];
      return map;
    });
  }

  /** Drop `sessionName` from every scope that points at it. */
  async clearSession(sessionName: string): Promise<void> {
    await this.mutate((map) => {
      for (const key of Object.keys(map)) {
        if (map[key] === sessionName) delete map[key];
      }
      return map;
    });
  }

  /** Any scope's current project — for the bridge's default-session fallback. */
  async getAny(): Promise<string | null> {
    const map = await this.read();
    return Object.values(map).find((v): v is string => Boolean(v)) ?? null;
  }

  /** Distinct current sessions across all scopes — for boot-time session restore. */
  async allCurrent(): Promise<string[]> {
    const map = await this.read();
    return [...new Set(Object.values(map).filter((s): s is string => Boolean(s)))];
  }
}

// ─── project manager facade ────────────────────────────────────────────────────
// The session ↔ path map and recent-projects helpers live in their own modules
// (sessionPathMap.ts / recentProjects.ts) — the single, TCB_STATE_DIR-aware
// implementation. This facade just bundles them with the current-project pointer
// for the bootstrap wiring.

export interface ProjectManager {
  currentProject: CurrentProjectManager;
  getPathBySession(session: string): string | null;
  setPathForSession(session: string, path: string): void;
  sessionNameFromPath(path: string, prefix: string): string;
  isCdAllowed(path: string, allowed: readonly string[]): boolean;
  readRecentProjectLines(): Promise<string[]>;
  appendRecentProject(path: string, prefix: string): Promise<void>;
}

export function createProjectManager(baseDir: string): ProjectManager {
  return {
    currentProject: new CurrentProjectManager(baseDir),
    getPathBySession,
    setPathForSession,
    sessionNameFromPath,
    isCdAllowed,
    readRecentProjectLines,
    appendRecentProject,
  };
}
