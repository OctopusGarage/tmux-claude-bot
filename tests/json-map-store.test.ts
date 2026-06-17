import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { JsonMapStore } from "../src/core/infra/json-map-store.js";

const filePath = (): string => path.join(process.env.TCB_STATE_DIR ?? "", "test-store.json");

/** Overwrite the file directly (as another process would) and force a newer
 * mtime so the store's mtime-keyed cache is guaranteed to notice the change. */
function foreignWrite(content: string): void {
  fs.writeFileSync(filePath(), content);
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(filePath(), future, future);
}

describe("JsonMapStore", () => {
  beforeEach(() => {
    process.env.TCB_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tcb-store-test-"));
  });

  it("set / get / has / sortedEntries round-trip", () => {
    const store = new JsonMapStore<string>("test-store.json");
    store.set("b", "2");
    store.set("a", "1");
    expect(store.get("a")).toBe("1");
    expect(store.has("b")).toBe(true);
    expect(store.has("missing")).toBe(false);
    expect(store.get("missing")).toBeUndefined();
    expect(store.sortedEntries()).toEqual([
      ["a", "1"],
      ["b", "2"],
    ]);
  });

  it("delete returns true when present, false when absent", () => {
    const store = new JsonMapStore<string>("test-store.json");
    store.set("a", "1");
    expect(store.delete("a")).toBe(true);
    expect(store.has("a")).toBe(false);
    expect(store.delete("a")).toBe(false);
  });

  it("missing file reads as an empty map", () => {
    const store = new JsonMapStore<string>("test-store.json");
    expect(store.has("x")).toBe(false);
    expect(store.sortedEntries()).toEqual([]);
  });

  it("picks up a write from another process (mtime invalidates the cache)", () => {
    const store = new JsonMapStore<string>("test-store.json");
    store.set("a", "1");
    expect(store.get("a")).toBe("1"); // primes the cache

    // Simulate claude-tmux rewriting session_path_map.json out-of-band.
    foreignWrite(JSON.stringify({ a: "2", b: "3" }));

    expect(store.get("a")).toBe("2");
    expect(store.get("b")).toBe("3");
  });

  it("treats a corrupt file with no prior data as empty and can still write over it", () => {
    fs.writeFileSync(filePath(), "not json{");
    const store = new JsonMapStore<string>("test-store.json");
    expect(store.get("x")).toBeUndefined();
    store.set("x", "ok");
    expect(store.get("x")).toBe("ok");
  });

  it("does NOT wipe good data when the file becomes corrupt — serves last-good and preserves it on write", () => {
    const store = new JsonMapStore<string>("test-store.json");
    store.set("a", "1");
    store.set("b", "2"); // good data persisted, cache primed

    // The file gets corrupted out-of-band (truncation / concurrent-write race).
    foreignWrite("not jso{");

    // A read must serve the last-good map, never an empty one.
    expect(store.get("a")).toBe("1");
    expect(store.get("b")).toBe("2");

    // …and the next write (e.g. binding a new group) must merge onto the real
    // data, not onto {} — otherwise every prior entry would be wiped at once.
    store.set("c", "3");
    const fresh = new JsonMapStore<string>("test-store.json");
    expect(fresh.sortedEntries()).toEqual([
      ["a", "1"],
      ["b", "2"],
      ["c", "3"],
    ]);
  });

  it("treats valid-but-non-object JSON (null / array / number) as corruption, not data", () => {
    for (const bad of ["null", "[]", "123", '"a string"']) {
      process.env.TCB_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tcb-store-nonobj-"));
      fs.writeFileSync(filePath(), bad);
      const store = new JsonMapStore<string>("test-store.json");
      // Must NOT throw `key in null` / `null[key]` — these are the hot-path ops.
      expect(() => store.has("x")).not.toThrow();
      expect(store.has("x")).toBe(false);
      expect(store.get("x")).toBeUndefined();
      // and a write can still recover the file
      store.set("x", "ok");
      expect(new JsonMapStore<string>("test-store.json").get("x")).toBe("ok");
    }
  });

  it("does not wipe good data when the file becomes non-object JSON (serves last-good)", () => {
    const store = new JsonMapStore<string>("test-store.json");
    store.set("a", "1");
    foreignWrite("null"); // parses, but is not a map
    expect(store.get("a")).toBe("1"); // last-good served, not undefined
    store.set("b", "2");
    expect(new JsonMapStore<string>("test-store.json").sortedEntries()).toEqual([
      ["a", "1"],
      ["b", "2"],
    ]);
  });

  it("repeated reads of a stable corrupt file do not re-backup (cache stamped)", () => {
    const store = new JsonMapStore<string>("test-store.json");
    store.set("a", "1");
    foreignWrite("}{ broken");
    store.get("a"); // first corrupt read → writes .corrupt
    const firstStat = fs.statSync(`${filePath()}.corrupt`);
    store.get("a"); // same identity → served from cache, no re-backup
    store.get("a");
    // The backup file was not rewritten (same mtime) because the cache was stamped.
    expect(fs.statSync(`${filePath()}.corrupt`).mtimeMs).toBe(firstStat.mtimeMs);
  });

  it("backs up a corrupt file to <file>.corrupt for recovery", () => {
    const store = new JsonMapStore<string>("test-store.json");
    store.set("a", "1");
    foreignWrite("}{ broken");
    store.get("a"); // triggers the corrupt read
    expect(fs.readFileSync(`${filePath()}.corrupt`, "utf-8")).toBe("}{ broken");
  });

  it("picks up an atomic same-size foreign write even when mtime collides (inode key)", () => {
    const store = new JsonMapStore<string>("test-store.json");
    store.set("a", "1");
    expect(store.get("a")).toBe("1"); // primes the cache

    // An atomic foreign write (temp + rename, as the claude-tmux helper does)
    // with the SAME byte length and a colliding mtime — an mtime+size key would
    // miss it, but the rename swaps the inode, which the store also keys on.
    const stat = fs.statSync(filePath());
    const tmp = `${filePath()}.foreign`;
    fs.writeFileSync(tmp, JSON.stringify({ a: "9" })); // same length as {"a":"1"}
    fs.renameSync(tmp, filePath());
    fs.utimesSync(filePath(), stat.atime, stat.mtime); // force the old mtime back
    expect(store.get("a")).toBe("9");
  });

  it("persists across store instances pointing at the same file", () => {
    new JsonMapStore<string>("test-store.json").set("k", "v");
    // A fresh instance (e.g. after a restart) sees the persisted value.
    expect(new JsonMapStore<string>("test-store.json").get("k")).toBe("v");
  });
});
