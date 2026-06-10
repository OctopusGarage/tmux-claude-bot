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

/** Chat channel — each keeps its OWN current project so switching on one does not
 * affect the other. */
export type Channel = "telegram" | "lark";

type CurrentMap = Partial<Record<Channel, string>>;

/**
 * Per-channel "current project" pointer, stored as JSON in `.current_project`:
 * `{ "telegram": "<session>", "lark": "<session>" }`. A legacy plain-string file
 * (one shared current project) is migrated on read by seeding both channels with
 * it, so an existing install keeps working until each channel diverges.
 */
export class CurrentProjectManager {
  private readonly baseDir: string;
  private cache: CurrentMap | null = null;
  private lock: Promise<void> = Promise.resolve();

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  /**
   * Serialize the read-modify-write so two concurrent mutations (e.g. Telegram
   * and Feishu both switching project in the same async window) can't clobber
   * each other — the in-memory cache makes a bare RMW non-atomic, dropping one
   * channel's update.
   */
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
        // Legacy single-string format → seed both channels with the old value.
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

  async get(channel: Channel): Promise<string | null> {
    return (await this.read())[channel] ?? null;
  }

  async set(channel: Channel, sessionName: string): Promise<void> {
    await this.mutate((map) => ({ ...map, [channel]: sessionName }));
  }

  /** Clear one channel's current project (e.g. it pointed at a removed session). */
  async clear(channel: Channel): Promise<void> {
    await this.mutate((map) => {
      delete map[channel];
      return map;
    });
  }

  /** Drop `sessionName` from EVERY channel that points at it — used when the
   * session is torn down, so no channel is left pointing at a dead session. */
  async clearSession(sessionName: string): Promise<void> {
    await this.mutate((map) => {
      for (const ch of ["telegram", "lark"] as Channel[]) {
        if (map[ch] === sessionName) delete map[ch];
      }
      return map;
    });
  }

  /** Any channel's current project — for the bridge's default-session fallback. */
  async getAny(): Promise<string | null> {
    const map = await this.read();
    return map.telegram ?? map.lark ?? null;
  }

  /** Distinct current sessions across channels — for boot-time session restore. */
  async allCurrent(): Promise<string[]> {
    const map = await this.read();
    return [...new Set([map.telegram, map.lark].filter((s): s is string => Boolean(s)))];
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
