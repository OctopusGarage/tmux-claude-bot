import { execFile as execFileCb } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFile = promisify(execFileCb);
const root = process.cwd();

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o755 });
}

async function runAuditScript(fakeNpm: string): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  const dir = join(tmpdir(), `tcb-audit-${process.pid}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  try {
    writeExecutable(join(dir, "npm"), fakeNpm);
    try {
      const result = await execFile("bash", [join(root, "scripts", "audit-high.sh")], {
        cwd: root,
        env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
      });
      return { code: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (err) {
      const failed = err as { code?: number; stdout?: string; stderr?: string };
      return {
        code: failed.code ?? 1,
        stdout: failed.stdout ?? "",
        stderr: failed.stderr ?? "",
      };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("scripts/audit-high.sh", () => {
  it("passes through a clean npm audit", async () => {
    const result = await runAuditScript(`#!/bin/sh
echo "found 0 vulnerabilities"
exit 0
`);

    expect(result).toEqual({
      code: 0,
      stdout: "found 0 vulnerabilities\n",
      stderr: "",
    });
  });

  it("does not fail local verification for invalid npm audit endpoint JSON", async () => {
    const result = await runAuditScript(`#!/bin/sh
echo "npm warn audit invalid json response body at https://registry.npmjs.org/-/npm/v1/security/advisories/bulk reason: Unexpected token" >&2
echo "npm error audit endpoint returned an error" >&2
exit 1
`);

    expect(result.code).toBe(0);
    expect(result.stderr).toContain("external audit service failure");
  });

  it("still fails when npm audit reports a real vulnerability", async () => {
    const result = await runAuditScript(`#!/bin/sh
echo "1 high severity vulnerability"
exit 1
`);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("1 high severity vulnerability");
    expect(result.stderr).not.toContain("external audit service failure");
  });
});
