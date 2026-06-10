import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProjectSession, resolveProjectPath } from "../../src/core/project-ops.js";
import { fakeDeps } from "../adapters/lark/_fakes.js";

describe("resolveProjectPath", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tcb-pp-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("not-found for a missing path", async () => {
    const r = await resolveProjectPath(path.join(dir, "nope"), []);
    expect(r.error).toBe("not-found");
  });

  it("not-a-directory for a file", async () => {
    const file = path.join(dir, "f.txt");
    fs.writeFileSync(file, "x");
    const r = await resolveProjectPath(file, []);
    expect(r.error).toBe("not-a-directory");
  });

  it("not-allowed when outside the cd allow-list", async () => {
    const r = await resolveProjectPath(dir, ["/some/other/allowed/root"]);
    expect(r.error).toBe("not-allowed");
  });

  it("ok for an existing, allow-listed directory (empty allow-list = allow all)", async () => {
    const r = await resolveProjectPath(dir, []);
    expect(r.error).toBeUndefined();
    expect(r.resolvedPath).toBe(dir); // path.resolve of an already-absolute path
  });
});

describe("createProjectSession", () => {
  it("creates the session, sets it current, and cds into the EXPLICIT session", async () => {
    const deps = fakeDeps();
    await createProjectSession(deps, "lark", "tmux_proj_x", "/path/x");

    expect(deps.bridge.createSession).toHaveBeenCalledWith("tmux_proj_x");
    expect(deps.currentProject.set).toHaveBeenCalledWith("lark", "tmux_proj_x");
    // The cd MUST target the named session, not the channel default — otherwise a
    // Feishu create could land its cd in Telegram's current session.
    expect(deps.bridge.sendKeys).toHaveBeenCalledWith('cd "/path/x"', "tmux_proj_x");
  });

  it("passes the channel through to currentProject.set", async () => {
    const deps = fakeDeps();
    await createProjectSession(deps, "telegram", "tmux_proj_y", "/path/y");
    expect(deps.currentProject.set).toHaveBeenCalledWith("telegram", "tmux_proj_y");
  });
});
