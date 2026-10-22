import { execFile as execFileCb } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFile = promisify(execFileCb);
const script = join(process.cwd(), "scripts", "loop-security-risk-assess.mjs");

async function runAssessment(project: string, path: string) {
  try {
    const result = await execFile(process.execPath, [script], {
      env: { ...process.env, LOOP_PROJECT_PATH: project, PATH: path },
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as Error & { code?: number | string; stdout?: string; stderr?: string };
    return {
      code: typeof failure.code === "number" ? failure.code : -1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

describe("loop security risk assessment script", () => {
  it("uses the project virtualenv pip-audit without requiring it on PATH", async () => {
    const project = mkdtempSync(join(tmpdir(), "tcb-security-python-"));
    try {
      writeFileSync(join(project, "pyproject.toml"), "[project]\nname='fixture'\nversion='0'\n");
      const bin = join(project, ".venv", "bin");
      mkdirSync(bin, { recursive: true });
      const pipAudit = join(bin, "pip-audit");
      writeFileSync(
        pipAudit,
        '#!/bin/sh\nprintf \'[{"name":"fixture","version":"0","vulns":[]}]\\n\'\n',
      );
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

  it("reports invalid pnpm audit output as structured retryable unavailability", async () => {
    const project = mkdtempSync(join(tmpdir(), "tcb-security-pnpm-invalid-"));
    try {
      writeFileSync(join(project, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      const bin = join(project, "test-bin");
      mkdirSync(bin);
      const pnpm = join(bin, "pnpm");
      writeFileSync(pnpm, "#!/bin/sh\nprintf 'registry unavailable\\n'\nexit 1\n");
      chmodSync(pnpm, 0o755);

      const result = await execFile(process.execPath, [script], {
        env: { ...process.env, LOOP_PROJECT_PATH: project, PATH: `${bin}:/usr/bin:/bin` },
      }).catch((error: unknown) => error);

      expect(result).toMatchObject({ code: 2 });
      if (
        result === null ||
        typeof result !== "object" ||
        !("stdout" in result) ||
        typeof result.stdout !== "string"
      ) {
        throw new Error("expected failed assessment stdout");
      }
      expect(JSON.parse(result.stdout)).toMatchObject({
        failureKind: "dependency-audit-unavailable",
        retryable: true,
      });
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it.each([
    ["null", "printf 'null\\n'"],
    ["empty object", "printf '{}\\n'"],
    ["array", "printf '[]\\n'"],
    ["missing vulnerability metadata", "printf '{\"metadata\":{}}\\n'"],
    ["stderr-only failure", "printf 'registry unavailable\\n' >&2; exit 1"],
    ["signal failure", "kill -TERM $$"],
  ])("classifies pnpm %s output as dependency-audit unavailability", async (_name, body) => {
    const project = mkdtempSync(join(tmpdir(), "tcb-security-pnpm-shape-"));
    try {
      writeFileSync(join(project, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      const bin = join(project, "test-bin");
      mkdirSync(bin);
      const pnpm = join(bin, "pnpm");
      writeFileSync(pnpm, `#!/bin/sh\n${body}\n`);
      chmodSync(pnpm, 0o755);

      const result = await runAssessment(project, `${bin}:/usr/bin:/bin`);

      expect(result.code).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({
        failureKind: "dependency-audit-unavailable",
        retryable: true,
        findings: [],
      });
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("classifies a missing pnpm executable as dependency-audit unavailability", async () => {
    const project = mkdtempSync(join(tmpdir(), "tcb-security-pnpm-missing-"));
    try {
      writeFileSync(join(project, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      const emptyPath = join(project, "empty-bin");
      mkdirSync(emptyPath);

      const result = await runAssessment(project, emptyPath);

      expect(result.code).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({
        failureKind: "dependency-audit-unavailable",
        retryable: true,
      });
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("preserves valid pnpm vulnerability output from a nonzero audit exit", async () => {
    const project = mkdtempSync(join(tmpdir(), "tcb-security-pnpm-vulnerable-"));
    try {
      writeFileSync(join(project, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      const bin = join(project, "test-bin");
      mkdirSync(bin);
      const pnpm = join(bin, "pnpm");
      writeFileSync(
        pnpm,
        '#!/bin/sh\nprintf \'{"metadata":{"vulnerabilities":{"low":0,"moderate":0,"high":1,"critical":0}}}\\n\'\nprintf \'vulnerabilities found\\n\' >&2\nexit 1\n',
      );
      chmodSync(pnpm, 0o755);

      const result = await runAssessment(project, `${bin}:/usr/bin:/bin`);

      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        riskScore: 85,
        critical: false,
        findings: ["pnpm audit reports 1 high vulnerability(s)"],
      });
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("requires Python dependency audit metadata", async () => {
    const project = mkdtempSync(join(tmpdir(), "tcb-security-python-shape-"));
    try {
      writeFileSync(join(project, "pyproject.toml"), "[project]\nname='fixture'\nversion='0'\n");
      const bin = join(project, ".venv", "bin");
      mkdirSync(bin, { recursive: true });
      const pipAudit = join(bin, "pip-audit");
      writeFileSync(pipAudit, "#!/bin/sh\nprintf '[{}]\\n'\n");
      chmodSync(pipAudit, 0o755);

      const result = await runAssessment(project, "/usr/bin:/bin");

      expect(result.code).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({
        failureKind: "dependency-audit-unavailable",
        retryable: true,
      });
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("preserves valid Python vulnerability output from a nonzero audit exit", async () => {
    const project = mkdtempSync(join(tmpdir(), "tcb-security-python-vulnerable-"));
    try {
      writeFileSync(join(project, "pyproject.toml"), "[project]\nname='fixture'\nversion='0'\n");
      const bin = join(project, ".venv", "bin");
      mkdirSync(bin, { recursive: true });
      const pipAudit = join(bin, "pip-audit");
      writeFileSync(
        pipAudit,
        '#!/bin/sh\nprintf \'[{"name":"dep","version":"1.0.0","vulns":[{"id":"CVE-TEST"}]}]\\n\'\nexit 1\n',
      );
      chmodSync(pipAudit, 0o755);

      const result = await runAssessment(project, "/usr/bin:/bin");

      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        riskScore: 85,
        findings: ["CVE-TEST"],
      });
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});
