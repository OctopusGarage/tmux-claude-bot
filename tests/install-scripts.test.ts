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

async function runNodePreflight(version: string): Promise<{ code: number; output: string }> {
  const root = await mkdtemp(nodePath.join(tmpdir(), "tcb-node-preflight-"));
  const bin = nodePath.join(root, "bin");
  const node = nodePath.join(bin, "node");
  mkdirSync(bin, { recursive: true });
  writeExecutable(node, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`);

  try {
    const result = await execFile(nodePath.join(ROOT, "scripts", "verify-node.sh"), [], {
      cwd: ROOT,
      env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` },
    });
    return { code: 0, output: `${result.stdout}${result.stderr}` };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failure.code === "number" ? failure.code : 1,
      output: `${failure.stdout ?? ""}${failure.stderr ?? ""}`,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
  it("keeps the Biome schema aligned with the pinned CLI", async () => {
    const result = await execFile(nodePath.join(ROOT, "scripts", "verify-biome-schema.sh"), [], {
      cwd: ROOT,
    });
    expect(`${result.stdout}${result.stderr}`).toContain("Biome schema version ok: 2.5.14");

    const fixture = await mkdtemp(nodePath.join(tmpdir(), "tcb-biome-schema-"));
    try {
      mkdirSync(nodePath.join(fixture, "scripts"), { recursive: true });
      mkdirSync(nodePath.join(fixture, "node_modules", ".bin"), { recursive: true });
      copyFileSync(
        nodePath.join(ROOT, "scripts", "verify-biome-schema.sh"),
        nodePath.join(fixture, "scripts", "verify-biome-schema.sh"),
      );
      writeExecutable(
        nodePath.join(fixture, "node_modules", ".bin", "biome"),
        "#!/bin/sh\nprintf 'Version: 2.5.14\\n'\n",
      );
      writeFileSync(
        nodePath.join(fixture, "biome.json"),
        '{"$schema":"https://biomejs.dev/schemas/2.5.13/schema.json"}\n',
      );

      await expect(
        execFile(nodePath.join(fixture, "scripts", "verify-biome-schema.sh"), [], {
          cwd: fixture,
        }),
      ).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining("CLI=2.5.14 schema=2.5.13"),
      });
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }

    const verifyScript = readFileSync(nodePath.join(ROOT, "scripts", "verify-local.sh"), "utf8");
    expect(verifyScript.indexOf("run scripts/verify-biome-schema.sh")).toBeLessThan(
      verifyScript.indexOf("run pnpm lint"),
    );
  });

  it("requires Node.js 22 or newer before local verification", async () => {
    const unsupported = await runNodePreflight("v21.9.0");
    expect(unsupported.code).not.toBe(0);
    expect(unsupported.output).toContain("Node.js 22+");

    const supported = await runNodePreflight("v22.0.0");
    expect(supported.code).toBe(0);
    expect(supported.output).toContain("v22.0.0");

    const verifyScript = readFileSync(nodePath.join(ROOT, "scripts", "verify-local.sh"), "utf8");
    expect(verifyScript.indexOf("run scripts/verify-node.sh")).toBeLessThan(
      verifyScript.indexOf("run pnpm lint"),
    );
  });

  it("keeps the global CLI launcher aligned with the active dev or production service", async () => {
    const home = await mkdtemp(nodePath.join(tmpdir(), "tcb-cli-launcher-"));
    const installedHome = nodePath.join(home, "installed");
    const launcherInstaller = nodePath.join(ROOT, "scripts", "install-cli-launchers.sh");
    try {
      await execFile(launcherInstaller, ["--dev"], {
        env: { ...process.env, HOME: home, TMUX_CLAUDE_BOT_DIR: installedHome },
      });
      const launcherPath = nodePath.join(home, ".local", "bin", "tmux-claude-bot");
      const devLauncher = readFileSync(launcherPath, "utf8");
      expect(devLauncher).toContain(`export TCB_STATE_DIR="${installedHome}/state"`);
      expect(devLauncher).toContain(`${ROOT}/node_modules/.bin/tsx`);
      expect(devLauncher).toContain(`${ROOT}/src/cli.ts`);
      expect(devLauncher).toContain(
        `exec "${ROOT}/node_modules/.bin/tsx" "${ROOT}/src/cli.ts" "$@"`,
      );
      expect(devLauncher).not.toContain(`node" "${ROOT}/node_modules/.bin/tsx"`);

      await execFile(launcherInstaller, [], { env: { ...process.env, HOME: home } });
      const productionLauncher = readFileSync(launcherPath, "utf8");
      expect(productionLauncher).toContain(`export TCB_STATE_DIR="${ROOT}/state"`);
      expect(productionLauncher).toContain(`${ROOT}/dist/cli.js`);
      expect(productionLauncher).not.toContain("src/cli.ts");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("refreshes CLI launchers whenever the managed service mode changes", () => {
    const installScript = readFileSync(nodePath.join(ROOT, "install.sh"), "utf8");
    const launchdInstaller = readFileSync(
      nodePath.join(ROOT, "scripts", "install-launchd.sh"),
      "utf8",
    );
    const systemdInstaller = readFileSync(
      nodePath.join(ROOT, "scripts", "install-systemd.sh"),
      "utf8",
    );

    expect(installScript).toContain("scripts/install-cli-launchers.sh");
    for (const serviceInstaller of [launchdInstaller, systemdInstaller]) {
      expect(serviceInstaller).toContain("install-cli-launchers.sh");
      expect(serviceInstaller).toContain('LAUNCHER_ARGS=("--dev")');
    }
  });

  it("runs package-bin shell shims directly from dev entrypoints", () => {
    const devLaunchdWrapper = readFileSync(
      nodePath.join(ROOT, "scripts", "dev-launchd-wrapper.sh"),
      "utf8",
    );
    const devSystemdWrapper = readFileSync(
      nodePath.join(ROOT, "scripts", "dev-systemd-wrapper.sh"),
      "utf8",
    );
    const devSupervisor = readFileSync(
      nodePath.join(ROOT, "src/scripts/dev-supervisor.ts"),
      "utf8",
    );

    for (const wrapper of [devLaunchdWrapper, devSystemdWrapper]) {
      expect(wrapper).toContain('exec "$REPO_DIR/node_modules/.bin/tsx"');
      expect(wrapper).not.toContain('exec "$NODE_BIN" "$REPO_DIR/node_modules/.bin/tsx"');
    }
    expect(devSupervisor).not.toContain(
      'spawn(process.execPath, [join(repo, "node_modules/.bin/tsx")',
    );
    expect(devSupervisor).not.toContain(
      'spawn(process.execPath, [join(repo, "node_modules/.bin/tsc")',
    );
    expect(devSupervisor).toContain('spawn(join(repo, "node_modules/.bin/tsx"), ["src/index.ts"]');
    expect(devSupervisor).toContain('spawn(join(repo, "node_modules/.bin/tsc"), ["--noEmit"]');
  });

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

    expect(releaseScript).toContain("pnpm verify:local");
    expect(releaseScript).toContain("TCB_RELEASE_SKIP_VERIFY");
    expect(releaseScript.indexOf("pnpm verify:local")).toBeLessThan(
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
