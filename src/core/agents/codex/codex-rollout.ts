/**
 * Locating codex rollout JSONLs on disk. Pure fs primitives (no UsageSnapshot /
 * deps coupling) so the config-resolver can depend on the open-rollout matcher
 * without forming an import cycle. Parsing usage OUT of a rollout lives in
 * codex-usage.ts. All fs is async so a large sessions/ tree never blocks the loop.
 */
import type { Dirent } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { iterJsonlObjects } from "../../read/jsonl.js";

export interface RolloutMatch {
  path: string;
  sessionId: string | null;
}

/** Read just the first line of a file via one bounded read — rollout JSONLs grow
 * to many MB, but `session_meta` is line 1, so never buffer the whole file. Empty
 * string on any error. */
export async function readFirstLine(path: string, maxBytes = 64 * 1024): Promise<string> {
  let fh: Awaited<ReturnType<typeof open>> | null = null;
  try {
    fh = await open(path, "r");
    const buf = Buffer.allocUnsafe(maxBytes);
    const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
    const text = buf.toString("utf8", 0, bytesRead);
    const nl = text.indexOf("\n");
    return nl === -1 ? text : text.slice(0, nl);
  } catch {
    return "";
  } finally {
    await fh?.close().catch(() => {});
  }
}

/** The `session_meta.payload` of a rollout's first line, or null. */
export async function rolloutMeta(
  path: string,
): Promise<{ type?: string; cwd?: string; id?: string } | null> {
  try {
    const obj = JSON.parse(await readFirstLine(path)) as {
      payload?: { type?: string; cwd?: string; id?: string };
    };
    return obj.payload ?? null;
  } catch {
    return null;
  }
}

/** The last model Codex recorded for this rollout, if present. */
export async function readCodexModelFromRollout(path: string): Promise<string | null> {
  try {
    const jsonlText = await readFile(path, "utf8");
    let last: string | null = null;
    for (const obj of iterJsonlObjects<{
      type?: string;
      payload?: {
        model?: unknown;
        collaboration_mode?: { settings?: { model?: unknown } };
      };
    }>(jsonlText)) {
      if (obj.type !== "turn_context") continue;
      const direct = obj.payload?.model;
      if (typeof direct === "string" && direct.trim() !== "") {
        last = direct;
        continue;
      }
      const collaborationModel = obj.payload?.collaboration_mode?.settings?.model;
      if (typeof collaborationModel === "string" && collaborationModel.trim() !== "") {
        last = collaborationModel;
      }
    }
    return last;
  } catch {
    return null;
  }
}

async function walkRolloutFiles(configRoot: string): Promise<{ path: string; mtime: number }[]> {
  const out: { path: string; mtime: number }[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // missing dir / permission — skip this branch
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith(".jsonl")) {
        try {
          out.push({ path: p, mtime: (await stat(p)).mtimeMs });
        } catch {
          // racing unlink / permission — skip
        }
      }
    }
  };
  await walk(join(configRoot, "sessions"));
  return out;
}

/** Coalesce the `sessions/**` walk across a render burst. A single /list_alive +
 * /status + /history interaction calls collectRolloutFiles many times for the
 * SAME configRoot (findRolloutForProject per session, listCodexSessions, the
 * usage + dispatch fallbacks); without this each one re-walks the whole tree
 * (O(total rollouts) stats). A short TTL keeps detection effectively live — a
 * brand-new session shows via the live open-rollout path, not this walk. */
const WALK_TTL_MS = 2000;
const walkCache = new Map<
  string,
  { at: number; files: Promise<{ path: string; mtime: number }[]> }
>();

/** Every rollout `.jsonl` under `<configRoot>/sessions/**`, with its mtime (ms).
 * The single recursive walk both finders share, memoized for {@link WALK_TTL_MS}.
 * Best-effort; skips unreadable. */
export function collectRolloutFiles(
  configRoot: string,
): Promise<{ path: string; mtime: number }[]> {
  const now = Date.now();
  const cached = walkCache.get(configRoot);
  if (cached && now - cached.at < WALK_TTL_MS) return cached.files;
  const files = walkRolloutFiles(configRoot);
  walkCache.set(configRoot, { at: now, files });
  return files;
}

/** Match the open `.jsonl` a live codex pid holds for its rollout: a path under a
 * `sessions/` tree ending in `rollout-…-<uuid>.jsonl`. Disambiguates several codex
 * sharing one cwd (Free Projects) — each pid has its OWN rollout open, so this is
 * exact where the cwd+mtime scan can only guess. Returns the first match, or null. */
export function matchOpenCodexRollout(openFiles: string[]): RolloutMatch | null {
  for (const f of openFiles) {
    const m = f.match(
      /\/sessions\/.*rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/,
    );
    if (m?.[1]) return { path: f, sessionId: m[1] };
  }
  return null;
}

/** Find the newest rollout JSONL under `<configRoot>/sessions/**` whose
 * session_meta.cwd === projectPath, or null. Best-effort; swallows fs errors.
 *
 * Stats every rollout (cheap), then reads first-lines newest-mtime-first and
 * returns at the first cwd match — so the common case touches ONE file's first
 * line, not every historical rollout's full contents. */
export async function findRolloutForProject(
  configRoot: string,
  projectPath: string,
): Promise<RolloutMatch | null> {
  // Copy before sorting: collectRolloutFiles is now memoized, so the returned
  // array is shared across concurrent callers — sorting it in place could corrupt
  // another caller's in-progress iteration (e.g. listCodexSessions).
  const files = [...(await collectRolloutFiles(configRoot))];
  files.sort((a, b) => b.mtime - a.mtime);
  for (const f of files) {
    const meta = await rolloutMeta(f.path);
    if (meta?.cwd === projectPath) return { path: f.path, sessionId: meta.id ?? null };
  }
  return null;
}

/** Find the rollout with an exact session id under `<configRoot>/sessions/**`. */
export async function findRolloutBySessionId(
  configRoot: string,
  sessionId: string,
): Promise<RolloutMatch | null> {
  const files = [...(await collectRolloutFiles(configRoot))];
  files.sort((a, b) => b.mtime - a.mtime);
  const escaped = sessionId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const filenameMatch = new RegExp(`-${escaped}\\.jsonl$`);
  for (const f of files) {
    if (filenameMatch.test(f.path)) return { path: f.path, sessionId };
  }
  for (const f of files) {
    const meta = await rolloutMeta(f.path);
    if (meta?.id === sessionId) return { path: f.path, sessionId };
  }
  return null;
}
