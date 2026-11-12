import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  openSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { appStateDir } from "../../shared/state-dir.js";
import { createLogger } from "../../shared/utils/logger.js";
import type { LoopGitInvocation, LoopRunCommandResult } from "./run.js";

type RunGit = (invocation: LoopGitInvocation) => LoopRunCommandResult;
type RecoveryInput = {
  worktree: string;
  workOrderId?: string;
  sourceWorktree?: string;
  expectedBranch?: string;
  runGit: RunGit;
};
type RecoveryFile = {
  path: string;
  kind: "file" | "symlink";
  mode: number;
  sha256: string;
  data?: string;
  target?: string;
};
const log = createLogger("loop.worktree-recovery");
// This synchronous cleanup path stays bounded. Larger evidence is retained in
// its workspace for a separate archival operation instead of risking the bot.
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const MAX_RECORD_BYTES = 128 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
const MAX_HISTORY_TIPS = 256;
function limitExceeded(detail: string): never {
  throw new Error(`Recovery archive limit exceeded (${detail}); workspace retained`);
}

const generatedDirectories = new Set([
  "node_modules",
  "dist",
  "build",
  ".cache",
  ".next",
  ".nuxt",
  ".turbo",
  ".parcel-cache",
  "__pycache__",
  ".venv",
  "venv",
  "target",
  "vendor",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".gradle",
  ".pnpm-store",
]);
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
function splitEntries(text: string, separator: string): string[] {
  const entries: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = text.indexOf(separator, start);
    const entry = text.slice(start, end < 0 ? undefined : end);
    if (entry) entries.push(entry);
    if (entries.length > MAX_ENTRIES) limitExceeded("too many metadata entries");
    if (end < 0) break;
    start = end + separator.length;
  }
  return entries;
}
const nulPaths = (text: string) => splitEntries(text, "\0");
function git(runGit: RunGit, cwd: string, ...args: string[]): string {
  const result = runGit({ cwd, args: ["--no-optional-locks", ...args] });
  if (result.status !== 0)
    throw new Error((result.stderr || result.stdout || "Git recovery failed").slice(0, 1024));
  // Production runGit already bounds subprocess output; also bound injected
  // callers before parsing or accumulating their strings into an archive.
  if (Buffer.byteLength(result.stdout) > MAX_GIT_OUTPUT_BYTES)
    limitExceeded("Git metadata exceeds 8 MiB");
  return result.stdout;
}

/** Check each owned path component without following a directory symlink. */
export function safeOwnedWorktreePath(worktree: string): boolean {
  const root = resolve(appStateDir(), "loop-worktrees");
  const path = resolve(worktree);
  if (!path.startsWith(`${root}${sep}`)) return false;
  let current = root;
  for (const part of ["", ...relative(root, path).split(sep)]) {
    current = part ? join(current, part) : current;
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) return false;
    if (stat && !stat.isDirectory()) return false;
  }
  return true;
}

/** Review snapshots have a separate, exact artifact layout; execution ownership stays unchanged. */
export function safePrReviewWorktreePath(worktree: string, runDir: string): boolean {
  const root = resolve(appStateDir(), "loop-runs");
  const run = resolve(runDir);
  const path = resolve(worktree);
  const runParts = relative(root, run).split(sep);
  const parts = relative(run, path).split(sep);
  if (
    runParts.length !== 2 ||
    runParts.some((part) => !part || part === "." || part === "..") ||
    !run.startsWith(`${root}${sep}`) ||
    parts.length !== 4 ||
    parts[0] !== "pr-reviews" ||
    !/^[1-9]\d*$/.test(parts[1] ?? "") ||
    !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(parts[2] ?? "") ||
    parts[3] !== "worktree"
  )
    return false;
  let current = root;
  for (const part of ["", ...relative(root, path).split(sep)]) {
    current = part ? join(current, part) : current;
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink() || (stat && !stat.isDirectory())) return false;
  }
  return true;
}

function privateDirectory(path: string): void {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
    throw new Error("Unsafe recovery directory");
  if (!stat) mkdirSync(path, { mode: 0o700 });
  chmodSync(path, 0o700);
}

function recoveryRoot(): string {
  const root = join(appStateDir(), "loop-worktree-archives");
  privateDirectory(root);
  return root;
}

