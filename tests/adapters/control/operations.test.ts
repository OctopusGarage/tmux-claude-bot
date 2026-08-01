import { describe, expect, it, vi } from "vitest";
import {
  controlOperationNames,
  createControlOperationHandlers,
  handleControlRequest,
} from "../../../src/adapters/control/operations.js";
import type { ControlRequest } from "../../../src/adapters/control/protocol.js";
import type { HandlerDeps } from "../../../src/core/deps.js";

describe("control operation registry", () => {
  it("exposes one explicit handler per protocol operation", () => {
    const handlers = createControlOperationHandlers({} as HandlerDeps, () => {});

    expect(Object.keys(handlers).sort()).toEqual([...controlOperationNames].sort());
    expect(controlOperationNames).toEqual([
      "snapshot",
      "peek",
      "send",
      "control",
      "projects",
      "open",
      "openPath",
      "openWorker",
      "orphans",
      "adopt",
      "recover",
      "logs",
      "sysload",
      "inputs",
      "promptTranslate",
      "taskAudit",
      "notify",
      "autopilot",
      "sendAttachment",
    ]);
  });

  it("keeps error framing in the shared request wrapper", async () => {
    const send = vi.fn();
    const req = { id: 99, op: "snapshot" } satisfies ControlRequest;

    await handleControlRequest({} as HandlerDeps, req, send, {
      ...createControlOperationHandlers({} as HandlerDeps, send),
      snapshot: async () => {
        throw new Error("boom");
      },
    });

    expect(send).toHaveBeenCalledWith({ id: 99, ok: false, error: "boom" });
  });
});
