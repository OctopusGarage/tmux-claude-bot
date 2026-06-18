import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoundedSessionMap } from "../src/core/infra/bounded-session-map.js";

vi.mock("../src/shared/utils/logger.js", () => {
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { logger: log, createLogger: () => log };
});

describe("BoundedSessionMap", () => {
  let dir: string;
  const file = (): string => nodePath.join(dir, "map.json");
  beforeEach(() => {
    dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "tcb-bsm-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("records and resolves; unknown id is undefined", () => {
    const m = new BoundedSessionMap<number>({ max: 10 });
    m.record(1, "a");
    expect(m.resolve(1)).toBe("a");
    expect(m.resolve(2)).toBeUndefined();
  });

  it("drops the oldest entry once over the cap", () => {
    const m = new BoundedSessionMap<number>({ max: 3 });
    for (const i of [1, 2, 3, 4]) m.record(i, `s${i}`);
    expect(m.resolve(1)).toBeUndefined(); // oldest evicted
    expect(m.resolve(2)).toBe("s2");
    expect(m.resolve(4)).toBe("s4");
  });

  it("removeSession drops every entry for that session, keeps others", () => {
    const m = new BoundedSessionMap<string>({ max: 10 });
    m.record("a", "x");
    m.record("b", "y");
    m.record("c", "x");
    m.removeSession("x");
    expect(m.resolve("a")).toBeUndefined();
    expect(m.resolve("c")).toBeUndefined();
    expect(m.resolve("b")).toBe("y");
  });

  it("clear empties the map and the backing file", () => {
    const m = new BoundedSessionMap<number>({ max: 10, file: file() });
    m.record(1, "a");
    m.clear();
    expect(m.resolve(1)).toBeUndefined();
    expect(new BoundedSessionMap<number>({ max: 10, file: file() }).resolve(1)).toBeUndefined();
  });

  it("persists across instances, round-tripping numeric keys", () => {
    new BoundedSessionMap<number>({ max: 10, file: file() }).record(42, "sess");
    expect(new BoundedSessionMap<number>({ max: 10, file: file() }).resolve(42)).toBe("sess");
  });

  it("persists across instances, round-tripping string keys", () => {
    new BoundedSessionMap<string>({ max: 10, file: file() }).record("om_x", "sess");
    expect(new BoundedSessionMap<string>({ max: 10, file: file() }).resolve("om_x")).toBe("sess");
  });

  it("a corrupt backing file resets to empty (no throw) and stays usable", () => {
    fs.writeFileSync(file(), "{ not json", "utf-8");
    const m = new BoundedSessionMap<number>({ max: 10, file: file() });
    expect(m.resolve(1)).toBeUndefined();
    m.record(1, "ok");
    expect(m.resolve(1)).toBe("ok");
  });

  it("without a file, stays in memory and writes nothing", () => {
    const m = new BoundedSessionMap<number>({ max: 10 });
    m.record(1, "a");
    expect(fs.readdirSync(dir)).toHaveLength(0);
    expect(m.resolve(1)).toBe("a");
  });
});
