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

export interface AtomicWriteOptions {
  /** chmod the file to this mode before it is renamed into place (e.g. 0o600 for secrets). */
  mode?: number;
}

export function writeFileAtomicSync(file: string, data: string, opts?: AtomicWriteOptions): void {
  fs.mkdirSync(nodePath.dirname(file), { recursive: true });
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
