import { spawn } from "node:child_process";
import type { LoopGitInvocation, LoopRunCommandInvocation, LoopRunCommandResult } from "./run.js";

const COMMAND_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

export function runRemoteBranchCommand(
  invocation: LoopRunCommandInvocation,
  timeoutMs = COMMAND_TIMEOUT_MS,
): Promise<LoopRunCommandResult> {
  return runProcess("sh", ["-lc", invocation.command], invocation.cwd, invocation.env, timeoutMs);
}

export function runRemoteBranchGit(invocation: LoopGitInvocation): Promise<LoopRunCommandResult> {
  return runProcess("git", invocation.args, invocation.cwd, {}, COMMAND_TIMEOUT_MS);
}

function runProcess(
  executable: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<LoopRunCommandResult> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd,
      env: { ...process.env, ...env },
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const finish = (result: LoopRunCommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const stop = (status: number, reason: string): void => {
      // Kill only this detached command group, including shell/token-lookup children.
      try {
        if (process.platform !== "win32" && child.pid !== undefined)
          process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // A process that exited concurrently needs no further signal.
      }
      finish({ status, stdout: "", stderr: reason });
    };
    const timer = setTimeout(() => stop(124, "remote branch command timed out"), timeoutMs);
    const collect = (chunk: Buffer, stream: "stdout" | "stderr"): void => {
      if (settled) return;
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        stop(1, "remote branch command output limit exceeded");
        return;
      }
      if (stream === "stdout") stdout.push(chunk);
      else stderr.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => collect(chunk, "stderr"));
    child.on("error", () =>
      finish({ status: 1, stdout: "", stderr: "remote branch command could not start" }),
    );
    child.on("close", (status) =>
      finish({
        status: status ?? 1,
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
      }),
    );
  });
}
