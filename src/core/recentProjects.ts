import * as fs from "node:fs/promises";
import { writeFileAtomic } from "../shared/utils/atomic-write.js";
import { sessionNameFromPath } from "./sessionPathMap.js";
import { appStateFile } from "../shared/state-dir.js";

const MAX_RECENT_PROJECTS = 15;
const recentProjectsFile = (): string => appStateFile("recent_projects.txt");
let recentProjectsCache: string[] | null = null;

export async function readRecentProjectLines(): Promise<string[]> {
  if (recentProjectsCache !== null) return recentProjectsCache;
  try {
    const raw = await fs.readFile(recentProjectsFile(), "utf-8");
    recentProjectsCache = raw.split("\n").filter(Boolean);
    return recentProjectsCache;
  } catch {
    recentProjectsCache = [];
    return recentProjectsCache;
  }
}

let recentProjectLock: Promise<void> = Promise.resolve();

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
    await writeFileAtomic(recentProjectsFile(), `${filtered.join("\n")}\n`);
    recentProjectsCache = filtered;
  } finally {
    release();
  }
}
