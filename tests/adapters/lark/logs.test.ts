import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// `log-query.ts` resolves its LOG_DIR from TCB_LOG_DIR at module load, so the
// temp dir must be set BEFORE the adapter (which imports log-query) is imported.
const logDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "tcb-logs-lark-"));
process.env.TCB_LOG_DIR = logDir;

// Write into TODAY's daily file: queryLogs defaults to the most-recent file
// (readRecords(1)), and the live logger creates a tcb-<today>.jsonl in this same
// dir during the test — a fixture stamped with a fixed past date would no longer
// be "the last file" and would be skipped. Use the logger's LOCAL-date convention
// (logger.ts: getFullYear/getMonth/getDate), not UTC, or the two diverge across a
// timezone day boundary and the logger's later file wins the readRecords(1) pick.
const now = new Date();
const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
const mkRec = (o: Record<string, unknown>): string =>
  JSON.stringify({ ts: now.toISOString(), level: "INFO", msg: "x", ...o });

fs.writeFileSync(
  nodePath.join(logDir, `tcb-${stamp}.jsonl`),
  `${[
    mkRec({ level: "WARN", component: "cmp", msg: "careful-now", session: "proj-1" }),
    mkRec({ level: "ERROR", component: "cmp", msg: "boom-here", session: "proj-1" }),
    mkRec({ level: "INFO", component: "cmp", msg: "noisy-info", session: "proj-1" }),
  ].join("\n")}\n`,
  "utf-8",
);

const { makeMessageHandler } = await import("../../../src/adapters/lark/handlers.js");
const { fakeChannel, fakeDeps, fakeMessage } = await import("./_fakes.js");

describe("/logs (Lark) — owner-only, p2p", () => {
  beforeEach(() => vi.clearAllMocks());

  afterAll(() => {
    fs.rmSync(logDir, { recursive: true, force: true });
    delete process.env.TCB_LOG_DIR;
  });

  it("p2p owner gets a card with recent WARN/ERROR for the current session", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps({ session: "proj-1" });
    const handler = makeMessageHandler(channel, deps);

    await handler(fakeMessage({ content: "/logs", chatType: "p2p" }));

    const cards = JSON.stringify(channel.cards());
    expect(cards).toContain("boom-here");
    expect(cards).toContain("careful-now");
    // levelMin WARN drops INFO noise.
    expect(cards).not.toContain("noisy-info");
  });

  it("does NOT expose logs in a group context (no send)", async () => {
    // A bound group whose member runs /logs must get nothing back.
    const { bindGroup, unbindGroup } = await import("../../../src/core/projects/group-bindings.js");
    bindGroup("grp-logs", {
      workspacePath: "/proj/one",
      sessionName: "proj-1",
      label: "one",
    });
    try {
      const channel = fakeChannel();
      const deps = fakeDeps({ session: "proj-1" });
      const handler = makeMessageHandler(channel, deps);

      await handler(fakeMessage({ content: "/logs", chatId: "grp-logs", chatType: "group" }));

      expect(JSON.stringify(channel.cards())).not.toContain("boom-here");
      expect(channel.texts().join("\n")).not.toContain("boom-here");
    } finally {
      unbindGroup("grp-logs");
    }
  });

  it("non-allowlisted sender gets nothing", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps({ session: "proj-1" });
    const handler = makeMessageHandler(channel, deps);

    await handler(fakeMessage({ content: "/logs", senderId: "ou_stranger" }));

    expect(channel.sent).toHaveLength(0);
  });
});