function readCheckedFile<T>(
  path: string,
  maxBytes: number,
  read: (fd: number, size: number) => T,
): T {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile()) throw new Error("Recovery input is not a regular file");
    if (before.size > maxBytes) limitExceeded(`file exceeds ${maxBytes} bytes`);
    const result = read(fd, before.size);
    // Check growth without allocating beyond the preflight size.
    if (readSync(fd, Buffer.alloc(1), 0, 1, null) !== 0)
      throw new Error("Recovery input grew during read");
    const after = fstatSync(fd);
    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw new Error("Recovery input changed during read");
    return result;
  } finally {
    closeSync(fd);
  }
}
function readRegularFile(path: string, maxBytes = MAX_FILE_BYTES): Buffer {
  return readCheckedFile(path, maxBytes, (fd, size) => {
    const bytes = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (count === 0) throw new Error("Recovery input shrank during read");
      offset += count;
    }
    return bytes;
  });
}
function hashRegularFile(path: string, expectedSize: number, indexOid: string) {
  return readCheckedFile(path, expectedSize, (fd, size) => {
    const digest = createHash("sha256");
    // Git's raw blob identity includes its header and bypasses attributes and
    // clean filters. Compare it with the index while streaming the same bytes.
    const blob = createHash(indexOid.length === 64 ? "sha256" : "sha1")
      .update(`blob ${size}`)
      .update(Buffer.from([0]));
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < size) {
      const count = readSync(fd, chunk, 0, Math.min(chunk.length, size - offset), null);
      if (count === 0) throw new Error("Recovery input shrank during read");
      digest.update(chunk.subarray(0, count));
      blob.update(chunk.subarray(0, count));
      offset += count;
    }
    return { sha256: digest.digest("hex"), blobOid: blob.digest("hex") };
  });
}

type StandaloneHistory = {
  refs: Array<{ name: string; oid: string; symbolicTarget: string }>;
  reflogTips: string[];
};
function standaloneHistory(runGit: RunGit, worktree: string): StandaloneHistory {
  const refs = splitEntries(
    git(runGit, worktree, "for-each-ref", "--format=%(refname)%00%(objectname)%00%(symref)"),
    "\n",
  ).map((entry) => {
    const [name = "", oid = "", symbolicTarget = ""] = entry.split("\0");
    return { name, oid, symbolicTarget };
  });
  // --no-walk preserves reflog roots (including older stash entries), not a
  // separate list of every ancestor; fetching each root preserves its graph.
  const reflogTips = [
    ...new Set(
      splitEntries(
        git(runGit, worktree, "rev-list", "--reflog", "--all", "--no-walk=unsorted"),
        "\n",
      ),
    ),
  ].sort();
  return { refs, reflogTips };
}

function preserveCommit(
  runGit: RunGit,
  repository: string,
  head: string,
  history?: StandaloneHistory,
) {
  const objects = [
    ...new Set([
      head,
      ...(history?.refs.map((ref) => ref.oid) ?? []),
      ...(history?.reflogTips ?? []),
    ]),
  ];
  if (objects.length > MAX_HISTORY_TIPS) limitExceeded("more than 256 distinct Git history tips");
  if (objects.some((oid) => !/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(oid)))
    throw new Error("Unverified recovery object");
  const root = recoveryRoot();
  const objectStore = join(root, "objects.git");
  privateDirectory(objectStore);
  if (!existsSync(join(objectStore, "HEAD"))) git(runGit, objectStore, "init", "--bare", "--quiet");
  if (git(runGit, objectStore, "rev-parse", "--is-bare-repository").trim() !== "true")
    throw new Error("Recovery object store is not bare");
  const refs = objects.map((oid) => `refs/loop-recovery/${oid}`);
  const readRefs = () =>
    new Map(
      splitEntries(
        git(runGit, objectStore, "for-each-ref", "--format=%(refname) %(objectname)", ...refs),
        "\n",
      ).map((line) => {
        const [name = "", oid = ""] = line.split(" ");
        return [name, oid];
      }),
    );
  const existing = readRefs();
  const missing = objects.filter((oid) => !existing.has(`refs/loop-recovery/${oid}`));
  if (missing.length > 0) {
    git(
      runGit,
      objectStore,
      "-c",
      "gc.auto=0",
      "fetch",
      "--quiet",
      "--no-tags",
      "--no-write-fetch-head",
      "--no-auto-maintenance",
      "--no-recurse-submodules",
      repository,
      ...missing.map((oid) => `${oid}:refs/loop-recovery/${oid}`),
    );
  }
  const stored = readRefs();
  if (objects.some((oid) => stored.get(`refs/loop-recovery/${oid}`) !== oid))
    throw new Error("Recovery object refs do not match");
  git(
    runGit,
    objectStore,
    "fsck",
    "--connectivity-only",
    "--no-dangling",
    "--no-reflogs",
    ...objects,
  );
  return { objectStore, headRef: `refs/loop-recovery/${head}` };
}

