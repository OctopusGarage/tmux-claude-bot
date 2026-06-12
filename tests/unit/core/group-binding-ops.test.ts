import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveWorkspaceTarget } from "../../../src/core/group-binding-ops.js";

function depsWith(cdAllowedDirs: string[]) {
  return {
    config: { cdAllowedDirs, projectSessionPrefix: "claude_" },
  } as unknown as Parameters<typeof resolveWorkspaceTarget>[0];
}

describe("resolveWorkspaceTarget", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tcb-ws-"));
    process.env.TCB_STATE_DIR = dir;
  });
  afterEach(() => {
    delete process.env.TCB_STATE_DIR;
  });

  it("resolves an allow-listed absolute path to {path, sessionName, label}", async () => {
    const out = await resolveWorkspaceTarget(depsWith([dir]), dir);
    expect("error" in out).toBe(false);
    if (!("error" in out)) {
      expect(out.workspacePath).toBe(dir);
      expect(out.sessionName).toBe(`claude_${dir.replace(/\//g, "-")}`);
      expect(out.label).toBe(dir.split("/").pop());
    }
  });

  it("rejects a path outside the cd allow-list", async () => {
    const out = await resolveWorkspaceTarget(depsWith(["/some/other/root"]), dir);
    expect(out).toEqual({ error: "not-allowed", resolvedPath: dir });
  });

  it("rejects a non-existent path", async () => {
    const out = await resolveWorkspaceTarget(depsWith([]), join(dir, "nope"));
    expect("error" in out && out.error).toBe("not-found");
  });
});
