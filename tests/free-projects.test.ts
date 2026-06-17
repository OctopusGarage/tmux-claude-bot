import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  allocateFreeSlot,
  FREE_PROJECT_LIMIT,
  freeLabel,
  freeSessionName,
  freeSlotOf,
  getFreeProject,
  listFreeSlots,
  releaseFreeSlot,
  setFreeProject,
} from "../src/core/projects/free-projects.js";

let dir: string;
let orig: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tcb-free-"));
  orig = process.env.TCB_STATE_DIR;
  process.env.TCB_STATE_DIR = dir;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  if (orig === undefined) delete process.env.TCB_STATE_DIR;
  else process.env.TCB_STATE_DIR = orig;
});

const P = "tmux_proj_";

describe("free session naming", () => {
  it("builds and parses a free session name", () => {
    expect(freeSessionName(P, 3)).toBe("tmux_proj_free_3");
    expect(freeSlotOf("tmux_proj_free_3", P)).toBe(3);
  });

  it("does not treat a path-derived session as free", () => {
    expect(freeSlotOf("tmux_proj_-Users-x-free_1", P)).toBeNull();
  });
});

describe("slot allocation", () => {
  it("allocates the lowest free slot and skips used ones", () => {
    expect(allocateFreeSlot()).toBe(1);
    setFreeProject(1, { label: "a" });
    setFreeProject(3, { label: null });
    expect(listFreeSlots()).toEqual([1, 3]);
    expect(allocateFreeSlot()).toBe(2);
  });

  it("returns null when all slots are used", () => {
    for (let n = 1; n <= FREE_PROJECT_LIMIT; n++) setFreeProject(n, { label: null });
    expect(allocateFreeSlot()).toBeNull();
  });

  it("releases a slot so it can be reused", () => {
    setFreeProject(2, { label: null });
    expect(releaseFreeSlot(2)).toBe(true);
    expect(getFreeProject(2)).toBeNull();
    expect(allocateFreeSlot()).toBe(1);
  });
});

describe("freeLabel", () => {
  it("uses the label, else Free #n, and appends a path basename", () => {
    expect(freeLabel(2, { label: "feature-x" }, "/foo/bar")).toBe("🆓 feature-x · bar");
    expect(freeLabel(5, null, null)).toBe("🆓 Free #5");
    expect(freeLabel(5, { label: null }, null)).toBe("🆓 Free #5");
  });
});
