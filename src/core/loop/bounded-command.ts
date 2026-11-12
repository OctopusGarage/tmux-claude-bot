import { spawnSync } from "node:child_process";
import type { LoopRunCommandInvocation, LoopRunCommandResult } from "./run.js";

// The host API is synchronous. A separate event loop owns the deadline and the
// shell process group, so terminating the shell also stops ordinary descendants.
const WATCHDOG = `
const { spawn } = require('node:child_process');
const input = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
const remaining = input.expiresAt - Date.now();
const output = { stdout: [], stderr: [] };
let size = 0, settled = false, stopStatus, diagnostic = '', timer, cleanup;
const finish = (status) => {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  clearTimeout(cleanup);
  const result = { status: stopStatus ?? status,
    stdout: Buffer.concat(output.stdout).toString('base64'),
    stderr: Buffer.concat(output.stderr).toString('base64'), diagnostic };
  process.stdout.write(JSON.stringify(result), () => process.exit(0));
};
if (remaining <= 0) {
  stopStatus = 124; diagnostic = 'Gate command timed out before launch'; finish(124);
} else {
  const child = spawn('sh', ['-lc', input.command], {
    cwd: input.cwd, env: process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  const kill = () => {
    if (child.pid === undefined) return;
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') { stopStatus = 1; diagnostic = 'Gate command group stop failed'; } }
  };
  const stop = (status, message) => {
    if (stopStatus !== undefined) return;
    stopStatus = status; diagnostic = message; kill();
    cleanup = setTimeout(() => {
      child.stdout.destroy(); child.stderr.destroy(); finish(status);
    }, 1000);
  };
  for (const stream of ['stdout', 'stderr']) child[stream].on('data', chunk => {
    size += chunk.length;
    if (size > 4 * 1024 * 1024) stop(125, 'Gate command output limit exceeded');
    else output[stream].push(chunk);
  });
  child.on('error', () => { diagnostic = 'Gate command could not start'; finish(1); });
  child.on('close', status => { kill(); finish(status ?? 1); });
  timer = setTimeout(() => stop(124, 'Gate command timed out'), Math.min(remaining, 2147483647));
}
`;

export function runBoundedShellCommand(
  invocation: LoopRunCommandInvocation & { timeoutMs: number },
): LoopRunCommandResult {
  if (!Number.isFinite(invocation.timeoutMs) || invocation.timeoutMs <= 0)
    return { status: 124, stdout: "", stderr: "Gate command has no remaining execution budget" };
  const result = spawnSync(process.execPath, ["--input-type=commonjs", "-e", WATCHDOG], {
    input: JSON.stringify({
      command: invocation.command,
      cwd: invocation.cwd,
      expiresAt: Date.now() + invocation.timeoutMs,
    }),
    env: { ...process.env, ...invocation.env },
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0 || result.error !== undefined)
    return { status: 1, stdout: "", stderr: "Gate command watchdog failed" };
  try {
    const output = JSON.parse(result.stdout) as {
      status: number;
      stdout: string;
      stderr: string;
      diagnostic: string;
    };
    const stderr = Buffer.from(output.stderr, "base64").toString();
    return {
      status: output.status,
      stdout: Buffer.from(output.stdout, "base64").toString(),
      stderr: output.diagnostic
        ? `${stderr}${stderr && !stderr.endsWith("\n") ? "\n" : ""}${output.diagnostic}`
        : stderr,
    };
  } catch {
    return { status: 1, stdout: "", stderr: "Gate command watchdog returned invalid output" };
  }
}
