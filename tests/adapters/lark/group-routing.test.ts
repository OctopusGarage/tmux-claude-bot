import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(import("../../../src/core/voice-support.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    checkVoiceSupport: () => ({ ready: false, reason: "not-installed" }),
    resolveWhisperLanguage: () => "en",
  };
});

const { makeMessageHandler } = await import("../../../src/adapters/lark/handlers.js");
const { fakeChannel, fakeDeps, fakeMessage } = await import("./_fakes.js");
const { bindGroup } = await import("../../../src/core/group-bindings.js");

describe("lark bound-group routing", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tcb-route-"));
    process.env.TCB_STATE_DIR = dir;
    vi.clearAllMocks();
  });
  afterEach(() => {
    delete process.env.TCB_STATE_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("ignores a message from an UNBOUND group (no send, no enqueue)", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps();
    const handler = makeMessageHandler(channel, deps);

    await handler(fakeMessage({ chatType: "group" as never, chatId: "oc_unbound", content: "hi" }));

    expect(channel.sent).toHaveLength(0);
    expect(deps.queue.enqueued).toHaveLength(0);
  });

  it("ignores a bound-group message from a NON-allowlisted sender", async () => {
    bindGroup("oc_bound", { workspacePath: dir, sessionName: "proj-1", label: "projX" });
    const channel = fakeChannel();
    const deps = fakeDeps(); // allowed = {"ou_me"}
    const handler = makeMessageHandler(channel, deps);

    await handler(
      fakeMessage({
        chatType: "group" as never,
        chatId: "oc_bound",
        senderId: "ou_intruder",
        content: "hi",
      }),
    );

    expect(channel.sent).toHaveLength(0);
    expect(deps.queue.enqueued).toHaveLength(0);
  });

  it("routes a bound-group message (allowed sender, no @) and self-heals via reconcile", async () => {
    bindGroup("oc_bound", { workspacePath: dir, sessionName: "proj-1", label: "projX" });
    const channel = fakeChannel();
    const deps = fakeDeps(); // hasSession() -> false, so reconcile re-anchors -> "restored"
    const handler = makeMessageHandler(channel, deps);

    await handler(
      fakeMessage({ chatType: "group" as never, chatId: "oc_bound", content: "do something" }),
    );

    // reconcile ran synchronously and re-anchored the dead session
    expect(deps.bridge.createSession).toHaveBeenCalled();
    // and reported the restore to the group
    expect(channel.texts().some((t) => t.includes("projX"))).toBe(true);
  });

  it("does NOT auto-reconcile a binding-management command (/unbind)", async () => {
    bindGroup("oc_bound", { workspacePath: dir, sessionName: "proj-1", label: "projX" });
    const channel = fakeChannel();
    const deps = fakeDeps();
    const handler = makeMessageHandler(channel, deps);

    await handler(
      fakeMessage({ chatType: "group" as never, chatId: "oc_bound", content: "/unbind" }),
    );

    // /unbind manages the binding itself: reconcile must NOT have re-anchored
    expect(deps.bridge.createSession).not.toHaveBeenCalled();
    // and it replied with the unbound confirmation (a send happened)
    expect(channel.sent.length).toBeGreaterThan(0);
  });
});
