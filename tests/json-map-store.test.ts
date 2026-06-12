import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { JsonMapStore } from "../src/core/json-map-store.js";

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

  it("treats a corrupt file as empty and can still write over it", () => {
    fs.writeFileSync(filePath(), "not json{");
    const store = new JsonMapStore<string>("test-store.json");
    expect(store.get("x")).toBeUndefined();
    store.set("x", "ok");
    expect(store.get("x")).toBe("ok");
  });

  it("persists across store instances pointing at the same file", () => {
    new JsonMapStore<string>("test-store.json").set("k", "v");
    // A fresh instance (e.g. after a restart) sees the persisted value.
    expect(new JsonMapStore<string>("test-store.json").get("k")).toBe("v");
  });
});
