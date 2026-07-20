import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProcessIntrospector, ProcRow } from "./introspector.types.js";

type ExecFileAsync = (
  cmd: string,
  args: string[],
  opts: { timeout: number; maxBuffer?: number },
) => Promise<{ stdout: string; stderr: string }>;

/** macOS introspector backed by ps + lsof. No /proc exists here. */
export function createDarwinIntrospector(
  execFileAsync: ExecFileAsync = promisify(execFile) as ExecFileAsync,
): ProcessIntrospector {
  return {
    async snapshot(): Promise<ProcRow[]> {
      try {
        const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,command="], {
          timeout: 5000,
          maxBuffer: 8 * 1024 * 1024,
        });
        const rows: ProcRow[] = [];
        for (const line of stdout.split("\n")) {
          const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
          if (m?.[1] && m[2]) {
            rows.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] ?? "" });
          }
        }
        return rows;
      } catch {
        return [];
      }
    },
    async readProcEnv(pid: number): Promise<string> {
      try {
        const { stdout } = await execFileAsync("ps", ["eww", "-o", "command=", "-p", String(pid)], {
          timeout: 5000,
          maxBuffer: 4 * 1024 * 1024,
        });
        return stdout;
      } catch {
        return "";
      }
    },
    async listOpenFiles(pid: number): Promise<string[]> {
      try {
        const { stdout } = await execFileAsync("lsof", ["-a", "-p", String(pid), "-Fn"], {
          timeout: 5000,
        });
        return stdout
          .split("\n")
          .filter((l) => l.startsWith("n"))
          .map((l) => l.slice(1))
          .filter((p) => p.startsWith("/"));
      } catch {
        return [];
      }
    },
    async cwdOf(pid: number): Promise<string | null> {
      try {
        const { stdout } = await execFileAsync(
          "lsof",
          ["-a", "-p", String(pid), "-d", "cwd", "-Fn"],
          { timeout: 5000 },
        );
        const line = stdout.split("\n").find((l) => l.startsWith("n"));
        return line ? line.slice(1) : null;
      } catch {
        return null;
      }
    },
    async ttyOf(pid: number): Promise<string | null> {
      // stdin (fd 0) is the terminal the user was typing into for a TUI orphan.
      try {
        const { stdout } = await execFileAsync(
          "lsof",
          ["-a", "-p", String(pid), "-d", "0", "-Fn"],
          { timeout: 5000 },
        );
        const line = stdout
          .split("\n")
          .find((l) => l.startsWith("n/dev/tty") || l.startsWith("n/dev/pts/"));
        return line ? line.slice(1) : null;
      } catch {
        return null;
      }
    },
  };
}
