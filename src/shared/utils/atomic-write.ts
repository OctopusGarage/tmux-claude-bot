import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as nodePath from "node:path";

/**
 * Crash-safe file writes for small state files (JSON maps, recent lists):
 * write to a temp file in the same directory, fsync, then rename over the
 * target. A crash mid-write leaves the old file intact instead of a
 * truncated one. Not for large files or cross-device targets (rename must
 * stay on one filesystem — the temp file lives next to the target).
 */

function tmpPath(file: string): string {
  return `${file}.tmp-${process.pid}-${randomBytes(3).toString("hex")}`;
}

const STALE_TMP_MS = 60 * 60 * 1000;

function isStaleTmpFile(st: { mtimeMs: number }, now: number): boolean {
  return now - st.mtimeMs >= STALE_TMP_MS;
}

function tmpPrefix(file: string): string {
  return `${nodePath.basename(file)}.tmp-`;
}

function cleanupStaleTempsSync(file: string): void {
  const dir = nodePath.dirname(file);
  const prefix = tmpPrefix(file);
  const now = Date.now();
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    const candidate = nodePath.join(dir, entry);
    try {
      const st = fs.statSync(candidate);
      if (st.isFile() && isStaleTmpFile(st, now)) fs.rmSync(candidate, { force: true });
    } catch {
      // Best effort only; atomic writes must not fail because stale cleanup did.
    }
  }
}

async function cleanupStaleTemps(file: string): Promise<void> {
  const dir = nodePath.dirname(file);
  const prefix = tmpPrefix(file);
  const now = Date.now();
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((entry) => entry.startsWith(prefix))
      .map(async (entry) => {
        const candidate = nodePath.join(dir, entry);
        try {
          const st = await fsp.stat(candidate);
          if (st.isFile() && isStaleTmpFile(st, now)) await fsp.rm(candidate, { force: true });
        } catch {
          // Best effort only; atomic writes must not fail because stale cleanup did.
        }
      }),
  );
}

export interface AtomicWriteOptions {
  /** chmod the file to this mode before it is renamed into place (e.g. 0o600 for secrets). */
  mode?: number;
}

export function writeFileAtomicSync(file: string, data: string, opts?: AtomicWriteOptions): void {
  fs.mkdirSync(nodePath.dirname(file), { recursive: true });
  cleanupStaleTempsSync(file);
  const tmp = tmpPath(file);
  try {
    const fd = fs.openSync(tmp, "w");
    try {
      fs.writeFileSync(fd, data, "utf-8");
      if (opts?.mode !== undefined) fs.fchmodSync(fd, opts.mode);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

export async function writeFileAtomic(file: string, data: string): Promise<void> {
  await fsp.mkdir(nodePath.dirname(file), { recursive: true });
  await cleanupStaleTemps(file);
  const tmp = tmpPath(file);
  try {
    const handle = await fsp.open(tmp, "w");
    try {
      await handle.writeFile(data, "utf-8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}
