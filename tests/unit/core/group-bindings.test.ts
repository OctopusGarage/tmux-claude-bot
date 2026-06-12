import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("group-bindings registry", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tcb-gb-"));
    process.env.TCB_STATE_DIR = dir;
  });
  afterEach(() => {
    delete process.env.TCB_STATE_DIR;
  });

  it("binds, reads, lists and unbinds by chat_id", async () => {
    const m = await import("../../../src/core/group-bindings.js");
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
});
