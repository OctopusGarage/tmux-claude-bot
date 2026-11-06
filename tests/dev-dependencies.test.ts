import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("managed dev dependency recovery", () => {
  it.each(["missing", "healthy", "failed"])("%s dependencies", (mode) => {
    const dir = mkdtempSync(join(tmpdir(), "tcb-deps-"));
    try {
      mkdirSync(join(dir, "bin"));
      writeFileSync(
        join(dir, "bin/pnpm"),
        `#!/bin/bash
[ "$*" = "install --frozen-lockfile" ] || exit 9
printf installed > install-marker
[ "$MODE" != failed ] || exit 7
mkdir -p node_modules/.bin
printf "#!/bin/sh\nexit 0\n" > node_modules/.bin/tsx
chmod +x node_modules/.bin/tsx
cp node_modules/.bin/tsx node_modules/.bin/tsc
`,
      );
      chmodSync(join(dir, "bin/pnpm"), 0o755);
      if (mode === "healthy") {
        mkdirSync(join(dir, "node_modules/.bin"), { recursive: true });
        writeFileSync(
          join(dir, "node_modules/.bin/tsx"),
          `#!/bin/sh
exit 0
`,
        );
        chmodSync(join(dir, "node_modules/.bin/tsx"), 0o755);
        writeFileSync(join(dir, "node_modules/.bin/tsc"), "");
        chmodSync(join(dir, "node_modules/.bin/tsc"), 0o755);
      }
      const result = spawnSync(
        "/bin/bash",
        [
          "-c",
          'set -euo pipefail; . "$1"; tcb_ensure_dev_dependencies "$2"; printf ready',
          "bash",
          join(process.cwd(), "scripts/ensure-dev-dependencies.sh"),
          dir,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            MODE: mode,
            NODE_BIN: join(dir, "bin/node"),
            PATH: `${join(dir, "bin")}:${process.env.PATH}`,
          },
        },
      );
      expect(result.status, result.stderr).toBe(mode === "failed" ? 7 : 0);
      expect(result.stdout.includes("ready")).toBe(mode !== "failed");
      if (mode !== "healthy")
        expect(readFileSync(join(dir, "install-marker"), "utf8")).toBe("installed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it.each(["dev-launchd-wrapper.sh", "dev-systemd-wrapper.sh"])("%s checks before exec", (name) => {
    const source = readFileSync(join(process.cwd(), "scripts", name), "utf8");
    expect(source.indexOf('tcb_ensure_dev_dependencies "$REPO_DIR"')).toBeGreaterThan(
      source.indexOf("tcb_sanitize_inherited_environment"),
    );
    expect(source.indexOf('tcb_ensure_dev_dependencies "$REPO_DIR"')).toBeLessThan(
      source.lastIndexOf("\nexec "),
    );
  });
});
