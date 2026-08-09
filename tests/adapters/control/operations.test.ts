import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  controlOperationNames,
  createControlOperationHandlers,
  handleControlRequest,
} from "../../../src/adapters/control/operations.js";
import { createControlDiagnosticsHandlers } from "../../../src/adapters/control/operations-diagnostics.js";
import { createControlProjectSessionHandlers } from "../../../src/adapters/control/operations-project-sessions.js";
import type { ControlRequest } from "../../../src/adapters/control/protocol.js";
import type { HandlerDeps } from "../../../src/core/deps.js";

describe("control operation registry", () => {
  it("groups dashboard and diagnostic reads behind one handler family", () => {
    const handlers = createControlDiagnosticsHandlers({} as HandlerDeps);

    expect(Object.keys(handlers).sort()).toEqual([
      "inputs",
      "logs",
      "peek",
      "promptTranslate",
      "snapshot",
      "sysload",
    ]);
  });

  it("groups Project Session lifecycle operations behind one handler family", () => {
    const handlers = createControlProjectSessionHandlers({} as HandlerDeps);

    expect(Object.keys(handlers).sort()).toEqual([
      "adopt",
      "open",
      "openPath",
      "openWorker",
      "orphans",
      "projects",
      "recover",
    ]);
  });

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

  it("passes caller provenance and Home Operator workspace classification to handlers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tcb-home-caller-"));
    const send = vi.fn();
    const deps = {
      config: { homeOperator: { dir } },
    } as HandlerDeps;
    const req = {
      id: 100,
      op: "snapshot",
      caller: { source: "control-client", cwd: dir, pid: 123 },
    } satisfies ControlRequest;

    try {
      await handleControlRequest(deps, req, send, {
        ...createControlOperationHandlers(deps, send),
        snapshot: async (_req, ctx) => {
          ctx.ok({
            caller: ctx.caller,
            isOperatorHomeCaller: ctx.isOperatorHomeCaller,
          });
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    expect(send).toHaveBeenCalledWith({
      id: 100,
      ok: true,
      data: {
        caller: { source: "control-client", cwd: dir, pid: 123 },
        isOperatorHomeCaller: true,
      },
    });
  });
});
