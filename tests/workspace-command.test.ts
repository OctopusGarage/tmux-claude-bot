import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { HandlerDeps } from "../src/core/deps.js";
import { messages } from "../src/core/i18n/index.js";
import { runWorkspaceCommand, type WsReplyKind } from "../src/core/projects/workspace-command.js";

const m = messages("lark");
const last = <T>(a: readonly T[]): T | undefined => a[a.length - 1];

/** A minimal deps + a capturing send(); workspaces use the real (temp-dir) store. */
function harness(opts: { currentSession?: string | null; alive?: boolean } = {}) {
  const setCalls: Array<[string, string]> = [];
  const deps = {
    currentProject: {
      get: async () => opts.currentSession ?? null,
      set: async (scope: string, session: string) => {
        setCalls.push([scope, session]);
      },
    },
    bridge: { hasSession: async () => opts.alive ?? true },
  } as unknown as HandlerDeps;

  const sent: Array<[WsReplyKind, string]> = [];
  const send = async (kind: WsReplyKind, text: string) => {
    sent.push([kind, text]);
  };
  return { deps, sent, setCalls, send };
}

describe("runWorkspaceCommand", () => {
  beforeEach(() => {
    process.env.TCB_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tcb-ws-cmd-"));
  });

  it("list on an empty store replies wsListEmpty", async () => {
    const h = harness();
    await runWorkspaceCommand(h.deps, "lark", "c1", "list", h.send);
    expect(h.sent).toEqual([["list", m.wsListEmpty]]);
  });

  it("save then list round-trips the workspace", async () => {
    const h = harness({ currentSession: "sess-A" });
    await runWorkspaceCommand(h.deps, "lark", "c1", "save proj1", h.send);
    expect(last(h.sent)).toEqual(["ok", m.wsSaved("proj1", "sess-A")]);

    const h2 = harness();
    await runWorkspaceCommand(h2.deps, "lark", "c1", "list", h2.send);
    const [kind, text] = h2.sent[0] ?? [];
    expect(kind).toBe("list");
    expect(text).toContain("proj1");
  });

  it("save with no current project replies wsNoCurrentProject", async () => {
    const h = harness({ currentSession: null });
    await runWorkspaceCommand(h.deps, "lark", "c1", "save proj1", h.send);
    expect(h.sent).toEqual([["err", m.wsNoCurrentProject]]);
  });

  it("save with an invalid name replies wsInvalidName; with no name, wsUsage", async () => {
    const bad = harness({ currentSession: "sess-A" });
    await runWorkspaceCommand(bad.deps, "lark", "c1", "save bad@name", bad.send);
    expect(bad.sent).toEqual([["err", m.wsInvalidName]]);

    const none = harness({ currentSession: "sess-A" });
    await runWorkspaceCommand(none.deps, "lark", "c1", "save", none.send);
    expect(none.sent).toEqual([["err", m.wsUsage]]);
  });

  it("use sets the current project when the workspace exists and is alive", async () => {
    const saver = harness({ currentSession: "sess-A" });
    await runWorkspaceCommand(saver.deps, "lark", "c1", "save proj1", saver.send);

    const h = harness({ alive: true });
    await runWorkspaceCommand(h.deps, "lark", "c1", "use proj1", h.send);
    expect(h.setCalls).toEqual([["lark:c1", "sess-A"]]);
    expect(last(h.sent)).toEqual(["ok", m.wsUsed("proj1")]);
  });

  it("use replies wsNotFound for an unknown workspace", async () => {
    const h = harness();
    await runWorkspaceCommand(h.deps, "lark", "c1", "use ghost", h.send);
    expect(h.sent).toEqual([["err", m.wsNotFound("ghost")]]);
  });

  it("use replies wsSessionGone when the saved session is dead", async () => {
    const saver = harness({ currentSession: "sess-A" });
    await runWorkspaceCommand(saver.deps, "lark", "c1", "save proj1", saver.send);

    const h = harness({ alive: false });
    await runWorkspaceCommand(h.deps, "lark", "c1", "use proj1", h.send);
    expect(last(h.sent)).toEqual(["err", m.wsSessionGone("proj1")]);
    expect(h.setCalls).toEqual([]);
  });

  it("remove deletes a workspace, and reports wsNotFound when absent", async () => {
    const saver = harness({ currentSession: "sess-A" });
    await runWorkspaceCommand(saver.deps, "lark", "c1", "save proj1", saver.send);

    const ok = harness();
    await runWorkspaceCommand(ok.deps, "lark", "c1", "remove proj1", ok.send);
    expect(last(ok.sent)).toEqual(["ok", m.wsRemoved("proj1")]);

    const gone = harness();
    await runWorkspaceCommand(gone.deps, "lark", "c1", "remove proj1", gone.send);
    expect(last(gone.sent)).toEqual(["err", m.wsNotFound("proj1")]);
  });

  it("an unknown subcommand replies wsUsage", async () => {
    const h = harness();
    await runWorkspaceCommand(h.deps, "lark", "c1", "frobnicate", h.send);
    expect(h.sent).toEqual([["info", m.wsUsage]]);
  });

  it("scopes by channel: telegram chatId is namespaced separately", async () => {
    const saver = harness({ currentSession: "sess-T" });
    await runWorkspaceCommand(saver.deps, "telegram", "99", "save proj1", saver.send);
    const h = harness({ alive: true });
    await runWorkspaceCommand(h.deps, "telegram", "99", "use proj1", h.send);
    expect(h.setCalls).toEqual([["telegram:99", "sess-T"]]);
  });
});
