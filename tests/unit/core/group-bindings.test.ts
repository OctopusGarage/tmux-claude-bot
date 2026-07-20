import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("group-bindings registry", () => {
  let dir: string;
  beforeEach(() => {
    vi.resetModules();
    dir = mkdtempSync(join(tmpdir(), "tcb-gb-"));
    process.env.TCB_STATE_DIR = dir;
  });
  afterEach(() => {
    delete process.env.TCB_STATE_DIR;
    rmSync(dir, { recursive: true, force: true });
    vi.resetModules();
  });

  it("binds, reads, lists and unbinds by chat_id", async () => {
    const m = await import("../../../src/core/projects/group-bindings.js");
    expect(m.getBinding("oc_1")).toBeNull();
    expect(m.isProjectGroup("oc_1")).toBe(false);

    m.bindGroup("oc_1", {
      workspacePath: "/home/user/projectA",
      sessionName: "claude_-home-user-projectA",
      label: "projectA",
    });

    expect(m.isProjectGroup("oc_1")).toBe(true);
    expect(m.getBinding("oc_1")?.label).toBe("projectA");
    expect(m.listBindings()).toEqual([
      {
        chatId: "oc_1",
        binding: {
          workspacePath: "/home/user/projectA",
          sessionName: "claude_-home-user-projectA",
          label: "projectA",
        },
      },
    ]);

    expect(m.unbindGroup("oc_1")).toBe(true);
    expect(m.unbindGroup("oc_1")).toBe(false);
    expect(m.isProjectGroup("oc_1")).toBe(false);
  });

  it("bindingForSession finds the group bound to a session (one workspace ↔ one group)", async () => {
    const m = await import("../../../src/core/projects/group-bindings.js");
    expect(m.bindingForSession("claude_-x")).toBeNull();

    m.bindGroup("oc_a", { workspacePath: "/p/x", sessionName: "claude_-x", label: "x" });
    expect(m.bindingForSession("claude_-x")?.chatId).toBe("oc_a");
    expect(m.bindingForSession("claude_-other")).toBeNull();
  });

  it("persists across module reloads and lists bindings by chat id", async () => {
    let m = await import("../../../src/core/projects/group-bindings.js");
    m.bindGroup("oc_b", { workspacePath: "/p/b", sessionName: "claude_-b", label: "b" });
    m.bindGroup("oc_a", { workspacePath: "/p/a", sessionName: "claude_-a", label: "a" });

    expect(m.listBindings().map(({ chatId }) => chatId)).toEqual(["oc_a", "oc_b"]);

    vi.resetModules();
    m = await import("../../../src/core/projects/group-bindings.js");

    expect(m.getBinding("oc_a")).toEqual({
      workspacePath: "/p/a",
      sessionName: "claude_-a",
      label: "a",
    });
    expect(m.bindingForSession("claude_-b")?.chatId).toBe("oc_b");
    expect(m.listBindings().map(({ chatId }) => chatId)).toEqual(["oc_a", "oc_b"]);
  });
});
