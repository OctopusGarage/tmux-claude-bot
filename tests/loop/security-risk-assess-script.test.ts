import { execFile as execFileCb } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFile = promisify(execFileCb);
const script = join(process.cwd(), "scripts", "loop-security-risk-assess.mjs");

describe("loop security risk assessment script", () => {
  it("uses the project virtualenv pip-audit without requiring it on PATH", async () => {
    const project = mkdtempSync(join(tmpdir(), "tcb-security-python-"));
    try {
      writeFileSync(join(project, "pyproject.toml"), "[project]\nname='fixture'\nversion='0'\n");
      const bin = join(project, ".venv", "bin");
      mkdirSync(bin, { recursive: true });
      const pipAudit = join(bin, "pip-audit");
      writeFileSync(pipAudit, "#!/bin/sh\nprintf '[{\"vulns\":[]}]\\n'\n");
      chmodSync(pipAudit, 0o755);

      const result = await execFile(process.execPath, [script], {
        env: { ...process.env, LOOP_PROJECT_PATH: project, PATH: "/usr/bin:/bin" },
      });

      expect(JSON.parse(result.stdout)).toMatchObject({ riskScore: 0, findings: [] });
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("assesses a pnpm lockfile with pnpm audit", async () => {
    const project = mkdtempSync(join(tmpdir(), "tcb-security-pnpm-"));
    try {
      writeFileSync(join(project, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      const bin = join(project, "test-bin");
      mkdirSync(bin);
      const pnpm = join(bin, "pnpm");
      writeFileSync(
        pnpm,
        '#!/bin/sh\nprintf \'{"metadata":{"vulnerabilities":{"low":0,"moderate":0,"high":0,"critical":0}}}\\n\'\n',
      );
      chmodSync(pnpm, 0o755);

      const result = await execFile(process.execPath, [script], {
        env: { ...process.env, LOOP_PROJECT_PATH: project, PATH: `${bin}:/usr/bin:/bin` },
      });

      expect(JSON.parse(result.stdout)).toMatchObject({ riskScore: 0, findings: [] });
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});
