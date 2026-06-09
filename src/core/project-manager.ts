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

export class CurrentProjectManager {
  private readonly baseDir: string;
  private sessionCache: string | null = null;
  private cacheDirty = true;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  private filePath(): string {
    return nodePath.join(this.baseDir, CURRENT_PROJECT_FILE);
  }

  async get(): Promise<string | null> {
    if (!this.cacheDirty && this.sessionCache !== null) {
      return this.sessionCache;
    }
    try {
      this.sessionCache = await fsAsync.readFile(this.filePath(), "utf-8");
      this.cacheDirty = false;
      return this.sessionCache;
    } catch {
      this.sessionCache = null;
      this.cacheDirty = false;
      return null;
    }
  }

  async set(sessionName: string): Promise<void> {
    await fsAsync.writeFile(this.filePath(), sessionName, "utf-8");
    this.sessionCache = sessionName;
    this.cacheDirty = false;
  }

  async clear(): Promise<void> {
    try {
      await fsAsync.unlink(this.filePath());
    } catch {
      // ignore
    }
    this.sessionCache = null;
    this.cacheDirty = false;
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
