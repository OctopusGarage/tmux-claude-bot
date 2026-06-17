import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock executeMessage so the immediate path is a no-op: we're testing the
// routing DECISION (immediate runs inline vs queued enqueues), not execution.
vi.mock("../../src/core/command/dispatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/command/dispatch.js")>();
  return { ...actual, executeMessage: vi.fn(async () => "ok") };
});

import {
  IMMEDIATE as LARK_IMMEDIATE,
  QUEUED as LARK_QUEUED,
} from "../../src/adapters/lark/commands.js";
import { handleQueuedCommand } from "../../src/adapters/telegram/executor.js";
import {
  ACTION_META,
  getImmediateActions,
  getLarkQueued,
} from "../../src/core/command/action-registry.js";
import type { MessageAction } from "../../src/core/command/dispatch.js";
import { fakeCtx, fakeDeps } from "./telegram/_fakes.js";

/**
 * Cross-adapter parity. The two adapters used to hardcode their own immediate-vs-
 * queued action lists, which drifted (Telegram dropped `tab`, so `/tab` was
 * wrongly enqueued). These tests pin every action's routing to the single source
 * (core/action-registry) so a re-divergence fails loudly.
 */

const immediate = [...getImmediateActions()];
const queued = [...getLarkQueued()];

describe("action registry sanity", () => {
  it("immediate and queued sets are disjoint", () => {
    const overlap = immediate.filter((a) => queued.includes(a));
    expect(overlap).toEqual([]);
  });

  it("every button-bearing, non-text action is classified immediate or queued", () => {
    const classified = new Set<MessageAction>([...immediate, ...queued]);
    const unclassified = (Object.keys(ACTION_META) as MessageAction[]).filter(
      (a) => a !== "text" && !classified.has(a),
    );
    expect(unclassified).toEqual([]);
  });
});

describe("Telegram routes each registry action by its kind (behavioral)", () => {
  beforeEach(() => vi.clearAllMocks());

  for (const action of immediate) {
    it(`runs immediate '${action}' inline, never enqueues`, async () => {
      const ctx = fakeCtx();
      const deps = fakeDeps();
      await handleQueuedCommand(ctx, deps, action as MessageAction);
      expect(deps.queue.enqueued).toHaveLength(0);
    });
  }

  for (const action of queued) {
    it(`enqueues queued '${action}'`, async () => {
      const ctx = fakeCtx();
      const deps = fakeDeps();
      await handleQueuedCommand(ctx, deps, action as MessageAction);
      expect(deps.queue.enqueued).toHaveLength(1);
    });
  }
});

describe("Lark derives its sets from the same single source", () => {
  it("Lark IMMEDIATE equals the registry's immediate set", () => {
    expect([...LARK_IMMEDIATE].sort()).toEqual(immediate.sort());
  });

  it("Lark QUEUED equals the registry's queued set", () => {
    expect([...LARK_QUEUED].sort()).toEqual(queued.sort());
  });
});
