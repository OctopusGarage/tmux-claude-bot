import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const helper = join(root, "scripts", "sanitize-service-environment.sh");
const wrappers = [
  "launchd-wrapper.sh",
  "dev-launchd-wrapper.sh",
  "systemd-wrapper.sh",
  "dev-systemd-wrapper.sh",
];

describe("managed-service environment isolation", () => {
  it("removes inherited credential-shaped variables while preserving ordinary environment", () => {
    const result = spawnSync(
      "/bin/bash",
      ["-c", '. "$1"; tcb_sanitize_inherited_environment; env', "bash", helper],
      {
        encoding: "utf8",
        env: {
          HOME: "/tmp/service-home",
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          LANG: "en_US.UTF-8",
          SSH_AUTH_SOCK: "/tmp/agent.sock",
          PROJECT_TOKEN: "remove",
          mixed_case_Secret: "remove",
          DATABASE_PASSWORD: "remove",
          LEGACY_PASSWD: "remove",
          DEPLOY_CREDENTIAL: "remove",
          CLOUD_CREDENTIALS: "remove",
          WIDGET_API_KEY: "remove",
          BUILD_ACCESS_KEY: "remove",
          SIGNING_PRIVATE_KEY: "remove",
          TOKENIZER_MODE: "preserve",
          API_KEYSTONE: "preserve",
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    const environment = new Map(
      result.stdout
        .trim()
        .split("\n")
        .map((line) => {
          const separator = line.indexOf("=");
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );

    for (const name of [
      "PROJECT_TOKEN",
      "mixed_case_Secret",
      "DATABASE_PASSWORD",
      "LEGACY_PASSWD",
      "DEPLOY_CREDENTIAL",
      "CLOUD_CREDENTIALS",
      "WIDGET_API_KEY",
      "BUILD_ACCESS_KEY",
      "SIGNING_PRIVATE_KEY",
    ]) {
      expect(environment.has(name), name).toBe(false);
    }
    expect(environment.get("HOME")).toBe("/tmp/service-home");
    expect(environment.get("PATH")).toBe(process.env.PATH ?? "/usr/bin:/bin");
    expect(environment.get("LANG")).toBe("en_US.UTF-8");
    expect(environment.get("SSH_AUTH_SOCK")).toBe("/tmp/agent.sock");
    expect(environment.get("TOKENIZER_MODE")).toBe("preserve");
    expect(environment.get("API_KEYSTONE")).toBe("preserve");
  });

  it("does not invoke tr while inherited credentials are present", () => {
    const trapDirectory = mkdtempSync(join(tmpdir(), "tcb-service-env-trap-"));
    const marker = join(trapDirectory, "credential-exposed");

    try {
      const result = spawnSync(
        "/bin/bash",
        [
          "-c",
          `set -e; . "$1"; tr() { if [ "\${PROJECT_TOKEN+x}" = x ]; then : > "$TCB_TRAP_MARKER"; fi; command /usr/bin/tr "$@"; }; tcb_path_before="$PATH"; tcb_sanitize_inherited_environment; printf '%s\\n%s\\n%s\\n' "\${PROJECT_TOKEN+present}" "$tcb_path_before" "$PATH"`,
          "bash",
          helper,
        ],
        {
          encoding: "utf8",
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            PROJECT_TOKEN: "synthetic",
            TCB_TRAP_MARKER: marker,
          },
        },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(marker)).toBe(false);
      const [credentialPresence, pathBefore, pathAfter] = result.stdout.split("\n");
      expect(credentialPresence).toBe("");
      expect(pathAfter).toBe(pathBefore);
    } finally {
      rmSync(trapDirectory, { recursive: true, force: true });
    }
  });

  it("runs under Bash 3.2 nounset with empty variable-name prefix buckets", () => {
    const result = spawnSync(
      "/bin/bash",
      [
        "-c",
        `set -euo pipefail; source "$1"; tcb_sanitize_inherited_environment; [ -z "\${PROJECT_TOKEN+x}" ]`,
        "bash",
        helper,
      ],
      {
        encoding: "utf8",
        env: {
          BASH_ENV: "/dev/null",
          HOME: "/tmp",
          PATH: "/usr/bin:/bin",
          PROJECT_TOKEN: "synthetic",
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    ["disabled", "shopt -u nocasematch"],
    ["enabled", "shopt -s nocasematch"],
  ])("restores nocasematch when it starts %s", (_state, setup) => {
    const result = spawnSync(
      "/bin/bash",
      [
        "-c",
        `${setup}; . "$1"; tcb_sanitize_inherited_environment; if shopt -q nocasematch; then printf enabled; else printf disabled; fi`,
        "bash",
        helper,
      ],
      { encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(_state);
  });

  it.each(wrappers)("%s sanitizes inherited variables before runtime exec", (wrapper) => {
    const source = readFileSync(join(root, "scripts", wrapper), "utf8");
    const sourceIndex = source.indexOf('. "$SCRIPT_DIR/sanitize-service-environment.sh"');
    const sanitizeIndex = source.indexOf("tcb_sanitize_inherited_environment");
    const resolveNodeIndex = source.indexOf('. "$SCRIPT_DIR/resolve-node.sh"');
    const execIndex = source.lastIndexOf("\nexec ");

    expect(sourceIndex).toBeGreaterThan(-1);
    expect(sanitizeIndex).toBeGreaterThan(sourceIndex);
    expect(resolveNodeIndex).toBeGreaterThan(sanitizeIndex);
    for (const assignment of [
      "export TCB_STATE_DIR=",
      "export TCB_ENV_FILE=",
      "export TCB_LOG_DIR=",
    ]) {
      const assignmentIndex = source.indexOf(assignment);
      expect(assignmentIndex, assignment).toBeGreaterThan(sanitizeIndex);
    }
    expect(execIndex).toBeGreaterThan(sanitizeIndex);
  });

  it("documents sanitized inheritance and explicit dotenv override semantics in launchd", () => {
    const plist = readFileSync(join(root, "scripts", "tmux-claude-bot.plist"), "utf8");

    expect(plist).toContain("sanitized");
    expect(plist).toContain("override");
    expect(plist).not.toContain("dotenv does not");
  });
});
