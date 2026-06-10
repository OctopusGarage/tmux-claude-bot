import * as fs from "node:fs";
import * as fsAsync from "node:fs/promises";
import { homedir } from "node:os";
import * as nodePath from "node:path";

const CURRENT_PROJECT_FILE = ".current_project";
const SESSION_PATH_MAP_FILE = "session_path_map.json";
const RECENT_PROJECTS_FILE = "recent_projects.txt";
const MAX_RECENT_PROJECTS = 15;
const projectRoot = nodePath.resolve(
  nodePath.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);

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

  constructor(baseDir: string) {
    this.baseDir = baseDir;
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
    await this.write({ ...(await this.read()), [channel]: sessionName });
  }

  /** Clear one channel's current project (e.g. it pointed at a removed session). */
  async clear(channel: Channel): Promise<void> {
    const map = { ...(await this.read()) };
    delete map[channel];
    await this.write(map);
  }

  /** Drop `sessionName` from EVERY channel that points at it — used when the
   * session is torn down, so no channel is left pointing at a dead session. */
  async clearSession(sessionName: string): Promise<void> {
    const map = { ...(await this.read()) };
    let changed = false;
    for (const ch of ["telegram", "lark"] as Channel[]) {
      if (map[ch] === sessionName) {
        delete map[ch];
        changed = true;
      }
    }
    if (changed) await this.write(map);
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

// ─── session ↔ path map ────────────────────────────────────────────────────────

function sessionPathMapPath(): string {
  return nodePath.join(projectRoot, SESSION_PATH_MAP_FILE);
}

export function loadSessionPathMap(): Record<string, string> {
  try {
    const raw = fs.readFileSync(sessionPathMapPath(), "utf-8");
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

function saveSessionPathMap(map: Record<string, string>): void {
  fs.writeFileSync(sessionPathMapPath(), JSON.stringify(map, null, 2), "utf-8");
}

export function getPathBySession(sessionName: string): string | null {
  const map = loadSessionPathMap();
  return map[sessionName] ?? null;
}

export function setPathForSession(sessionName: string, projectPath: string): void {
  const map = loadSessionPathMap();
  map[sessionName] = projectPath;
  saveSessionPathMap(map);
}

export function sessionNameFromPath(projectPath: string, prefix: string): string {
  const absPath = nodePath.resolve(projectPath);
  return prefix + absPath.replace(/\//g, "-");
}

export function isCdAllowed(targetPath: string, allowed: readonly string[]): boolean {
  if (allowed.length === 0) return true;
  const expanded = allowed.map((d) => nodePath.resolve(d.replaceAll("~", homedir())));
  return expanded.some((dir) => targetPath.startsWith(`${dir}/`) || targetPath === dir);
}

// ─── recent projects ────────────────────────────────────────────────────────────

let recentProjectsCache: string[] | null = null;
let recentProjectLock: Promise<void> = Promise.resolve();

export async function readRecentProjectLines(): Promise<string[]> {
  if (recentProjectsCache !== null) return recentProjectsCache;
  try {
    const raw = await fsAsync.readFile(nodePath.join(projectRoot, RECENT_PROJECTS_FILE), "utf-8");
    recentProjectsCache = raw.split("\n").filter(Boolean);
    return recentProjectsCache;
  } catch {
    recentProjectsCache = [];
    return recentProjectsCache;
  }
}

export async function appendRecentProject(newPath: string, prefix: string): Promise<void> {
  const prev = recentProjectLock;
  let release!: () => void;
  recentProjectLock = new Promise<void>((resolve) => {
    release = resolve;
  });
  await prev;
  try {
    const newSession = sessionNameFromPath(newPath, prefix);
    const lines = await readRecentProjectLines();
    const filtered = lines.filter((l) => {
      if (l === newPath) return false;
      return sessionNameFromPath(l, prefix) !== newSession;
    });
    filtered.unshift(newPath);
    if (filtered.length > MAX_RECENT_PROJECTS) {
      filtered.length = MAX_RECENT_PROJECTS;
    }
    await fsAsync.writeFile(
      nodePath.join(projectRoot, RECENT_PROJECTS_FILE),
      `${filtered.join("\n")}\n`,
      "utf-8",
    );
    recentProjectsCache = filtered;
  } finally {
    release();
  }
}

// ─── project manager facade ────────────────────────────────────────────────────

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
