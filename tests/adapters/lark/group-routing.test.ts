import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(import("../../../src/core/read/voice-support.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    checkVoiceSupport: () => ({ ready: false, reason: "not-installed" }),
    resolveWhisperLanguage: () => "en",
  };
});

const { makeMessageHandler } = await import("../../../src/adapters/lark/handlers.js");
const { fakeChannel, fakeDeps, fakeMessage } = await import("./_fakes.js");
const { bindGroup } = await import("../../../src/core/projects/group-bindings.js");
const { messages } = await import("../../../src/core/i18n/index.js");

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

  it("lets an allow-listed user run a recovery command (/restore) in an UNBOUND group", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps();
    const handler = makeMessageHandler(channel, deps);

    // A group that lost its binding must NOT be bricked: recovery commands are
    // processed in place (here /restore replies "not bound" — the point is it ran
    // instead of being silently dropped, so the user can re-bind without
    // recreating the group).
    await handler(
      fakeMessage({ chatType: "group" as never, chatId: "oc_unbound", content: "/restore" }),
    );

    expect(channel.sent.length).toBeGreaterThan(0);
  });

  it("still drops a plain prompt in an UNBOUND group (only recovery commands pass)", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps();
    const handler = makeMessageHandler(channel, deps);

    await handler(
      fakeMessage({ chatType: "group" as never, chatId: "oc_unbound", content: "just chatting" }),
    );

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

  it("surfaces a handler error (e.g. tmux briefly down) to the chat instead of throwing", async () => {
    bindGroup("oc_bound", { workspacePath: dir, sessionName: "proj-1", label: "projX" });
    const channel = fakeChannel();
    const deps = fakeDeps({
      bridge: {
        hasSession: vi.fn(async () => {
          throw new Error("tmux server down");
        }),
      },
    });
    const handler = makeMessageHandler(channel, deps);

    // The boundary must swallow the throw (no unhandled rejection)…
    await expect(
      handler(fakeMessage({ chatType: "group" as never, chatId: "oc_bound", content: "do x" })),
    ).resolves.toBeUndefined();
    // …and tell the user, who can then /restore.
    expect(channel.texts()).toContain(messages("lark").handlerError);
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
