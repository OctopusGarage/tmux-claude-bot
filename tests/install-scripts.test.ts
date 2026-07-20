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
