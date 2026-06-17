import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createBoundChat = vi.fn();
vi.mock(import("../../../src/adapters/lark/resource.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, createBoundChat: (...args: unknown[]) => createBoundChat(...args) };
});
vi.mock(import("../../../src/core/read/voice-support.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, resolveWhisperLanguage: () => "en" };
});

const { makeMessageHandler } = await import("../../../src/adapters/lark/handlers.js");
const { handleNewGroup, handleUnbind } = await import(
  "../../../src/adapters/lark/group-commands.js"
);
const { getBinding } = await import("../../../src/core/projects/group-bindings.js");
const { sessionNameFromPath } = await import("../../../src/core/projects/sessionPathMap.js");
const { fakeChannel, fakeDeps, fakeMessage } = await import("./_fakes.js");

/**
 * End-to-end group lifecycle on a STATEFUL in-memory bridge (state carries
 * across steps, unlike the per-test stateless fakes). One narrative exercises
 * the cross-step interactions that single-step unit tests miss:
 *
 *   create (p2p) → message (alive, no-op reconcile) → session dies →
 *   message (reconcile recreates) → unbind → message (group inert).
 */
describe("group lifecycle (stateful scenario)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tcb-life-"));
    process.env.TCB_STATE_DIR = dir;
    vi.clearAllMocks();
  });
  afterEach(() => {
    delete process.env.TCB_STATE_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  function statefulDeps() {
    const live = new Set<string>();
    const cur = new Map<string, string>();
    const bridge = {
      capturePane: vi.fn(async () => "PANE"),
      listProjectSessions: vi.fn(async () => [...live]),
      hasSession: vi.fn(async (n: string) => live.has(n)),
      createSession: vi.fn(async (n: string) => {
        if (live.has(n)) return false;
        live.add(n);
        return true;
      }),
      killSession: vi.fn(async (n: string) => {
        live.delete(n);
      }),
      sendKeys: vi.fn(async () => {}),
      sendExit: vi.fn(async () => {}),
      sendRawKey: vi.fn(async () => {}),
    };
    const currentProject = {
      get: vi.fn(async (scope: string) => cur.get(scope) ?? null),
      set: vi.fn(async (scope: string, s: string) => {
        cur.set(scope, s);
      }),
      clear: vi.fn(async (scope: string) => {
        cur.delete(scope);
      }),
      clearSession: vi.fn(async (s: string) => {
        for (const [k, v] of cur) if (v === s) cur.delete(k);
      }),
      getAny: vi.fn(async () => [...cur.values()][0] ?? null),
      allCurrent: vi.fn(async () => [...cur.values()]),
    };
    const deps = fakeDeps({
      bridge,
      currentProject,
      config: { cdAllowedDirs: [dir], sessionWarmupMs: 0 },
    });
    return { deps, live };
  }

  it("create → alive → die → auto-recreate → unbind → inert", async () => {
    const { deps, live } = statefulDeps();
    const channel = fakeChannel();
    const handler = makeMessageHandler(channel, deps);
    const sessionName = sessionNameFromPath(dir, deps.config.projectSessionPrefix);
    const groupId = "oc_made";

    // 1) Create the bound group from a private chat.
    createBoundChat.mockResolvedValue({ chatId: groupId, name: "proj" });
    await handleNewGroup(channel, deps, "ou_me", "p2p", "ou_me", dir);
    expect(getBinding(groupId)?.workspacePath).toBe(dir);
    expect(live.has(sessionName)).toBe(true);
    expect(deps.bridge.createSession).toHaveBeenCalledTimes(1);

    // 2) A message arrives while the session is alive: reconcile is a no-op
    //    (no recreate).
    await handler(fakeMessage({ chatType: "group" as never, chatId: groupId, content: "hello" }));
    expect(deps.bridge.createSession).toHaveBeenCalledTimes(1);

    // 3) The session dies out-of-band; the next message auto-recreates it.
    live.delete(sessionName);
    await handler(fakeMessage({ chatType: "group" as never, chatId: groupId, content: "again" }));
    expect(deps.bridge.createSession).toHaveBeenCalledTimes(2);
    expect(live.has(sessionName)).toBe(true);
    expect(channel.texts().some((t) => t.includes(basename(dir)))).toBe(true); // restore reply

    // 4) Unbind, then a message: the group is now inert (ignored, no recreate).
    await handleUnbind(channel, deps, groupId, "group");
    expect(getBinding(groupId)).toBeNull();
    const sentBefore = channel.sent.length;
    await handler(fakeMessage({ chatType: "group" as never, chatId: groupId, content: "ghost" }));
    expect(deps.bridge.createSession).toHaveBeenCalledTimes(2); // no recreate
    expect(channel.sent.length).toBe(sentBefore); // silent
    expect(deps.queue.enqueued).toHaveLength(0);
  });
});
