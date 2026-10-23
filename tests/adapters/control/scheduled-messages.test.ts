import { homedir } from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleControlRequest } from "../../../src/adapters/control/operations.js";
import { createControlScheduledMessageHandlers } from "../../../src/adapters/control/operations-scheduled-messages.js";
import type { HandlerDeps } from "../../../src/core/deps.js";

const service = vi.hoisted(() => ({
  create: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  cancel: vi.fn(),
}));
vi.mock("../../../src/core/scheduled-messages/service.js", () => ({
  getScheduledMessageService: () => service,
}));

describe("scheduled-message control operations", () => {
  const deps = { config: { projectSessionPrefix: "tmux_proj_" } } as HandlerDeps;
  beforeEach(() => vi.clearAllMocks());
  const context = () => ({
    ok: vi.fn(),
    fail: vi.fn(),
    send: vi.fn(),
    isOperatorHomeCaller: false,
  });

  it("creates durable user input through the shared service", async () => {
    service.create.mockResolvedValue({ id: "scheduled-1", status: "scheduled" });
    const ctx = context();
    await createControlScheduledMessageHandlers(deps).schedule(
      {
        id: 1,
        op: "schedule",
        command: "create",
        session: "tmux_proj_fixture",
        when: "30m",
        text: "Review\nthe tests",
        requestId: "request-1",
      },
      ctx,
    );
    expect(service.create).toHaveBeenCalledWith({
      owner: { channel: "control", chatId: "local", userId: "local" },
      sessionName: "tmux_proj_fixture",
      when: "30m",
      text: "Review\nthe tests",
      requestId: "request-1",
    });
    expect(ctx.ok).toHaveBeenCalledWith({ id: "scheduled-1", status: "scheduled" });
  });

  it("allows the local operator to inspect and cancel channel-created schedules", async () => {
    const record = { id: "scheduled-1", status: "cancelled" };
    service.list.mockReturnValue([record]);
    service.get.mockReturnValue(record);
    service.cancel.mockReturnValue(record);
    const handler = createControlScheduledMessageHandlers({} as HandlerDeps).schedule;
    for (const command of ["list", "show", "cancel"] as const) {
      const ctx = context();
      await handler({ id: 2, op: "schedule", command, scheduleId: "scheduled-1" }, ctx);
      expect(ctx.ok).toHaveBeenCalledWith(command === "list" ? [record] : record);
    }
    expect(service.cancel).toHaveBeenCalledWith("scheduled-1");
  });

  it("rejects malformed requests before touching scheduling state", async () => {
    const handler = createControlScheduledMessageHandlers({} as HandlerDeps).schedule;
    await expect(
      handler(
        {
          id: 3,
          op: "schedule",
          command: "create",
          session: "",
          when: "30m",
          text: "",
          requestId: "",
        },
        context(),
      ),
    ).rejects.toThrow();
    expect(service.create).not.toHaveBeenCalled();
  });

  it("returns a clear missing-record failure", async () => {
    service.get.mockReturnValue(undefined);
    const ctx = context();
    await createControlScheduledMessageHandlers({} as HandlerDeps).schedule(
      { id: 4, op: "schedule", command: "show", scheduleId: "missing" },
      ctx,
    );
    expect(ctx.fail).toHaveBeenCalledWith("scheduled message not found");
  });
  it("retains the ordinary local-send prohibition on operator input", async () => {
    const ctx = context();
    await createControlScheduledMessageHandlers(deps).schedule(
      {
        id: 5,
        op: "schedule",
        command: "create",
        session: "tmux_proj_home",
        when: "30m",
        text: "message",
        requestId: "request-2",
      },
      ctx,
    );
    expect(ctx.fail).toHaveBeenCalledWith("cannot send to the operator session");
    expect(service.create).not.toHaveBeenCalled();
  });
  it("redacts filesystem paths in failed control responses", async () => {
    service.create.mockRejectedValue(new Error(`unreadable ${homedir()}/workspace`));
    const send = vi.fn();
    await handleControlRequest(
      deps,
      {
        id: 6,
        op: "schedule",
        command: "create",
        session: "tmux_proj_fixture",
        when: "30m",
        text: "message",
        requestId: "request-3",
      },
      send,
    );
    expect(send).toHaveBeenCalledWith({ id: 6, ok: false, error: "unreadable ~/workspace" });
  });
});
