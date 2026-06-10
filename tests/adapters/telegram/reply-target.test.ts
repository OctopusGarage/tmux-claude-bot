import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReplyTargetMap } from "../../../src/adapters/telegram/reply-target.js";

vi.mock("../../../src/shared/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe("createReplyTargetMap", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "tcb-rt-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("records and resolves a message → session mapping", () => {
    const m = createReplyTargetMap(dir);
    m.record(100, "sess_a");
    expect(m.resolveReplyTarget(100)).toBe("sess_a");
    expect(m.resolveReplyTarget(999)).toBeNull();
  });

  it("evicts the oldest 20 once it reaches 100 entries", () => {
    const m = createReplyTargetMap(dir);
    for (let i = 1; i <= 100; i++) m.record(i, `s${i}`);
    // The 100th record triggers eviction of the 20 lowest ids (1..20).
    expect(m.resolveReplyTarget(1)).toBeNull();
    expect(m.resolveReplyTarget(20)).toBeNull();
    expect(m.resolveReplyTarget(21)).toBe("s21");
    expect(m.resolveReplyTarget(100)).toBe("s100");
  });

  it("removeSession drops every entry pointing at that session", () => {
    const m = createReplyTargetMap(dir);
    m.record(1, "sess_x");
    m.record(2, "sess_y");
    m.record(3, "sess_x");
    m.removeSession("sess_x");
    expect(m.resolveReplyTarget(1)).toBeNull();
    expect(m.resolveReplyTarget(3)).toBeNull();
    expect(m.resolveReplyTarget(2)).toBe("sess_y");
  });

  it("resets to empty (no throw) on a corrupted backing file", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(nodePath.join(dir, "reply_target_map.json"), "{ not json", "utf-8");
    const m = createReplyTargetMap(dir);
    expect(m.resolveReplyTarget(1)).toBeNull(); // graceful reset, not a crash
    m.record(5, "sess_ok");
    expect(m.resolveReplyTarget(5)).toBe("sess_ok");
  });
});
