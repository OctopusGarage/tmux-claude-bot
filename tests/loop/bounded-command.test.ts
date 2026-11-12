import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LoopRunCommandInvocation } from "../../src/core/loop/run.js";
import { runShellCommand } from "../../src/core/loop/service.js";

const directories: string[] = [];
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
function fixture() {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "tcb-bounded-command-")));
  directories.push(cwd);
  return cwd;
}
function run(cwd: string, command: string, timeoutMs?: number) {
  const invocation: LoopRunCommandInvocation & { timeoutMs?: number } = {
    kind: "pr",
    cwd,
    command,
    env: { TCB_COMMAND_FIXTURE: "quoted ' value" },
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
  return runShellCommand(invocation);
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("bounded synchronous gate commands", () => {
  it("stops the shell and its ordinary children before their late writes", async () => {
    const cwd = fixture();
    const child = join(cwd, "child.cjs");
    const parent = join(cwd, "parent.cjs");
    const marker = join(cwd, "late-marker");
    const ready = join(cwd, "child-started");
    writeFileSync(
      child,
      `require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready'); setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'late'), 1200);`,
    );
    writeFileSync(
      parent,
      `require('node:child_process').spawn(process.execPath, [${JSON.stringify(child)}], {stdio: 'inherit'}); setTimeout(() => {}, 2000);`,
    );
    const startedAt = Date.now();
    const result = run(cwd, `${quote(process.execPath)} ${quote(parent)}`, 500);
    expect(result.status).toBe(124);
    expect(result.stderr).toContain("timed out");
    expect(Date.now() - startedAt).toBeLessThan(1600);
    expect(existsSync(ready)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1400));
    expect(existsSync(marker)).toBe(false);
  });

  it("preserves exact JSON output, stderr, cwd, environment and shell quoting", () => {
    const cwd = fixture();
    const script = join(cwd, "script with space.cjs");
    writeFileSync(
      script,
      `process.stdout.write(JSON.stringify({cwd: process.cwd(), value: process.env.TCB_COMMAND_FIXTURE, arg: process.argv[2]})); process.stderr.write('diagnostic\\n'); process.exitCode = 7;`,
    );
    const result = run(
      cwd,
      `${quote(process.execPath)} ${quote(script)} ${quote("literal $(never) ' value")}`,
      3000,
    );
    expect(result).toEqual({
      status: 7,
      stdout: JSON.stringify({ cwd, value: "quoted ' value", arg: "literal $(never) ' value" }),
      stderr: "diagnostic\n",
    });
  });

  it("bounds captured output and stops the producing process", async () => {
    const cwd = fixture();
    const script = join(cwd, "excess-output.cjs");
    const marker = join(cwd, "late-output-marker");
    writeFileSync(
      script,
      `process.stdout.write(Buffer.alloc(5 * 1024 * 1024, 'x')); setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'late'), 800);`,
    );
    const result = run(cwd, `${quote(process.execPath)} ${quote(script)}`, 3000);
    expect(result.status).toBe(125);
    expect(result.stderr).toContain("output limit exceeded");
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(4 * 1024 * 1024);
    await new Promise((resolve) => setTimeout(resolve, 950));
    expect(existsSync(marker)).toBe(false);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid budget %s before spawning",
    (budget) => {
      const cwd = fixture();
      const marker = join(cwd, "spawned");
      const result = run(cwd, `printf started > ${quote(marker)}`, budget);
      expect(result.status).toBe(124);
      expect(existsSync(marker)).toBe(false);
    },
  );

  it("keeps native commands without a budget unchanged", () => {
    const cwd = fixture();
    const marker = join(cwd, "native");
    expect(run(cwd, `printf native > ${quote(marker)}`).status).toBe(0);
    expect(readFileSync(marker, "utf8")).toBe("native");
  });
});
