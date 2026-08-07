import { execFile as execFileCb } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFile = promisify(execFileCb);

const ROOT = process.cwd();

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o755 });
}

async function runInstallScript(scriptName: string): Promise<{ root: string; uvLog: string }> {
  const root = await mkdtemp(nodePath.join(tmpdir(), "tcb-install-script-"));
  mkdirSync(nodePath.join(root, "scripts"), { recursive: true });
  mkdirSync(nodePath.join(root, ".venv", "bin"), { recursive: true });
  mkdirSync(nodePath.join(root, "bin"), { recursive: true });

  copyFileSync(
    nodePath.join(ROOT, "scripts", scriptName),
    nodePath.join(root, "scripts", scriptName),
  );
  writeExecutable(
    nodePath.join(root, ".venv", "bin", "python"),
    "#!/bin/sh\ncat >/dev/null\nexit 0\n",
  );
  writeExecutable(nodePath.join(root, ".venv", "bin", "mlx_whisper"), "#!/bin/sh\nexit 0\n");
  writeExecutable(
    nodePath.join(root, "bin", "uname"),
    `#!/bin/sh
case "$1" in
  -s) echo Darwin ;;
  -m) echo arm64 ;;
  *) /usr/bin/uname "$@" ;;
esac
`,
  );
  writeExecutable(
    nodePath.join(root, "bin", "uv"),
    `#!/bin/sh
printf '%s\n' "$*" >> "$UV_LOG"
if [ "\${1:-}" = "venv" ]; then
  printf 'venv-called\n' >> "$UV_LOG"
  rm -rf "$TEST_PROJECT_DIR/.venv"
  exit 99
fi
exit 0
`,
  );

  const env = {
    ...process.env,
    PATH: `${nodePath.join(root, "bin")}:${process.env.PATH ?? ""}`,
    TEST_PROJECT_DIR: root,
    UV_LOG: nodePath.join(root, "uv.log"),
  };
  await execFile(nodePath.join(root, "scripts", scriptName), [], { cwd: root, env });
  return { root, uvLog: readFileSync(nodePath.join(root, "uv.log"), "utf8") };
}

describe("install scripts preserve an existing shared venv", () => {
  it.each([
    ["install-argos-translate.sh", "translation"],
    ["install-whisper.sh", "voice"],
  ])("does not recreate the venv when %s runs with an existing %s install", async (scriptName) => {
    const { root, uvLog } = await runInstallScript(scriptName);
    try {
      expect(uvLog).not.toContain("venv-called");
      expect(existsSync(nodePath.join(root, ".venv", "bin", "mlx_whisper"))).toBe(true);
      expect(existsSync(nodePath.join(root, ".venv", "bin", "python"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("managed install and release script contracts", () => {
  it("keeps managed install isolated while refreshing MCP profile descriptors", () => {
    const installScript = readFileSync(nodePath.join(ROOT, "install.sh"), "utf8");

    expect(installScript).toContain("node dist/cli.js ai-tools install");
    expect(installScript).not.toContain("node dist/cli.js skill install --scope operator-home");
    expect(installScript).not.toContain("node dist/cli.js skill install --scope global");
    expect(installScript).not.toContain("TCB_SKIP_SKILL");
    expect(installScript).not.toContain("node dist/cli.js mcp install");
    expect(installScript).toContain("TCB_SKIP_AI_TOOLS");
    expect(installScript).toContain("TCB_SKIP_MCP");
    expect(installScript).toContain("optional global copy: tcb skill install --scope global");
  });

  it("documents global skill installation as explicit operator opt-in", () => {
    const installGuide = readFileSync(nodePath.join(ROOT, "INSTALL.md"), "utf8");
    const manual = readFileSync(nodePath.join(ROOT, "docs", "manual.md"), "utf8");
    const governance = readFileSync(
      nodePath.join(ROOT, "docs", "ai-tool-surface-governance.md"),
      "utf8",
    );

    for (const text of [installGuide, manual, governance]) {
      expect(text).toContain("tcb skill install");
    }
    expect(manual).toMatch(/Global Claude\/Codex\s+skill installation is explicit/);
    expect(manual).not.toContain("The installer runs `tcb skill install` by default");
    expect(manual).not.toContain("TCB_SKIP_SKILL");
    expect(governance).toContain(
      "Managed install must publish it only into the operator workspace",
    );
    expect(governance).toContain("Global publication requires `tcb skill install --scope global`");
  });

  it("keeps release tagging behind local verification", () => {
    const releaseScript = readFileSync(nodePath.join(ROOT, "scripts", "release.sh"), "utf8");

    expect(releaseScript).toContain("npm run verify:local");
    expect(releaseScript).toContain("TCB_RELEASE_SKIP_VERIFY");
    expect(releaseScript.indexOf("npm run verify:local")).toBeLessThan(
      releaseScript.indexOf("npm version"),
    );
  });

  it("keeps local verification guarded against git worktree config corruption", () => {
    const verifyScript = readFileSync(nodePath.join(ROOT, "scripts", "verify-local.sh"), "utf8");

    expect(verifyScript).toContain("git-worktree-config-guard.sh");
    expect(verifyScript).toContain("install_git_worktree_config_guard");
    expect(verifyScript).toContain('git_worktree_config_checkpoint "verify-local:before:$*"');
    expect(verifyScript).toContain(
      'git_worktree_config_checkpoint "verify-local:after:$*:status=$status"',
    );
  });

  it("keeps root convenience scripts strict and repo-relative", () => {
    for (const scriptName of ["rebuild.sh", "start.sh"]) {
      const script = readFileSync(nodePath.join(ROOT, scriptName), "utf8");

      expect(script).toContain("set -euo pipefail");
      expect(script).toContain('cd "$(dirname "$0")"');
    }
  });
});