function boundedJson(record: Record<string, unknown>): string {
  let remaining = MAX_RECORD_BYTES;
  const consume = (bytes: number) => {
    remaining -= bytes;
    if (remaining < 0) limitExceeded("JSON record exceeds 128 MiB");
  };
  function count(value: unknown): void {
    if (Array.isArray(value)) {
      consume(2 + Math.max(0, value.length - 1));
      for (const item of value) count(item);
    } else if (value !== null && typeof value === "object") {
      const entries = Object.entries(value).filter(([, item]) => item !== undefined);
      consume(2 + Math.max(0, entries.length - 1));
      for (const [key, item] of entries) {
        count(key);
        consume(1);
        count(item);
      }
    } else if (value === undefined) consume(4);
    else consume(Buffer.byteLength(JSON.stringify(value)));
  }
  count(record);
  return JSON.stringify(record);
}

function fingerprint(record: Record<string, unknown>): string {
  // Git may refresh index stat caches while detaching; staged entries and flags
  // must remain identical, while the original raw index stays in the archive.
  const { index: _index, indexSha256: _indexSha256, ...identity } = record;
  return hash(boundedJson(identity));
}

function writeVerifiedRecord(record: Record<string, unknown>): string {
  const bytes = Buffer.from(boundedJson(record));
  const root = recoveryRoot();
  const path = join(root, `${fingerprint(record)}.json.gz`);
  if (!existsSync(path)) {
    const pending = `${path}.${process.pid}.${randomUUID()}.pending`;
    try {
      const fd = openSync(pending, "wx", 0o600);
      try {
        writeFileSync(fd, gzipSync(bytes));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(pending, path);
    } finally {
      rmSync(pending, { force: true });
    }
  }
  const verified = JSON.parse(
    gunzipSync(readRegularFile(path, MAX_RECORD_BYTES + 1024 * 1024), {
      maxOutputLength: MAX_RECORD_BYTES,
    }).toString("utf8"),
  ) as Record<string, unknown>;
  if (
    fingerprint(verified) !== fingerprint(record) ||
    (typeof verified.index === "string" &&
      hash(Buffer.from(verified.index, "base64")) !== verified.indexSha256)
  )
    throw new Error("Recovery archive verification failed");
  const directory = openSync(root, "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
  return path;
}

function captureWorktree(
  input: RecoveryInput,
  ownsPath = () => safeOwnedWorktreePath(input.worktree),
) {
  if (!ownsPath()) throw new Error("Unsafe worktree path");
  const worktree = realpathSync(input.worktree);
  const head = git(input.runGit, worktree, "rev-parse", "--verify", "HEAD").trim();
  const branch = git(input.runGit, worktree, "branch", "--show-current").trim();
  const commonDir = git(
    input.runGit,
    worktree,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ).trim();
  const metadata = lstatSync(join(worktree, ".git"));
  if (metadata.isSymbolicLink())
    throw new Error("Symlinked Git metadata is not owned cleanup evidence");
  if (input.sourceWorktree !== undefined && metadata.isFile()) {
    const sourceCommon = git(
      input.runGit,
      input.sourceWorktree,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ).trim();
    if (realpathSync(commonDir) !== realpathSync(sourceCommon))
      throw new Error("Source repository identity changed");
  }
  if (git(input.runGit, worktree, "ls-files", "--unmerged").trim())
    throw new Error("Unmerged index requires manual recovery before cleanup");
  const indexPath = git(
    input.runGit,
    worktree,
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "index",
  ).trim();
  const history = metadata.isDirectory() ? standaloneHistory(input.runGit, worktree) : undefined;
  let totalBytes = 0;
  const preflight = (size: number) => {
    if (size > MAX_FILE_BYTES) limitExceeded("file exceeds 32 MiB");
    totalBytes += size;
    if (totalBytes > MAX_INPUT_BYTES) limitExceeded("aggregate captured input exceeds 64 MiB");
  };
  const indexSize = lstatSync(indexPath).size;
  preflight(indexSize);
  const tracked = new Set(nulPaths(git(input.runGit, worktree, "ls-files", "--cached", "-z")));
  const indexEntries = git(input.runGit, worktree, "ls-files", "--stage", "-z");
  const indexBlobs = new Map(
    nulPaths(indexEntries).map((entry) => {
      const separator = entry.indexOf(String.fromCharCode(9));
      const [, oid = "", stage] = entry.slice(0, separator).split(" ");
      if (separator < 0 || stage !== "0" || !/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(oid))
        throw new Error("Unverified recovery index entry");
      return [entry.slice(separator + 1), oid];
    }),
  );
  const indexFlags = git(input.runGit, worktree, "ls-files", "-v", "-z");
  // These index flags can hide local bytes from `git diff`; preserve them even
  // when Git reports a clean path instead of trusting its stat-cache shortcut.
  const hiddenChanges = new Set(
    nulPaths(indexFlags)
      .filter((entry) => /^[a-zS] /.test(entry))
      .map((entry) => entry.slice(2)),
  );
  const dirty = new Set([
    ...nulPaths(git(input.runGit, worktree, "diff", "--name-only", "-z", "--")),
    ...nulPaths(git(input.runGit, worktree, "diff", "--cached", "--name-only", "-z", "--")),
  ]);
  const ignored = nulPaths(
    git(
      input.runGit,
      worktree,
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
      "-z",
    ),
  );
  const pending: Array<{
    path: string;
    filePath: string;
    kind: "file" | "symlink";
    mode: number;
    size: number;
    capture: boolean;
  }> = [];
  let entries = 0;
  function walk(directory: string, prefix = ""): void {
    const dir = opendirSync(directory);
    try {
      for (let entry = dir.readSync(); entry !== null; entry = dir.readSync()) {
        if (++entries > MAX_ENTRIES) limitExceeded("more than 10000 filesystem entries");
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (path === ".git") continue;
        const filePath = join(directory, entry.name);
        const stat = lstatSync(filePath);
        const ignoredPath = ignored.some(
          (item) =>
            item === path || item === `${path}/` || (item.endsWith("/") && path.startsWith(item)),
        );
        if (
          ignoredPath &&
          path.split("/").some((part) => generatedDirectories.has(part)) &&
          !tracked.has(path) &&
          ![...tracked].some((item) => item.startsWith(`${path}/`))
        )
          continue;
        if (stat.isDirectory()) {
          if (existsSync(join(filePath, ".git")))
            throw new Error("Nested repository requires separate recovery");
          walk(filePath, path);
        } else if (stat.isFile() || stat.isSymbolicLink()) {
          const capture =
            stat.isSymbolicLink() ||
            !tracked.has(path) ||
            dirty.has(path) ||
            hiddenChanges.has(path);
          // Clean tracked content is recovered from Git and hashed in chunks;
          // only bytes actually captured into this record consume the budget.
          if (capture) preflight(stat.size);
          pending.push({
            path,
            filePath,
            kind: stat.isFile() ? "file" : "symlink",
            mode: stat.mode & 0o777,
            size: stat.size,
            capture,
          });
        } else throw new Error("Unsupported filesystem entry requires manual recovery");
      }
    } finally {
      dir.closeSync();
    }
  }
  // Inspect sizes/counts before reading source bytes or allocating base64.
  walk(worktree);
  pending.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const index = readRegularFile(indexPath, indexSize);
  const files: RecoveryFile[] = pending.map(({ path, filePath, kind, mode, size, capture }) => {
    if (kind === "symlink") {
      const target = readlinkSync(filePath);
      return { path, kind, mode, sha256: hash(target), target };
    }
    if (!capture) {
      const indexOid = indexBlobs.get(path);
      if (indexOid === undefined) throw new Error("Tracked recovery file is absent from index");
      const fingerprint = hashRegularFile(filePath, size, indexOid);
      if (fingerprint.blobOid === indexOid) return { path, kind, mode, sha256: fingerprint.sha256 };
      // Git can report a clean file after normalization or a lossy clean filter.
      // Preserve those original bytes under the same limits as other overlays.
      preflight(size);
    }
    const bytes = readRegularFile(filePath, size);
    return {
      path,
      kind,
      mode,
      sha256: hash(bytes),
      data: bytes.toString("base64"),
    };
  });
  const record = {
    version: 1,
    kind: "worktree",
    worktree,
    workOrderId: input.workOrderId,
    sourceWorktree: input.sourceWorktree,
    branch: input.expectedBranch ?? branch,
    commonDir,
    head,
    ...(history === undefined ? {} : { standaloneHistory: history }),
    index: index.toString("base64"),
    indexSha256: hash(index),
    indexEntries,
    indexFlags,
    stagedPatch: git(
      input.runGit,
      worktree,
      "diff",
      "--cached",
      "--binary",
      "--full-index",
      "--no-ext-diff",
      "--no-textconv",
      "--",
    ),
    unstagedPatch: git(
      input.runGit,
      worktree,
      "diff",
      "--binary",
      "--full-index",
      "--no-ext-diff",
      "--no-textconv",
      "--",
    ),
    files,
  };
  return { record, branch, fingerprint: fingerprint(record) };
}

/** No deletion authority: callers must retain their ownership and lease checks. */
export function archiveLoopWorktree(input: RecoveryInput): {
  path: string;
  verify(allowDetached?: boolean): boolean;
} | null {
  return archiveWorktree(input, () => safeOwnedWorktreePath(input.worktree));
}

/** Archive only: the caller must prove terminal ownership and process quiescence before deletion. */
export function archivePrReviewWorktree(input: RecoveryInput & { runDir: string }) {
  return archiveWorktree(input, () => safePrReviewWorktreePath(input.worktree, input.runDir));
}

function archiveWorktree(
  input: RecoveryInput,
  ownsPath: () => boolean,
): {
  path: string;
  verify(allowDetached?: boolean): boolean;
} | null {
  try {
    const before = captureWorktree(input, ownsPath);
    const recovery = preserveCommit(
      input.runGit,
      input.worktree,
      before.record.head,
      before.record.standaloneHistory,
    );
    const path = writeVerifiedRecord({ ...before.record, ...recovery });
    const archiveSha256 = hash(readRegularFile(path, MAX_RECORD_BYTES + 1024 * 1024));
    const verify = (allowDetached = false): boolean => {
      try {
        if (hash(readRegularFile(path, MAX_RECORD_BYTES + 1024 * 1024)) !== archiveSha256)
          return false;
        const store = lstatSync(recovery.objectStore);
        if (!store.isDirectory() || store.isSymbolicLink()) return false;
        const objects = [
          ...new Set([
            before.record.head,
            ...(before.record.standaloneHistory?.refs.map((ref) => ref.oid) ?? []),
            ...(before.record.standaloneHistory?.reflogTips ?? []),
          ]),
        ];
        const retained = new Map(
          splitEntries(
            git(
              input.runGit,
              recovery.objectStore,
              "for-each-ref",
              "--format=%(refname) %(objectname)",
              ...objects.map((oid) => `refs/loop-recovery/${oid}`),
            ),
            "\n",
          ).map((line) => {
            const [ref = "", oid = ""] = line.split(" ");
            return [ref, oid];
          }),
        );
        if (objects.some((oid) => retained.get(`refs/loop-recovery/${oid}`) !== oid)) return false;
        git(
          input.runGit,
          recovery.objectStore,
          "fsck",
          "--connectivity-only",
          "--no-dangling",
          "--no-reflogs",
          ...objects,
        );
        const after = captureWorktree(input, ownsPath);
        return (
          before.fingerprint === after.fingerprint &&
          (before.branch === after.branch || (allowDetached && after.branch === ""))
        );
      } catch {
        return false;
      }
    };
    if (!verify()) throw new Error("Worktree changed during recovery archival");
    log.info("loop worktree recovery archived", {
      data: { worktree: input.worktree, archive: path, head: before.record.head },
    });
    return { path, verify };
  } catch (err) {
    log.warn("loop retained worktree because recovery archival failed", {
      err,
      data: { worktree: input.worktree },
    });
    return null;
  }
}

export function archiveLoopCommit(input: {
  repository: string;
  head: string;
  branch?: string;
  worktree?: string;
  runGit: RunGit;
}): boolean {
  try {
    const recovery = preserveCommit(input.runGit, input.repository, input.head);
    writeVerifiedRecord({
      version: 1,
      kind: "commit",
      repository: input.repository,
      head: input.head,
      branch: input.branch,
      worktree: input.worktree,
      ...recovery,
    });
    return true;
  } catch (err) {
    log.warn("loop retained ref because commit recovery archival failed", {
      err,
      data: { repository: input.repository, branch: input.branch },
    });
    return false;
  }
}

export function archiveMissingLoopWorktree(
  input: RecoveryInput & { sourceWorktree: string },
): boolean {
  const listed = input.runGit({
    cwd: input.sourceWorktree,
    args: ["worktree", "list", "--porcelain"],
  });
  if (listed.status !== 0) return false;
  const block = listed.stdout
    .split(/\r?\n\r?\n/)
    .find((entry) => entry.split(/\r?\n/).includes(`worktree ${input.worktree}`));
  const head = block?.match(/^HEAD ([a-f\d]{40,64})$/im)?.[1];
  return (
    head !== undefined &&
    archiveLoopCommit({
      repository: input.sourceWorktree,
      head,
      worktree: input.worktree,
      ...(input.expectedBranch === undefined ? {} : { branch: input.expectedBranch }),
      runGit: input.runGit,
    })
  );
}
