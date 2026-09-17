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

async function runAuditScript(
  fakePnpm: string,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  const dir = join(tmpdir(), `tcb-audit-${process.pid}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  try {
    writeExecutable(join(dir, "pnpm"), fakePnpm);
    try {
      const result = await execFile("bash", [join(root, "scripts", "audit-high.sh")], {
        cwd: root,
        env: {
          ...process.env,
          ...extraEnv,
          PATH: `${dir}:${process.env.PATH ?? ""}`,
        },
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
  it("passes through a clean pnpm audit", async () => {
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

  it("does not fail local verification for invalid pnpm audit endpoint JSON", async () => {
    const result = await runAuditScript(`#!/bin/sh
echo "pnpm warn audit invalid json response body at https://registry.npmjs.org/-/npm/v1/security/advisories/bulk reason: Unexpected token" >&2
echo "pnpm error audit endpoint returned an error" >&2
exit 1
`);

    expect(result.code).toBe(0);
    expect(result.stderr).toContain("external audit service failure");
  });

  it("runs pnpm audit without unrelated inherited environment values", async () => {
    const result = await runAuditScript(
      `#!/bin/sh
if [ "\${TCB_AUDIT_SECRET_SHOULD_NOT_LEAK:-}" = "present" ]; then
  echo "secret leaked into pnpm audit environment" >&2
  exit 42
fi
echo "environment sanitized"
exit 0
`,
      { TCB_AUDIT_SECRET_SHOULD_NOT_LEAK: "present" },
    );

    expect(result).toEqual({
      code: 0,
      stdout: "environment sanitized\n",
      stderr: "",
    });
  });

  it("tilde-collapses home paths from pnpm audit output", async () => {
    const result = await runAuditScript(`#!/bin/sh
echo "pnpm error log: $HOME/.local/share/pnpm/audit.log"
exit 1
`);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("~/.local/share/pnpm/audit.log");
    expect(result.stdout).not.toContain(`${process.env.HOME}/.local/share/pnpm`);
  });

  it("still fails when pnpm audit reports a real vulnerability", async () => {
    const result = await runAuditScript(`#!/bin/sh
echo "1 high severity vulnerability"
exit 1
`);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("1 high severity vulnerability");
    expect(result.stderr).not.toContain("external audit service failure");
  });
});
