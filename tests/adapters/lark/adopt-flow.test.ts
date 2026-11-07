import type { CardActionEvent } from "@larksuiteoapi/node-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeCardActionHandler } from "../../../src/adapters/lark/card-actions.js";
import type { OrphanAgent } from "../../../src/core/agents/takeover.js";
import { adoptOrphan, findAdoptableOrphans } from "../../../src/core/agents/takeover-service.js";
import { messages } from "../../../src/core/i18n/index.js";
import { fakeChannel, fakeDeps } from "./_fakes.js";

vi.mock("../../../src/core/agents/takeover-service.js", async (load) => ({
  ...(await load<typeof import("../../../src/core/agents/takeover-service.js")>()),
  findAdoptableOrphans: vi.fn(),
  adoptOrphan: vi.fn(),
}));

const candidate: OrphanAgent = {
  pid: 55,
  pids: [55],
  cwd: "/fixture/project",
  configRoot: "/fixture/codex",
  sessionId: "019d3003-2649-7c40-a990-dc49ebb6ec3e",
  startCommand: "codex resume 019d3003-2649-7c40-a990-dc49ebb6ec3e",
  agent: "codex",
  busy: false,
};
function event(value: Record<string, unknown>): CardActionEvent {
  return {
    messageId: "fixture-message",
    chatId: "chat-1",
    operator: { openId: "ou_me" },
    action: { value, tag: "button" },
  } as CardActionEvent;
}
beforeEach(() => {
  vi.mocked(findAdoptableOrphans).mockReset();
  vi.mocked(adoptOrphan).mockReset();
});

describe("Lark Take over button responses", () => {
  it("returns parent task status and refreshes it on the confirmation screen", async () => {
    const channel = fakeChannel();
    const handle = makeCardActionHandler(channel, fakeDeps());
    vi.mocked(findAdoptableOrphans).mockResolvedValueOnce([candidate]);
    await handle(event({ cmd: "adoptlist" }));
    const list = JSON.stringify(channel.cards().at(-1));
    expect(list).toContain("019d3003");
    expect(list).toContain("task idle");
    expect(list).not.toContain("task unknown");
    vi.mocked(findAdoptableOrphans).mockResolvedValueOnce([{ ...candidate, busy: true }]);
    await handle(event({ cmd: "adopt", pid: 55 }));
    expect(JSON.stringify(channel.cards().at(-1))).toContain("task busy");
    expect(adoptOrphan).not.toHaveBeenCalled();
  });

  it("returns the actual takeover receipt after explicit confirmation", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps();
    vi.mocked(adoptOrphan).mockResolvedValueOnce({
      ok: true,
      resumed: true,
      sessionName: "tmux_proj_fixture",
    });
    await makeCardActionHandler(channel, deps)(event({ cmd: "adoptgo", pid: 55 }));
    expect(adoptOrphan).toHaveBeenCalledWith(55, expect.any(Object), { target: "path" });
    expect(JSON.stringify(channel.cards().at(-1))).toContain(
      messages("lark").adoptDone("tmux_proj_fixture", true),
    );
    expect(deps.currentProject.set).toHaveBeenCalledWith("lark:chat-1", "tmux_proj_fixture");
  });

  it("refreshes safely when an old button names an excluded helper", async () => {
    const channel = fakeChannel();
    vi.mocked(findAdoptableOrphans).mockResolvedValueOnce([candidate]);
    await makeCardActionHandler(channel, fakeDeps())(event({ cmd: "adopt", pid: 56 }));
    expect(channel.texts()).toContain(messages("lark").adoptGone);
    expect(adoptOrphan).not.toHaveBeenCalled();
  });
});
