import { execFile as execFileCb, execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFile = promisify(execFileCb);
const root = process.cwd();
const pnpm = execFileSync("which", ["pnpm"], { encoding: "utf8" }).trim();
const cleanReport = JSON.stringify({
  advisories: {},
  metadata: { vulnerabilities: { low: 0, moderate: 0, high: 0, critical: 0 } },
});

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
    // Mock only the registry response; resolve and verify the real installed patch.
    const quotedPnpm = `'${pnpm.replaceAll("'", "'\\''")}'`;
    writeExecutable(
      join(dir, "pnpm"),
      `#!/bin/sh\nif [ "$1" = "list" ]; then exec ${quotedPnpm} "$@"; fi\n${fakePnpm}`,
    );
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
echo '${cleanReport}'
exit 0
`);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("0 unremediated finding(s)");
    expect(result.stderr).toBe("");
  });

  it("fails closed when the audit registry returns invalid JSON", async () => {
    const result = await runAuditScript(`#!/bin/sh
echo "pnpm warn audit invalid json response body at https://registry.npmjs.org/-/npm/v1/security/advisories/bulk reason: Unexpected token" >&2
echo "pnpm error audit endpoint returned an error" >&2
exit 1
`);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Invalid pnpm audit response");
  });

  it("runs pnpm audit without unrelated inherited environment values", async () => {
    const result = await runAuditScript(
      `#!/bin/sh
if [ "\${TCB_AUDIT_SECRET_SHOULD_NOT_LEAK:-}" = "present" ]; then
  echo "secret leaked into pnpm audit environment" >&2
  exit 42
fi
echo '${cleanReport}'
exit 0
`,
      { TCB_AUDIT_SECRET_SHOULD_NOT_LEAK: "present" },
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("tilde-collapses home paths from pnpm audit output", async () => {
    const result = await runAuditScript(`#!/bin/sh
echo "pnpm error log: $HOME/.local/share/pnpm/audit.log"
exit 1
`);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("~/.local/share/pnpm/audit.log");
    expect(result.stderr).not.toContain(`${process.env.HOME}/.local/share/pnpm`);
  });

  it("still fails when pnpm audit reports a real vulnerability", async () => {
    const result = await runAuditScript(`#!/bin/sh
echo '${JSON.stringify({
      advisories: {
        new: {
          github_advisory_id: "GHSA-unrelated",
          module_name: "another-package",
          severity: "high",
        },
      },
      metadata: { vulnerabilities: { low: 0, moderate: 0, high: 1, critical: 0 } },
    })}'
exit 1
`);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("1 unremediated finding(s)");
    expect(result.stdout).toContain("GHSA-unrelated");
  });
});
