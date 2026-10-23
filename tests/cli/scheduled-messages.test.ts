import { homedir } from "node:os";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerScheduleCommands } from "../../src/cli/schedule-commands.js";
import type { ScheduledMessageRecord } from "../../src/core/scheduled-messages/types.js";

afterEach(() => vi.restoreAllMocks());

function setup() {
  const record: ScheduledMessageRecord = {
    id: "schedule-1",
    target: {
      label: "fixture",
      sessionName: "tmux_proj_fixture",
      workspacePath: `${homedir()}/fixture`,
      incarnation: "fixture",
    },
    status: "scheduled",
    dueAt: Date.parse("2026-10-24T01:00Z"),
    text: "Review the tests",
    owner: { channel: "control", chatId: "local", userId: "local" },
    timezone: "UTC",
    createdAt: 1,
    updatedAt: 1,
    requestId: "request-1",
  };
  const client = {
    connect: vi.fn(async () => {}),
    close: vi.fn(),
    snapshot: vi.fn(async () => ({
      sessions: [{ label: "fixture", session: "tmux_proj_fixture" }],
    })),
    scheduleCreate: vi.fn(async () => record),
    scheduledMessages: vi.fn(async () => [record]),
    scheduledMessage: vi.fn(async () => record),
    cancelScheduledMessage: vi.fn(async () => ({ ...record, status: "cancelled" as const })),
  };
  const program = new Command().exitOverride();
  registerScheduleCommands(program, () => client);
  return { client, program };
}

describe("schedule CLI", () => {
  it("resolves a friendly session and preserves multiline content", async () => {
    const { client, program } = setup();
    vi.spyOn(console, "log").mockImplementation(() => {});
    await program.parseAsync(
      ["schedule", "create", "--session", "fixture", "--in", "30m", "--text", "one\ntwo", "--json"],
      { from: "user" },
    );
    expect(client.scheduleCreate).toHaveBeenCalledWith(
      "tmux_proj_fixture",
      "30m",
      "one\ntwo",
      expect.any(String),
    );
    expect(client.close).toHaveBeenCalled();
  });

  it("rejects conflicting or missing time options before connecting", async () => {
    const { client, program } = setup();
    await expect(
      program.parseAsync(["schedule", "create", "--session", "fixture", "--text", "message"], {
        from: "user",
      }),
    ).rejects.toThrow();
    expect(client.connect).not.toHaveBeenCalled();
    await expect(
      program.parseAsync(
        [
          "schedule",
          "create",
          "--session",
          "fixture",
          "--text",
          "message",
          "--at",
          "2026-10-24T09:00+08:00",
          "--in",
          "1h",
        ],
        { from: "user" },
      ),
    ).rejects.toThrow();
  });

  it("redacts home paths from structured inspection output", async () => {
    const { program } = setup();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await program.parseAsync(["schedule", "list", "--json"], { from: "user" });
    const output = String(log.mock.calls[0]?.[0]);
    expect(output).toContain("~/fixture");
    expect(output).not.toContain(homedir());
  });

  it("closes the control client when the request fails", async () => {
    const { client, program } = setup();
    client.scheduledMessage.mockRejectedValue(new Error("disconnected"));
    await expect(
      program.parseAsync(["schedule", "show", "schedule-1"], { from: "user" }),
    ).rejects.toThrow("disconnected");
    expect(client.close).toHaveBeenCalled();
  });
});
