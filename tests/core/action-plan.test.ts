import { describe, expect, it, vi } from "vitest";
import { planMessageAction } from "../../src/core/command/action-plan.js";
import type { HandlerDeps } from "../../src/core/deps.js";

function deps(over: Partial<HandlerDeps> = {}): HandlerDeps {
  return {
    config: { startCommands: [{ label: "default", command: "claude" }] },
    agent: { checkIfRunning: vi.fn(async () => false) },
    ...over,
  } as unknown as HandlerDeps;
}

describe("planMessageAction", () => {
  it("asks for confirmation before destructive queued actions", async () => {
    await expect(
      planMessageAction({ deps: deps(), action: "exit", session: "proj" }),
    ).resolves.toEqual({
      kind: "confirm",
      action: "exit",
    });
  });

  it("routes confirmed queued actions through the queue plan", async () => {
    await expect(
      planMessageAction({ deps: deps(), action: "exit", session: "proj", confirmed: true }),
    ).resolves.toEqual({ kind: "queued", action: "exit", text: "exit" });
  });

  it("routes immediate actions through the immediate plan", async () => {
    await expect(
      planMessageAction({ deps: deps(), action: "status", session: "proj" }),
    ).resolves.toEqual({
      kind: "immediate",
      action: "status",
    });
  });

  it("rejects start when the agent is already running", async () => {
    await expect(
      planMessageAction({
        deps: deps({ agent: { checkIfRunning: vi.fn(async () => true) } as never }),
        action: "start",
        session: "proj",
      }),
    ).resolves.toEqual({ kind: "already-running", action: "start" });
  });

  it("offers the start picker when more than one launch flavor exists", async () => {
    await expect(
      planMessageAction({
        deps: deps({
          config: {
            startCommands: [
              { label: "default", command: "claude" },
              { label: "codex", command: "codex" },
            ],
          } as never,
        }),
        action: "restart",
        session: "proj",
        confirmed: true,
      }),
    ).resolves.toEqual({ kind: "pick-start-command", action: "restart" });
  });

  it("returns no-session for session-bound start actions with no project session", async () => {
    await expect(
      planMessageAction({ deps: deps(), action: "start", session: null }),
    ).resolves.toEqual({
      kind: "no-session",
      action: "start",
    });
  });

  it("keeps Lark's card-level picker affordance when explicitly allowed", async () => {
    await expect(
      planMessageAction({
        deps: deps({
          config: {
            startCommands: [
              { label: "default", command: "claude" },
              { label: "codex", command: "codex" },
            ],
          } as never,
        }),
        action: "start",
        session: null,
        allowStartPickerWithoutSession: true,
      }),
    ).resolves.toEqual({ kind: "pick-start-command", action: "start" });
  });
});
