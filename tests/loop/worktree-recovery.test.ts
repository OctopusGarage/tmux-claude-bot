import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupLoopExecutionWorktree } from "../../src/core/loop/execution-worktree.js";
import type { LoopGitInvocation, LoopRunCommandResult } from "../../src/core/loop/run.js";
import { archiveLoopWorktree } from "../../src/core/loop/worktree-recovery.js";

const originalStateDir = process.env.TCB_STATE_DIR;
const roots: string[] = [];
const runGit = ({ cwd, args }: LoopGitInvocation): LoopRunCommandResult => {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    maxBuffer: 16 * 1024 * 1024,
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};
function git(cwd: string, ...args: string[]): string {
  const result = runGit({ cwd, args });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
function commit(cwd: string, message: string): void {
  git(
    cwd,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    message,
  );
}
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tcb-worktree-recovery-")));
  roots.push(root);
  const state = join(root, "state");
  const source = join(root, "source");
  const worktree = join(state, "loop-worktrees", "project", "run-1");
  mkdirSync(source);
  mkdirSync(state);
  process.env.TCB_STATE_DIR = state;
  git(source, "init", "-q", "-b", "main");
  writeFileSync(join(source, "source.txt"), "base\n");
  writeFileSync(
    join(source, ".gitignore"),
    "node_modules/\nbuild/\nlocal-report.json\ncoverage/\ntest-results/\nplaywright-report/\n",
  );
  git(source, "add", ".");
  commit(source, "base");
  const branch = "loop/project/run-1";
  git(source, "worktree", "add", "-q", "-b", branch, worktree);
  return { root, state, source, worktree, branch };
}
function standaloneFixture() {
  const f = fixture();
  git(f.source, "worktree", "remove", "--force", f.worktree);
  git(f.source, "clone", "--quiet", "--no-local", f.source, f.worktree);
  git(f.worktree, "checkout", "--quiet", "--detach");
  return f;
}
function sparseFile(path: string, bytes: number) {
  const fd = openSync(path, "w");
  try {
    ftruncateSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
}
function archiveRecords(state: string): Array<{ path: string; record: any }> {
  const root = join(state, "loop-worktree-archives");
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => name.endsWith(".json.gz"))
    .map((name) => ({
      path: join(root, name),
      record: JSON.parse(gunzipSync(readFileSync(join(root, name))).toString("utf8")),
    }));
}

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
  else process.env.TCB_STATE_DIR = originalStateDir;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("owned worktree recovery before removal", () => {
  it("rejects recovery whose retained Git root was removed", () => {
    const f = standaloneFixture();
    const archive = archiveLoopWorktree({ worktree: f.worktree, runGit });
    if (archive === null) throw new Error("Missing fixture recovery archive");
    const saved = JSON.parse(gunzipSync(readFileSync(archive.path)).toString());
    git(saved.objectStore, "update-ref", "-d", saved.headRef);
    expect(archive.verify()).toBe(false);
    expect(existsSync(f.worktree)).toBe(true);
  });

  it.each(["missing", "corrupt"] as const)(
    "rejects a %s persisted archive before deletion",
    (kind) => {
      const f = standaloneFixture();
      const archive = archiveLoopWorktree({ worktree: f.worktree, runGit });
      if (archive === null) throw new Error("Missing fixture recovery archive");
      if (kind === "missing") rmSync(archive.path);
      else writeFileSync(archive.path, "corrupted recovery bytes");
      expect(archive.verify()).toBe(false);
      expect(existsSync(f.worktree)).toBe(true);
    },
  );

  it("recovers unique commits, index and dirty bytes without copying generated trees or following links", () => {
    const f = fixture();
    writeFileSync(join(f.worktree, "unique.txt"), "unique commit\n");
    git(f.worktree, "add", "unique.txt");
    commit(f.worktree, "unique");
    const head = git(f.worktree, "rev-parse", "HEAD");
    writeFileSync(join(f.worktree, "source.txt"), "staged\n");
    git(f.worktree, "add", "source.txt");
    writeFileSync(join(f.worktree, "source.txt"), "unstaged\n");
    writeFileSync(join(f.worktree, "binary.bin"), Buffer.from([0, 255, 1, 2]));
    git(f.worktree, "add", "binary.bin");
    writeFileSync(join(f.worktree, "binary.bin"), Buffer.from([0, 254, 3, 4]));
    writeFileSync(join(f.worktree, "private.txt"), "private source\n");
    chmodSync(join(f.worktree, "private.txt"), 0o600);
    writeFileSync(join(f.worktree, "local-report.json"), '{"verified":false}\n');
    for (const path of ["coverage", "test-results", "playwright-report", "dist"]) {
      mkdirSync(join(f.worktree, path));
      writeFileSync(join(f.worktree, path, "evidence.json"), `${path} unique evidence`);
    }
    mkdirSync(join(f.worktree, "node_modules"));
    writeFileSync(join(f.worktree, "node_modules", "generated.bin"), "reinstallable");
    mkdirSync(join(f.worktree, "build"));
    writeFileSync(join(f.worktree, "build", "tracked.txt"), "tracked source\n");
    git(f.worktree, "add", "-f", "build/tracked.txt");
    writeFileSync(join(f.root, "outside.txt"), "outside target must not be copied");
    symlinkSync(join(f.root, "outside.txt"), join(f.worktree, "external-link"));

    expect(
      cleanupLoopExecutionWorktree({
        worktree: f.worktree,
        sourceWorktree: f.source,
        expectedBranch: f.branch,
        runGit,
      }),
    ).toBe(true);
    expect(existsSync(f.worktree)).toBe(false);
    const archived = archiveRecords(f.state).find(({ record }) => record.kind === "worktree");
    expect(archived).toBeDefined();
    const record = archived?.record;
    expect(record.head).toBe(head);
    expect(statSync(archived?.path as string).mode & 0o777).toBe(0o600);
    expect(record.files.some((file: any) => file.path.startsWith("node_modules/"))).toBe(false);
    for (const path of ["coverage", "test-results", "playwright-report", "dist"]) {
      expect(
        Buffer.from(
          record.files.find((file: any) => file.path === `${path}/evidence.json`).data,
          "base64",
        ).toString(),
      ).toBe(`${path} unique evidence`);
    }
    expect(record.files.find((file: any) => file.path === "private.txt").mode).toBe(0o600);
    expect(record.files.find((file: any) => file.path === "external-link")).toMatchObject({
      kind: "symlink",
      target: join(f.root, "outside.txt"),
    });
    expect(JSON.stringify(record)).not.toContain("outside target must not be copied");
    const restore = join(f.root, "restore");
    mkdirSync(restore);
    git(restore, "init", "-q");
    git(restore, "fetch", "-q", record.objectStore, record.headRef);
    git(restore, "checkout", "-q", "--detach", "FETCH_HEAD");
    writeFileSync(join(f.root, "staged.patch"), record.stagedPatch);
    writeFileSync(join(f.root, "unstaged.patch"), record.unstagedPatch);
    git(restore, "apply", "--index", join(f.root, "staged.patch"));
    git(restore, "apply", join(f.root, "unstaged.patch"));
    expect(git(restore, "show", ":source.txt")).toBe("staged");
    expect(readFileSync(join(restore, "source.txt"), "utf8")).toBe("unstaged\n");
    expect(readFileSync(join(restore, "binary.bin"))).toEqual(Buffer.from([0, 254, 3, 4]));
    expect(readFileSync(join(restore, "build", "tracked.txt"), "utf8")).toBe("tracked source\n");
    expect(
      Buffer.from(
        record.files.find((file: any) => file.path === "local-report.json").data,
        "base64",
      ).toString(),
    ).toBe('{"verified":false}\n');
    expect(
      cleanupLoopExecutionWorktree({
        worktree: f.worktree,
        sourceWorktree: f.source,
        expectedBranch: f.branch,
        runGit,
      }),
    ).toBe(true);
    expect(archiveRecords(f.state)).toHaveLength(1);
  });

  it("preserves changed bytes hidden by index assume-unchanged or skip-worktree flags", () => {
    const f = fixture();
    writeFileSync(join(f.worktree, "sparse.txt"), "base sparse\n");
    git(f.worktree, "add", "sparse.txt");
    commit(f.worktree, "sparse source");
    git(f.worktree, "update-index", "--assume-unchanged", "source.txt");
    git(f.worktree, "update-index", "--skip-worktree", "sparse.txt");
    writeFileSync(join(f.worktree, "source.txt"), "hidden changed source\n");
    writeFileSync(join(f.worktree, "sparse.txt"), "hidden sparse source\n");
    expect(git(f.worktree, "diff", "--name-only")).toBe("");
    expect(
      archiveLoopWorktree({ worktree: f.worktree, sourceWorktree: f.source, runGit }),
    ).not.toBeNull();
    const record = archiveRecords(f.state)[0]?.record;
    for (const name of ["source.txt", "sparse.txt"])
      expect(
        Buffer.from(record.files.find((file: any) => file.path === name).data, "base64"),
      ).toEqual(readFileSync(join(f.worktree, name)));
  });

  it.each(["line endings", "clean filter"])(
    "restores raw tracked bytes hidden by Git %s",
    (kind) => {
      const f = fixture();
      if (kind === "line endings") {
        writeFileSync(join(f.worktree, ".gitattributes"), "*.txt text eol=lf\n");
      } else {
        writeFileSync(join(f.worktree, ".gitattributes"), "source.txt filter=strip-local\n");
        git(f.worktree, "config", "filter.strip-local.clean", "sed '/^local:/d'");
      }
      git(f.worktree, "add", ".gitattributes");
      commit(f.worktree, "normalized source");
      const raw = Buffer.from(
        kind === "line endings" ? "base\r\n" : "base\nlocal: unique source bytes\n",
      );
      writeFileSync(join(f.worktree, "source.txt"), raw);
      expect(git(f.worktree, "diff", "--name-only")).toBe("");
      expect(git(f.worktree, "hash-object", "--no-filters", "--", "source.txt")).not.toBe(
        git(f.worktree, "rev-parse", ":source.txt"),
      );
      expect(
        cleanupLoopExecutionWorktree({
          worktree: f.worktree,
          sourceWorktree: f.source,
          expectedBranch: f.branch,
          runGit,
        }),
      ).toBe(true);
      const record = archiveRecords(f.state)[0]?.record;
      const source = record.files.find((file: any) => file.path === "source.txt");
      expect(source.data).toBeDefined();
      const restore = join(f.root, "restore-raw-source");
      mkdirSync(restore);
      git(restore, "init", "-q");
      git(restore, "fetch", "-q", record.objectStore, record.headRef);
      git(restore, "checkout", "-q", "--detach", "FETCH_HEAD");
      writeFileSync(join(restore, "source.txt"), Buffer.from(source.data, "base64"));
      chmodSync(join(restore, "source.txt"), source.mode);
      expect(readFileSync(join(restore, "source.txt"))).toEqual(raw);
    },
  );

  it("retains the worktree and branch when commit archiving fails", () => {
    const f = fixture();
    const failingGit = (invocation: LoopGitInvocation) =>
      invocation.args.includes("fetch")
        ? { status: 1, stdout: "", stderr: "archive unavailable" }
        : runGit(invocation);
    expect(
      cleanupLoopExecutionWorktree({
        worktree: f.worktree,
        sourceWorktree: f.source,
        expectedBranch: f.branch,
        runGit: failingGit,
      }),
    ).toBe(false);
    expect(existsSync(f.worktree)).toBe(true);
    expect(git(f.worktree, "branch", "--show-current")).toBe(f.branch);
  });

  it("retains a worktree whose HEAD changes during archival", () => {
    const f = fixture();
    let changed = false;
    const racingGit = (invocation: LoopGitInvocation) => {
      if (!changed && invocation.args.includes("fetch")) {
        changed = true;
        writeFileSync(join(f.worktree, "late.txt"), "late change");
        git(f.worktree, "add", "late.txt");
        commit(f.worktree, "late");
      }
      return runGit(invocation);
    };
    expect(
      cleanupLoopExecutionWorktree({
        worktree: f.worktree,
        sourceWorktree: f.source,
        expectedBranch: f.branch,
        runGit: racingGit,
      }),
    ).toBe(false);
    expect(existsSync(f.worktree)).toBe(true);
  });

  it("reuses verified recovery after interruption between ref cleanup and directory removal", () => {
    const f = fixture();
    const failingRemoval = (invocation: LoopGitInvocation) =>
      invocation.args[0] === "worktree" && invocation.args[1] === "remove"
        ? { status: 1, stdout: "", stderr: "temporary removal failure" }
        : runGit(invocation);
    const input = { worktree: f.worktree, sourceWorktree: f.source, expectedBranch: f.branch };
    expect(cleanupLoopExecutionWorktree({ ...input, runGit: failingRemoval })).toBe(false);
    expect(existsSync(f.worktree)).toBe(true);
    expect(archiveRecords(f.state)).toHaveLength(1);
    expect(cleanupLoopExecutionWorktree({ ...input, runGit })).toBe(true);
    expect(archiveRecords(f.state)).toHaveLength(1);
  });

  it("preserves an independent checkout's unique commit before removing its own Git directory", () => {
    const f = fixture();
    git(f.source, "worktree", "remove", "--force", f.worktree);
    git(f.source, "clone", "--quiet", "--no-local", f.source, f.worktree);
    git(f.worktree, "checkout", "--quiet", "--detach");
    writeFileSync(join(f.worktree, "clone-only.txt"), "unique clone source\n");
    git(f.worktree, "add", "clone-only.txt");
    commit(f.worktree, "clone only");
    const head = git(f.worktree, "rev-parse", "HEAD");
    expect(cleanupLoopExecutionWorktree({ worktree: f.worktree, runGit })).toBe(true);
    expect(existsSync(f.worktree)).toBe(false);
    const record = archiveRecords(f.state)[0]?.record;
    expect(git(record.objectStore, "show", `${head}:clone-only.txt`)).toBe("unique clone source");
  });

  it.each(["single", "aggregate"])(
    "retains an oversized %s diagnostic before fetching recovery",
    (kind) => {
      const f = fixture();
      mkdirSync(join(f.worktree, "test-results"));
      sparseFile(
        join(f.worktree, "test-results", "first.trace"),
        32 * 1024 * 1024 + (kind === "single" ? 1 : 0),
      );
      if (kind === "aggregate")
        sparseFile(join(f.worktree, "test-results", "second.trace"), 32 * 1024 * 1024);
      let fetched = false;
      const observedGit = (invocation: LoopGitInvocation) => {
        if (invocation.args.includes("fetch")) fetched = true;
        return runGit(invocation);
      };
      expect(
        cleanupLoopExecutionWorktree({
          worktree: f.worktree,
          sourceWorktree: f.source,
          expectedBranch: f.branch,
          runGit: observedGit,
        }),
      ).toBe(false);
      expect(fetched).toBe(false);
      expect(statSync(join(f.worktree, "test-results", "first.trace")).size).toBeGreaterThanOrEqual(
        32 * 1024 * 1024,
      );
      expect(git(f.worktree, "branch", "--show-current")).toBe(f.branch);
    },
  );

  it("streams a clean tracked asset larger than the captured-file limit and restores it from Git", () => {
    const f = fixture();
    const size = 33 * 1024 * 1024;
    sparseFile(join(f.worktree, "large-asset.bin"), size);
    git(f.worktree, "add", "large-asset.bin");
    commit(f.worktree, "large tracked asset");
    const head = git(f.worktree, "rev-parse", "HEAD");
    expect(
      cleanupLoopExecutionWorktree({
        worktree: f.worktree,
        sourceWorktree: f.source,
        expectedBranch: f.branch,
        runGit,
      }),
    ).toBe(true);
    const record = archiveRecords(f.state)[0]?.record;
    expect(record.files.find((file: any) => file.path === "large-asset.bin").data).toBeUndefined();
    const restore = join(f.root, "restored-large-asset");
    mkdirSync(restore);
    git(restore, "init", "-q");
    git(restore, "fetch", "-q", record.objectStore, record.headRef);
    git(restore, "checkout", "-q", "--detach", "FETCH_HEAD");
    expect(statSync(join(restore, "large-asset.bin")).size).toBe(size);
    expect(git(restore, "rev-parse", "HEAD")).toBe(head);
  });

  it("restores an ignored 21 MiB browser trace within the bounded capture budget", () => {
    const f = fixture();
    mkdirSync(join(f.worktree, "test-results"));
    const size = 21 * 1024 * 1024;
    const tracePath = join(f.worktree, "test-results", "browser.trace");
    sparseFile(tracePath, size);
    const marker = Buffer.from("unique browser evidence");
    const fd = openSync(tracePath, "r+");
    try {
      writeSync(fd, marker, 0, marker.length, size - marker.length);
    } finally {
      closeSync(fd);
    }
    expect(
      cleanupLoopExecutionWorktree({
        worktree: f.worktree,
        sourceWorktree: f.source,
        expectedBranch: f.branch,
        runGit,
      }),
    ).toBe(true);
    const record = archiveRecords(f.state)[0]?.record;
    const trace = record.files.find((file: any) => file.path === "test-results/browser.trace");
    const restored = join(f.root, "restored-browser.trace");
    writeFileSync(restored, Buffer.from(trace.data, "base64"));
    expect(statSync(restored).size).toBe(size);
    expect(trace.data.length).toBe(Math.ceil(size / 3) * 4);
    const restoredFd = openSync(restored, "r");
    const actual = Buffer.alloc(marker.length);
    try {
      readSync(restoredFd, actual, 0, actual.length, size - actual.length);
    } finally {
      closeSync(restoredFd);
    }
    expect(actual).toEqual(marker);
  });

  it("recovers standalone side refs, annotated tags and older stash/reflog tips after Git directory removal", () => {
    const f = standaloneFixture();
    const base = git(f.worktree, "rev-parse", "HEAD");
    git(f.worktree, "checkout", "-qb", "side");
    writeFileSync(join(f.worktree, "side.txt"), "side branch source");
    git(f.worktree, "add", "side.txt");
    commit(f.worktree, "side commit");
    const side = git(f.worktree, "rev-parse", "HEAD");
    git(
      f.worktree,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "tag",
      "-a",
      "side-tag",
      "-m",
      "unique annotation",
    );
    const tag = git(f.worktree, "rev-parse", "side-tag");
    git(f.worktree, "checkout", "-q", "--detach", base);
    writeFileSync(join(f.worktree, "reflog.txt"), "reflog-only source");
    git(f.worktree, "add", "reflog.txt");
    commit(f.worktree, "reflog-only commit");
    const reflogOnly = git(f.worktree, "rev-parse", "HEAD");
    git(f.worktree, "checkout", "-q", "--detach", base);
    const stashes: string[] = [];
    for (const text of ["older stash", "newer stash"]) {
      writeFileSync(join(f.worktree, "source.txt"), text);
      git(
        f.worktree,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "stash",
        "push",
        "-qm",
        text,
      );
      stashes.push(git(f.worktree, "rev-parse", "refs/stash"));
    }
    expect(cleanupLoopExecutionWorktree({ worktree: f.worktree, runGit })).toBe(true);
    expect(existsSync(f.worktree)).toBe(false);
    const record = archiveRecords(f.state)[0]?.record;
    expect(record.standaloneHistory).toBeDefined();
    expect(record.standaloneHistory.refs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "refs/heads/side", oid: side }),
        expect.objectContaining({ name: "refs/tags/side-tag", oid: tag }),
        expect.objectContaining({ name: "refs/stash", oid: stashes[1] }),
      ]),
    );
    expect(record.standaloneHistory.reflogTips).toEqual(
      expect.arrayContaining([reflogOnly, ...stashes]),
    );
    const restore = join(f.root, "restored-side-history");
    mkdirSync(restore);
    git(restore, "init", "-q");
    for (const [name, oid] of Object.entries({
      side,
      tag,
      reflogOnly,
      oldStash: stashes[0],
      newStash: stashes[1],
    }))
      git(
        restore,
        "fetch",
        "-q",
        record.objectStore,
        `refs/loop-recovery/${oid}:refs/recovered/${name}`,
      );
    expect(git(restore, "show", "refs/recovered/side:side.txt")).toBe("side branch source");
    expect(git(restore, "cat-file", "-t", "refs/recovered/tag")).toBe("tag");
    expect(git(restore, "cat-file", "-p", "refs/recovered/tag")).toContain("unique annotation");
    expect(git(restore, "show", "refs/recovered/reflogOnly:reflog.txt")).toBe("reflog-only source");
    expect(git(restore, "show", "refs/recovered/oldStash:source.txt")).toBe("older stash");
    expect(git(restore, "show", "refs/recovered/newStash:source.txt")).toBe("newer stash");
    git(restore, "fsck", "--full");
  });

  it("retains a standalone checkout if its refs change during recovery", () => {
    const f = standaloneFixture();
    let changed = false;
    const racingGit = (invocation: LoopGitInvocation) => {
      if (!changed && invocation.args.includes("fetch")) {
        changed = true;
        git(f.worktree, "update-ref", "refs/heads/late", "HEAD");
      }
      return runGit(invocation);
    };
    expect(cleanupLoopExecutionWorktree({ worktree: f.worktree, runGit: racingGit })).toBe(false);
    expect(existsSync(f.worktree)).toBe(true);
    expect(git(f.worktree, "rev-parse", "refs/heads/late")).toBe(
      git(f.worktree, "rev-parse", "HEAD"),
    );
  });

  it("retains ignored diagnostics arriving after the standalone fallback status check", () => {
    const f = standaloneFixture();
    const racingGit = (invocation: LoopGitInvocation) => {
      const result = runGit(invocation);
      if (invocation.cwd === f.worktree && invocation.args[0] === "status")
        writeFileSync(join(f.worktree, "local-report.json"), "late unique diagnostic");
      return result;
    };
    expect(cleanupLoopExecutionWorktree({ worktree: f.worktree, runGit: racingGit })).toBe(false);
    expect(readFileSync(join(f.worktree, "local-report.json"), "utf8")).toBe(
      "late unique diagnostic",
    );
  });

  it.each([true, false])(
    "preserves a missing checkout's unique ref (registration retained: %s)",
    (registered) => {
      const f = fixture();
      writeFileSync(join(f.worktree, "unique.txt"), "recover ref\n");
      git(f.worktree, "add", "unique.txt");
      commit(f.worktree, "unpublished");
      const head = git(f.worktree, "rev-parse", "HEAD");
      rmSync(f.worktree, { recursive: true });
      if (!registered) git(f.source, "worktree", "prune");
      expect(
        cleanupLoopExecutionWorktree({
          worktree: f.worktree,
          sourceWorktree: f.source,
          expectedBranch: f.branch,
          runGit,
        }),
      ).toBe(true);
      const record = archiveRecords(f.state)[0]?.record;
      expect(git(record.objectStore, "show", `${head}:unique.txt`)).toBe("recover ref");
    },
  );

  it("refuses cleanup from a different source repository", () => {
    const f = fixture();
    const other = join(f.root, "other-source");
    mkdirSync(other);
    git(other, "init", "--quiet");
    expect(
      cleanupLoopExecutionWorktree({
        worktree: f.worktree,
        sourceWorktree: other,
        expectedBranch: f.branch,
        runGit,
      }),
    ).toBe(false);
    expect(existsSync(f.worktree)).toBe(true);
  });

  it("retains dirty source that changes while the commit is archived", () => {
    const f = fixture();
    let changed = false;
    const racingGit = (invocation: LoopGitInvocation) => {
      if (!changed && invocation.args.includes("fetch")) {
        changed = true;
        writeFileSync(join(f.worktree, "source.txt"), "new uncommitted input\n");
      }
      return runGit(invocation);
    };
    expect(
      cleanupLoopExecutionWorktree({
        worktree: f.worktree,
        sourceWorktree: f.source,
        expectedBranch: f.branch,
        runGit: racingGit,
      }),
    ).toBe(false);
    expect(readFileSync(join(f.worktree, "source.txt"), "utf8")).toBe("new uncommitted input\n");
    expect(git(f.worktree, "branch", "--show-current")).toBe(f.branch);
  });

  it("refuses a symlinked owned path and a symlinked archive destination", () => {
    const f = fixture();
    const alias = join(f.state, "loop-worktrees", "alias");
    symlinkSync(f.source, alias);
    expect(cleanupLoopExecutionWorktree({ worktree: alias, runGit })).toBe(false);
    symlinkSync(f.root, join(f.state, "loop-worktree-archives"));
    expect(cleanupLoopExecutionWorktree({ worktree: f.worktree, runGit })).toBe(false);
    expect(existsSync(f.worktree)).toBe(true);
    expect(existsSync(join(f.source, "source.txt"))).toBe(true);
  });

  it("retains source when an existing recovery archive is corrupted", () => {
    const f = fixture();
    const failingRemoval = (invocation: LoopGitInvocation) =>
      invocation.args[0] === "worktree" && invocation.args[1] === "remove"
        ? { status: 1, stdout: "", stderr: "temporary removal failure" }
        : runGit(invocation);
    const input = { worktree: f.worktree, sourceWorktree: f.source, expectedBranch: f.branch };
    expect(cleanupLoopExecutionWorktree({ ...input, runGit: failingRemoval })).toBe(false);
    const archive = archiveRecords(f.state)[0];
    expect(archive).toBeDefined();
    writeFileSync(archive?.path as string, "corrupt");
    expect(cleanupLoopExecutionWorktree({ ...input, runGit })).toBe(false);
    expect(existsSync(f.worktree)).toBe(true);
  });
});
