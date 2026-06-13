import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Use a temp dir for all cache operations — avoids touching ~/.tmux-claude-bot
let cacheDir: string;
let origEnv: string | undefined;

beforeEach(() => {
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "tcb-media-cache-"));
  origEnv = process.env.TCB_MEDIA_DIR;
  process.env.TCB_MEDIA_DIR = cacheDir;
});

afterEach(() => {
  fs.rmSync(cacheDir, { recursive: true, force: true });
  if (origEnv === undefined) delete process.env.TCB_MEDIA_DIR;
  else process.env.TCB_MEDIA_DIR = origEnv;
});

// Import after env is set — but since TCB_MEDIA_DIR is module-level, we use
// dynamic imports inside each test. Simpler: let the module read the env at
// call time via a getter (which is what CACHE_DIR does as a const at module
// load). So we need to reimport per test-run or test in a single worker where
// the env is already set via beforeEach. Since vitest runs tests sequentially
// in the same worker, the module is loaded once with the FIRST value of
// TCB_MEDIA_DIR. To work around this, we pass cacheDir at call time through
// the env and re-import with vi.resetModules().

describe("media-cache", () => {
  it("getFromCache returns null when the file is not cached", async () => {
    // The module reads CACHE_DIR at import time, so we isolate via resetModules.
    const { vi } = await import("vitest");
    vi.resetModules();
    const { getFromCache } = await import("../src/shared/utils/media-cache.js");
    expect(getFromCache("no-such-key")).toBeNull();
  });

  it("getFromCache returns the path when the file exists", async () => {
    const { vi } = await import("vitest");
    vi.resetModules();
    const { getFromCache, saveToCache } = await import("../src/shared/utils/media-cache.js");

    // Write a source file and cache it.
    const src = path.join(cacheDir, "src.opus");
    fs.writeFileSync(src, "audio-data");
    const cachedPath = saveToCache("mykey", src);

    expect(typeof cachedPath).toBe("string");
    expect(cachedPath).not.toBe(src); // should be a different path (the cache path)
    expect(getFromCache("mykey")).toBe(cachedPath);
  });

  it("saveToCache returns source path when copy fails (e.g. source does not exist)", async () => {
    const { vi } = await import("vitest");
    vi.resetModules();
    const { saveToCache } = await import("../src/shared/utils/media-cache.js");

    const nonexistent = "/tmp/does-not-exist-xyz-1234.opus";
    const result = saveToCache("failkey", nonexistent);
    expect(result).toBe(nonexistent);
  });

  it("evicts oldest entries so the cache stays bounded (no unbounded disk growth)", async () => {
    // Regression: saveToCache used to be write-only with no eviction, so every
    // distinct voice/audio blob accumulated forever until the disk filled and
    // real state writes (locks, session map) started failing.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tcb-media-bound-"));
    const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "tcb-media-src-"));
    process.env.TCB_MEDIA_DIR = dir;
    process.env.TCB_MEDIA_CACHE_MAX = "2";
    try {
      const { saveToCache } = await import("../src/shared/utils/media-cache.js");
      for (const k of ["k1", "k2", "k3", "k4"]) {
        const src = path.join(srcDir, `${k}.opus`);
        fs.writeFileSync(src, k);
        saveToCache(k, src);
      }
      // Sources live in srcDir, so everything in `dir` is a cached blob.
      expect(fs.readdirSync(dir).length).toBe(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(srcDir, { recursive: true, force: true });
      delete process.env.TCB_MEDIA_CACHE_MAX;
    }
  });

  it("resolves the cache dir on every call so a TCB_MEDIA_DIR change takes effect", async () => {
    // Regression: CACHE_DIR was captured at module load, so a later env change
    // (tests, dev-borrow) silently read/wrote the previous home.
    const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "tcb-media-src2-"));
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "tcb-media-redir-"));
    try {
      const { saveToCache } = await import("../src/shared/utils/media-cache.js");
      process.env.TCB_MEDIA_DIR = dir2; // change AFTER the module is already imported
      const src = path.join(srcDir, "s.opus");
      fs.writeFileSync(src, "x");
      const cached = saveToCache("redir", src);
      expect(cached.startsWith(dir2)).toBe(true);
    } finally {
      fs.rmSync(srcDir, { recursive: true, force: true });
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  });
});
