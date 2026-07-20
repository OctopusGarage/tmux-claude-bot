import { readdir, readFile, readlink } from "node:fs/promises";
import type { ProcessIntrospector, ProcRow } from "./introspector.types.js";

/** The fs surface this introspector needs — injected for testing. */
export interface LinuxFs {
  readdir(path: string): Promise<string[]>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  readlink(path: string): Promise<string>;
}

const realFs: LinuxFs = {
  readdir: (p) => readdir(p),
  readFile: (p, enc) => readFile(p, enc),
  readlink: (p) => readlink(p),
};

/** Parse ppid from /proc/<pid>/stat. comm (in parens) may contain spaces and
 * parens, so split AFTER the last ')': fields are then [state, ppid, ...]. */
function ppidFromStat(stat: string): number | null {
  const rparen = stat.lastIndexOf(")");
  if (rparen < 0) return null;
  const fields = stat.slice(rparen + 2).split(" ");
  const ppid = Number(fields[1]);
  return Number.isNaN(ppid) ? null : ppid;
}

/** Linux introspector backed by /proc. */
export function createLinuxIntrospector(fs: LinuxFs = realFs): ProcessIntrospector {
  return {
    async snapshot(): Promise<ProcRow[]> {
      let entries: string[];
      try {
        entries = await fs.readdir("/proc");
      } catch {
        return [];
      }
      const pids = entries.map((e) => Number(e)).filter((n) => Number.isInteger(n) && n > 0);
      const rows = await Promise.all(
        pids.map(async (pid): Promise<ProcRow | null> => {
          try {
            const [stat, cmdline] = await Promise.all([
              fs.readFile(`/proc/${pid}/stat`, "utf8"),
              fs.readFile(`/proc/${pid}/cmdline`, "utf8"),
            ]);
            const ppid = ppidFromStat(stat);
            const command = cmdline.replace(/\0/g, " ").trim();
            // Drop empty-cmdline rows (kernel threads / unreadable). NOTE: the
            // macOS introspector keeps empty-command rows; dropping them here is
            // intentional — kernel threads never match a claude process and are
            // never ancestors of one, so the process-tree walk is unaffected.
            if (ppid === null || command === "") return null;
            return { pid, ppid, command };
          } catch {
            return null; // vanished mid-scan
          }
        }),
      );
      return rows.filter((r): r is ProcRow => r !== null);
    },
    async readProcEnv(pid: number): Promise<string> {
      try {
        const raw = await fs.readFile(`/proc/${pid}/environ`, "utf8");
        return raw.replace(/\0/g, "\n");
      } catch {
        return "";
      }
    },
    async listOpenFiles(pid: number): Promise<string[]> {
      let fds: string[];
      try {
        fds = await fs.readdir(`/proc/${pid}/fd`);
      } catch {
        return [];
      }
      const targets = await Promise.all(
        fds.map((fd) => fs.readlink(`/proc/${pid}/fd/${fd}`).catch(() => "")),
      );
      return targets.filter((t) => t.startsWith("/"));
    },
    async cwdOf(pid: number): Promise<string | null> {
      try {
        return await fs.readlink(`/proc/${pid}/cwd`);
      } catch {
        return null;
      }
    },
    async ttyOf(pid: number): Promise<string | null> {
      // stdin (fd 0) is the terminal the user was typing into for a TUI orphan.
      try {
        const target = await fs.readlink(`/proc/${pid}/fd/0`);
        if (target.startsWith("/dev/pts/") || target.startsWith("/dev/tty")) {
          return target;
        }
        return null;
      } catch {
        return null;
      }
    },
  };
}
