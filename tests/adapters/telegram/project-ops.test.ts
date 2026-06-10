import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Control the recents list without touching the real recent_projects.txt in cwd.
const recentLines: string[] = [];
vi.mock("../../../src/core/recentProjects.js", () => ({
  readRecentProjectLines: vi.fn(async () => recentLines.slice()),
  appendRecentProject: vi.fn(async () => {}),
}));

import { addRecentProjectBySid } from "../../../src/adapters/telegram/project-ops.js";
import { createReplyTargetMap } from "../../../src/adapters/telegram/reply-target.js";
import { sessionNameFromPath } from "../../../src/core/sessionPathMap.js";
import { sessionShortId } from "../../../src/shared/utils/hash.js";
import { fakeCtx, fakeDeps } from "./_fakes.js";

const PREFIX = "tmux_proj_";
const replyTarget = createReplyTargetMap(`/tmp/tg-projops-rt-${Date.now()}`);

const sidFor = (projectPath: string): string =>
  sessionShortId(sessionNameFromPath(projectPath, PREFIX));

describe("addRecentProjectBySid", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recentLines.length = 0;
  });

  it("replies 'not found' when the sid matches no recent project", async () => {
    const ctx = fakeCtx();
    const deps = fakeDeps();

    await addRecentProjectBySid(deps, ctx, "nosuch", replyTarget);

    expect(ctx.texts().some((t) => t.includes("未找到短 ID"))).toBe(true);
  });

  it("switches (no create) when the session already exists", async () => {
    const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "tg-recent-exists-"));
    recentLines.push(dir);
    const ctx = fakeCtx();
    const setCurrent = vi.fn(async () => {});
    const deps = fakeDeps({
      config: { cdAllowedDirs: [dir], projectSessionPrefix: PREFIX, sessionWarmupMs: 0 },
      bridge: { hasSession: vi.fn(async () => true) },
      currentProject: { set: setCurrent },
    });

    await addRecentProjectBySid(deps, ctx, sidFor(dir), replyTarget);

    expect(setCurrent).toHaveBeenCalled();
    expect(deps.bridge.createSession).not.toHaveBeenCalled();
    expect(ctx.texts().some((t) => t.includes("已切换"))).toBe(true);
  });

  it("rejects a path outside cdAllowedDirs (no create)", async () => {
    const denyDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "tg-recent-deny-"));
    const allowDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "tg-recent-allow-"));
    recentLines.push(denyDir);
    const ctx = fakeCtx();
    const deps = fakeDeps({
      config: { cdAllowedDirs: [allowDir], projectSessionPrefix: PREFIX, sessionWarmupMs: 0 },
      bridge: { hasSession: vi.fn(async () => false) },
    });

    await addRecentProjectBySid(deps, ctx, sidFor(denyDir), replyTarget);

    expect(ctx.texts().some((t) => t.includes("路径不在允许列表"))).toBe(true);
    expect(deps.bridge.createSession).not.toHaveBeenCalled();
  });

  it("creates a new allowed project session", async () => {
    const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "tg-recent-create-"));
    recentLines.push(dir);
    const ctx = fakeCtx();
    const createSession = vi.fn(async () => {});
    const setCurrent = vi.fn(async () => {});
    const deps = fakeDeps({
      config: { cdAllowedDirs: [dir], projectSessionPrefix: PREFIX, sessionWarmupMs: 0 },
      bridge: { hasSession: vi.fn(async () => false), createSession },
      currentProject: { set: setCurrent },
    });

    await addRecentProjectBySid(deps, ctx, sidFor(dir), replyTarget);

    expect(createSession).toHaveBeenCalled();
    expect(setCurrent).toHaveBeenCalled();
    expect(deps.bridge.sendKeys).toHaveBeenCalled();
    expect(ctx.texts().some((t) => t.includes("项目已创建"))).toBe(true);
  });

  it("replies the error when session creation throws", async () => {
    const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "tg-recent-boom-"));
    recentLines.push(dir);
    const ctx = fakeCtx();
    const deps = fakeDeps({
      config: { cdAllowedDirs: [dir], projectSessionPrefix: PREFIX, sessionWarmupMs: 0 },
      bridge: {
        hasSession: vi.fn(async () => false),
        createSession: vi.fn(async () => {
          throw new Error("create boom");
        }),
      },
    });

    await addRecentProjectBySid(deps, ctx, sidFor(dir), replyTarget);

    expect(ctx.texts().some((t) => t.includes("create boom"))).toBe(true);
  });
});
