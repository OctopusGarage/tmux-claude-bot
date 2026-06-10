import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CurrentProjectManager } from "../src/core/currentProject.js";

describe("CurrentProjectManager (per-channel)", () => {
  let tempDir: string;
  let manager: CurrentProjectManager;
  const file = (): string => path.join(tempDir, ".current_project");

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "current-project-test-"));
    manager = new CurrentProjectManager(tempDir);
  });
  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("returns null per channel when nothing is set", async () => {
    expect(await manager.get("telegram")).toBeNull();
    expect(await manager.get("lark")).toBeNull();
  });

  it("keeps each channel's current project isolated", async () => {
    await manager.set("telegram", "sess_A");
    await manager.set("lark", "sess_B");
    expect(await manager.get("telegram")).toBe("sess_A");
    expect(await manager.get("lark")).toBe("sess_B");
    // Switching one must not affect the other.
    await manager.set("telegram", "sess_C");
    expect(await manager.get("telegram")).toBe("sess_C");
    expect(await manager.get("lark")).toBe("sess_B");
  });

  it("concurrent set on different channels does not lose an update", async () => {
    // Without the mutate() lock the cached read-modify-write races and one wins.
    await Promise.all([manager.set("telegram", "sess_A"), manager.set("lark", "sess_B")]);
    expect(await manager.get("telegram")).toBe("sess_A");
    expect(await manager.get("lark")).toBe("sess_B");
  });

  it("persists as JSON and reloads", async () => {
    await manager.set("telegram", "sess_A");
    await manager.set("lark", "sess_B");
    expect(JSON.parse(fs.readFileSync(file(), "utf-8"))).toEqual({
      telegram: "sess_A",
      lark: "sess_B",
    });
    const reloaded = new CurrentProjectManager(tempDir);
    expect(await reloaded.get("telegram")).toBe("sess_A");
    expect(await reloaded.get("lark")).toBe("sess_B");
  });

  it("migrates a legacy plain-string file to both channels", async () => {
    fs.writeFileSync(file(), "tmux_proj_legacy", "utf-8");
    expect(await manager.get("telegram")).toBe("tmux_proj_legacy");
    expect(await manager.get("lark")).toBe("tmux_proj_legacy");
  });

  it("clear(channel) removes only that channel", async () => {
    await manager.set("telegram", "sess_A");
    await manager.set("lark", "sess_B");
    await manager.clear("telegram");
    expect(await manager.get("telegram")).toBeNull();
    expect(await manager.get("lark")).toBe("sess_B");
  });

  it("clearSession drops a session from every channel that points at it", async () => {
    await manager.set("telegram", "shared");
    await manager.set("lark", "shared");
    await manager.clearSession("shared");
    expect(await manager.get("telegram")).toBeNull();
    expect(await manager.get("lark")).toBeNull();
  });

  it("clearSession leaves channels that point elsewhere", async () => {
    await manager.set("telegram", "gone");
    await manager.set("lark", "kept");
    await manager.clearSession("gone");
    expect(await manager.get("telegram")).toBeNull();
    expect(await manager.get("lark")).toBe("kept");
  });

  it("getAny prefers telegram, falls back to lark", async () => {
    expect(await manager.getAny()).toBeNull();
    await manager.set("lark", "only_lark");
    expect(await manager.getAny()).toBe("only_lark");
    await manager.set("telegram", "tg");
    expect(await manager.getAny()).toBe("tg");
  });

  it("allCurrent returns distinct sessions across channels", async () => {
    expect(await manager.allCurrent()).toEqual([]);
    await manager.set("telegram", "A");
    await manager.set("lark", "A");
    expect(await manager.allCurrent()).toEqual(["A"]); // deduped
    await manager.set("lark", "B");
    expect((await manager.allCurrent()).sort()).toEqual(["A", "B"]);
  });

  it("handles unicode / special chars and survives reload", async () => {
    const name = "tmux_proj_测试_/path with spaces_123";
    await manager.set("telegram", name);
    expect(await manager.get("telegram")).toBe(name);
    expect(await new CurrentProjectManager(tempDir).get("telegram")).toBe(name);
  });
});
