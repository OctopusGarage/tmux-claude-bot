import { describe, expect, it, vi } from "vitest";
import { handleControlRequest } from "../../../src/adapters/control/operations.js";
import {
  getImmediateActions,
  getQueuedActions,
} from "../../../src/core/command/action-registry.js";
import { executeMessage } from "../../../src/core/command/dispatch.js";
import type { HandlerDeps } from "../../../src/core/deps.js";

vi.mock("../../../src/core/command/dispatch.js", () => ({
  executeMessage: vi.fn(async () => "done"),
}));

describe("Control registry routing parity", () => {
  it.each([...getImmediateActions()])(
    "dispatches %s using the shared immediate handler",
    async (action) => {
      vi.mocked(executeMessage).mockClear();
      const enqueue = vi.fn();
      const deps = { config: {}, queue: { enqueue } } as unknown as HandlerDeps;
      await handleControlRequest(
        deps,
        { id: 1, op: "control", session: "sample-worker", action },
        vi.fn(),
      );
      expect(executeMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          action,
          sessionName: "sample-worker",
          channel: "control",
          origin: "user",
        }),
        deps,
      );
      expect(enqueue).not.toHaveBeenCalled();
    },
  );

  it.each(["text", ...getQueuedActions()])("keeps %s in the queue", async (action) => {
    vi.mocked(executeMessage).mockClear();
    const enqueue = vi.fn((message) => {
      message.started();
      return "queued" as const;
    });
    const deps = { config: {}, queue: { enqueue } } as unknown as HandlerDeps;
    await handleControlRequest(
      deps,
      { id: 2, op: "control", session: "sample-worker", action },
      vi.fn(),
    );
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ action, origin: "user" }));
    expect(executeMessage).not.toHaveBeenCalled();
  });
});
