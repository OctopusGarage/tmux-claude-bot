import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const script = resolve("scripts/git-worktree-config-guard.sh");

describe("git worktree config guard", () => {
  it("clears hook-exported git environment before nested commands run", () => {
    const result = spawnSync(
      "sh",
      [
        "-c",
        `. "${script}"; install_git_worktree_config_guard; env | grep -E '^(GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE)=' || true`,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_DIR: "/outer/.git",
          GIT_WORK_TREE: "/outer",
          GIT_INDEX_FILE: "/outer/.git/index",
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("records hook-exported git environment before and after sanitization", () => {
    const dir = mkdtempSync(join(tmpdir(), "tcb-git-env-trace-"));
    const traceFile = join(dir, "trace.log");
    try {
      const result = spawnSync(
        "sh",
        [
          "-c",
          [
            "git init -q",
            `. "${script}"`,
            "install_git_worktree_config_guard",
            'git_worktree_config_checkpoint "test:after-install"',
          ].join("; "),
        ],
        {
          cwd: dir,
          encoding: "utf8",
          env: {
            ...process.env,
            GIT_DIR: "/outer/.git",
            GIT_WORK_TREE: "/outer",
            GIT_INDEX_FILE: "/outer/.git/index",
            TCB_GIT_CONFIG_TRACE_FILE: traceFile,
          },
        },
      );

      expect(result.status).toBe(0);
      const trace = readFileSync(traceFile, "utf8");
      expect(trace).toContain("stage=guard:enter");
      expect(trace).toContain("env_GIT_DIR=/outer/.git");
      expect(trace).toContain("stage=guard:after-unset-env");
      expect(trace).toMatch(/stage=guard:after-unset-env .*env_GIT_DIR= /);
      expect(trace).toContain("stage=test:after-install");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lets nested git repositories discover their own worktree after sanitizing hook env", () => {
    const dir = mkdtempSync(join(tmpdir(), "tcb-git-env-"));
    try {
      const result = spawnSync(
        "sh",
        [
          "-c",
          [
            `. "${script}"`,
            "install_git_worktree_config_guard",
            "git init -q",
            "git config --get core.bare",
            "git rev-parse --show-toplevel",
          ].join("; "),
        ],
        {
          cwd: dir,
          encoding: "utf8",
          env: {
            ...process.env,
            GIT_DIR: "/outer/.git",
            GIT_WORK_TREE: "/outer",
          },
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout.split("\n")).toContain("false");
      expect(result.stdout.split("\n")).toContain(realpathSync(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records and restores an existing bare=true worktree config", () => {
    const dir = mkdtempSync(join(tmpdir(), "tcb-git-bare-trace-"));
    const traceFile = join(dir, "trace.log");
    try {
      const result = spawnSync(
        "sh",
        [
          "-c",
          [
            "git init -q",
            "git config core.bare true",
            `. "${script}"`,
            "install_git_worktree_config_guard",
            "git config --get core.bare",
          ].join("; "),
        ],
        {
          cwd: dir,
          encoding: "utf8",
          env: {
            ...process.env,
            TCB_GIT_CONFIG_TRACE_FILE: traceFile,
          },
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout.split("\n")).toContain("false");
      const trace = readFileSync(traceFile, "utf8");
      expect(trace).toMatch(/stage=guard:enter .*bare=true/);
      expect(trace).toMatch(/stage=guard:after-restore .*bare=false/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
