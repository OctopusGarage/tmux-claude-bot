import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { NotificationGateway } from "../../../src/core/notifications/gateway.js";

describe("NotificationGateway", () => {
  it("sends a formatted notification to every registered channel by default", async () => {
    const gateway = new NotificationGateway();
    const telegram = vi.fn(async (_message: string) => {});
    const lark = vi.fn(async () => {});
    gateway.register("telegram", telegram);
    gateway.register("lark", lark);

    const result = await gateway.notify({
      level: "success",
      source: "deploy",
      title: "Deploy finished",
      body: "staging is live",
    });

    expect(result).toEqual({
      status: "sent",
      deliveries: [
        { channel: "telegram", ok: true },
        { channel: "lark", ok: true },
      ],
    });
    expect(telegram).toHaveBeenCalledWith(
      "✅ Deploy finished\nstaging is live",
      expect.objectContaining({ source: "deploy" }),
    );
    expect(lark).toHaveBeenCalledWith(
      "✅ Deploy finished\nstaging is live",
      expect.objectContaining({ source: "deploy" }),
    );
  });

  it("returns a partial result when one registered sender fails", async () => {
    const gateway = new NotificationGateway();
    gateway.register(
      "telegram",
      vi.fn(async () => {}),
    );
    gateway.register(
      "lark",
      vi.fn(async () => {
        throw new Error("lark down");
      }),
    );

    await expect(
      gateway.notify({ channel: "both", level: "error", title: "Build failed" }),
    ).resolves.toEqual({
      status: "partial",
      deliveries: [
        { channel: "telegram", ok: true },
        {
          channel: "lark",
          ok: false,
          error: "lark down",
          messageSent: false,
          failedStage: "message",
        },
      ],
    });
  });

  it("truncates noisy notification bodies for every channel before sending", async () => {
    const gateway = new NotificationGateway();
    const telegram = vi.fn(async (_message: string) => {});
    const lark = vi.fn(async (_message: string) => {});
    gateway.register("telegram", telegram);
    gateway.register("lark", lark);

    const result = await gateway.notify({
      channel: "both",
      title: "Daily audit",
      body: "x".repeat(6000),
    });

    expect(result.status).toBe("sent");
    const telegramMessage = telegram.mock.calls[0]?.[0] ?? "";
    const larkMessage = lark.mock.calls[0]?.[0] ?? "";
    expect(telegramMessage).toContain("truncated");
    expect(larkMessage).toContain("truncated");
    expect(telegramMessage.length).toBeLessThanOrEqual(1600);
    expect(larkMessage.length).toBeLessThanOrEqual(1600);
  });

  it("removes supervisor audit details from notification text at the gateway boundary", async () => {
    const gateway = new NotificationGateway();
    const lark = vi.fn(async (_message: string) => {});
    gateway.register("lark", lark);

    await gateway.notify({
      channel: "lark",
      title: "Delegated task completed",
      body: [
        "Project: english-pilot",
        "Summary: Opened dedicated worker tmux_proj_loop-worker-project-run at ~/.tmux-claude-bot/state/loop-worktrees/project/run and compacted it before delegation.; delegationBrief: objective=implement daemon delivery; currentAssessment=real bounded gap; taskChecklist=repair npm env, read docs, TDD red tests; acceptanceCriteria=daemon unavailable/actionable blocker; stopConditions=unclear scope; nonGoals=no broad rewrite; riskReview=secret leakage; verificationPlan=targeted tests, typecheck, full tests, lint, coverage, build, CI/mergeability.",
        "Report: ~/.tmux-claude-bot/state/loop-runs/project/run/supervisor.md",
      ].join("\n"),
    });

    const message = lark.mock.calls[0]?.[0] ?? "";
    expect(message).toContain("Project: english-pilot");
    expect(message).toContain(
      "Report: ~/.tmux-claude-bot/state/loop-runs/project/run/supervisor.md",
    );
    expect(message).not.toContain("Opened dedicated worker");
    expect(message).not.toContain("delegationBrief:");
    expect(message).not.toContain("taskChecklist=");
    expect(message).not.toContain("currentAssessment=");
  });

  it("shortens home paths in notification text before sending", async () => {
    const gateway = new NotificationGateway();
    const telegram = vi.fn(async (_message: string) => {});
    gateway.register("telegram", telegram);

    await gateway.notify({
      channel: "telegram",
      title: "Daily audit",
      body: `report: ${homedir()}/.tmux-claude-bot/state/report.md`,
    });

    expect(telegram).toHaveBeenCalledWith(
      expect.stringContaining("report: ~/.tmux-claude-bot/state/report.md"),
      expect.anything(),
    );
    expect(telegram.mock.calls[0]?.[0]).not.toContain(homedir());
  });

  it("fails a requested channel that has no registered sender", async () => {
    const gateway = new NotificationGateway();

    await expect(gateway.notify({ channel: "telegram", title: "Hello" })).resolves.toEqual({
      status: "failed",
      deliveries: [
        {
          channel: "telegram",
          ok: false,
          error: "no sender registered",
          messageSent: false,
          failedStage: "sender-missing",
        },
      ],
    });
  });

  it("fails the default target when no channels are configured", async () => {
    const gateway = new NotificationGateway();

    await expect(gateway.notify({ title: "Hello" })).resolves.toEqual({
      status: "failed",
      deliveries: [
        {
          channel: "telegram",
          ok: false,
          error: "no sender registered",
          messageSent: false,
          failedStage: "sender-missing",
        },
      ],
    });
  });

  it("sends notification attachments through the selected channel sender", async () => {
    const gateway = new NotificationGateway();
    const telegram = vi.fn(async (_message: string, _request?: unknown) => {});
    const attach = vi.fn(async () => {});
    gateway.register("telegram", telegram);
    gateway.registerAttachment("telegram", attach);

    const result = await gateway.notify(
      {
        channel: "telegram",
        title: "Radar ready",
        attachments: [
          { path: "/tmp/report.md", caption: "Markdown report" },
          { path: "/tmp/report.html" },
        ],
      },
      { statInfo: () => ({ size: 100, isFile: true }) },
    );

    expect(result).toEqual({
      status: "sent",
      deliveries: [{ channel: "telegram", ok: true }],
    });
    expect(telegram).toHaveBeenCalledWith(
      "ℹ️ Radar ready",
      expect.objectContaining({ title: "Radar ready" }),
    );
    expect(attach).toHaveBeenCalledWith(
      "/tmp/report.md",
      "file",
      "Markdown report",
      expect.objectContaining({ title: "Radar ready" }),
    );
    expect(attach).toHaveBeenCalledWith(
      "/tmp/report.html",
      "file",
      undefined,
      expect.objectContaining({ title: "Radar ready" }),
    );
  });

  it("sends attachments to both Telegram and Lark when channel is both", async () => {
    const gateway = new NotificationGateway();
    const telegramText = vi.fn(async () => {});
    const larkText = vi.fn(async () => {});
    const telegramAttach = vi.fn(async () => {});
    const larkAttach = vi.fn(async () => {});
    gateway.register("telegram", telegramText);
    gateway.register("lark", larkText);
    gateway.registerAttachment("telegram", telegramAttach);
    gateway.registerAttachment("lark", larkAttach);

    const result = await gateway.notify(
      {
        channel: "both",
        title: "Radar ready",
        attachments: [{ path: "/tmp/report.html", caption: "HTML report" }],
      },
      { statInfo: () => ({ size: 100, isFile: true }) },
    );

    expect(result).toEqual({
      status: "sent",
      deliveries: [
        { channel: "telegram", ok: true },
        { channel: "lark", ok: true },
      ],
    });
    expect(telegramText).toHaveBeenCalledWith(
      "ℹ️ Radar ready",
      expect.objectContaining({ channel: "both", title: "Radar ready" }),
    );
    expect(larkText).toHaveBeenCalledWith(
      "ℹ️ Radar ready",
      expect.objectContaining({ channel: "both", title: "Radar ready" }),
    );
    expect(telegramAttach).toHaveBeenCalledWith(
      "/tmp/report.html",
      "file",
      "HTML report",
      expect.objectContaining({ channel: "both", title: "Radar ready" }),
    );
    expect(larkAttach).toHaveBeenCalledWith(
      "/tmp/report.html",
      "file",
      "HTML report",
      expect.objectContaining({ channel: "both", title: "Radar ready" }),
    );
  });

  it("reports a partial delivery when text succeeds but an attachment upload fails", async () => {
    const gateway = new NotificationGateway();
    gateway.register(
      "lark",
      vi.fn(async () => {}),
    );
    gateway.registerAttachment(
      "lark",
      vi.fn(async () => {
        throw new Error("upload failed");
      }),
    );

    await expect(
      gateway.notify(
        {
          channel: "lark",
          title: "Radar ready",
          attachments: [{ path: "/tmp/report.html" }],
        },
        { statInfo: () => ({ size: 100, isFile: true }) },
      ),
    ).resolves.toEqual({
      status: "partial",
      deliveries: [
        {
          channel: "lark",
          ok: false,
          error: "upload failed",
          messageSent: true,
          failedStage: "attachment",
        },
      ],
    });
  });

  it("reports a partial delivery when text succeeds but no attachment sender is registered", async () => {
    const gateway = new NotificationGateway();
    const telegram = vi.fn(async () => {});
    gateway.register("telegram", telegram);

    await expect(
      gateway.notify(
        {
          channel: "telegram",
          title: "Radar ready",
          attachments: [{ path: "/tmp/report.html" }],
        },
        { statInfo: () => ({ size: 100, isFile: true }) },
      ),
    ).resolves.toEqual({
      status: "partial",
      deliveries: [
        {
          channel: "telegram",
          ok: false,
          error: "no attachment sender registered",
          messageSent: true,
          failedStage: "attachment-sender-missing",
        },
      ],
    });
    expect(telegram).toHaveBeenCalledWith(
      "ℹ️ Radar ready",
      expect.objectContaining({ title: "Radar ready" }),
    );
  });

  it("reports a partial delivery when text succeeds but attachment validation fails", async () => {
    const gateway = new NotificationGateway();
    const telegram = vi.fn(async () => {});
    const attach = vi.fn(async () => {});
    gateway.register("telegram", telegram);
    gateway.registerAttachment("telegram", attach);

    await expect(
      gateway.notify(
        {
          channel: "telegram",
          title: "Radar ready",
          attachments: [{ path: "/tmp/missing.html" }],
        },
        { statInfo: () => null },
      ),
    ).resolves.toEqual({
      status: "partial",
      deliveries: [
        {
          channel: "telegram",
          ok: false,
          error: "file not found: missing.html",
          messageSent: true,
          failedStage: "attachment-validation",
        },
      ],
    });
    expect(telegram).toHaveBeenCalledTimes(1);
    expect(attach).not.toHaveBeenCalled();
  });

  it("suppresses an identical state across gateway restarts", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-notification-gateway-"));
    const firstSender = vi.fn(async () => {});
    const first = new NotificationGateway({ stateDir, now: () => 1_000 });
    first.register("telegram", firstSender);
    const request = {
      title: "Wake schedule needs attention",
      delivery: {
        mode: "state-change" as const,
        topic: "power:wake-schedule",
        state: "missing",
      },
    };

    await expect(first.notify(request)).resolves.toMatchObject({ status: "sent" });
    const restoredSender = vi.fn(async () => {});
    const restored = new NotificationGateway({ stateDir, now: () => 2_000 });
    restored.register("telegram", restoredSender);

    await expect(restored.notify(request)).resolves.toEqual({
      status: "suppressed",
      deliveries: [{ channel: "telegram", ok: true, suppressed: true }],
    });
    expect(firstSender).toHaveBeenCalledTimes(1);
    expect(restoredSender).not.toHaveBeenCalled();
  });

  it("retries only a failed channel after partial stateful delivery", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-notification-gateway-"));
    const telegram = vi.fn(async () => {});
    const lark = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce();
    const gateway = new NotificationGateway({ stateDir, now: () => 1_000 });
    gateway.register("telegram", telegram);
    gateway.register("lark", lark);
    const request = {
      channel: "both" as const,
      title: "Resource pressure critical",
      delivery: {
        mode: "state-change" as const,
        topic: "resource:pressure",
        state: "critical",
      },
    };

    await expect(gateway.notify(request)).resolves.toMatchObject({ status: "partial" });
    await expect(gateway.notify(request)).resolves.toMatchObject({ status: "sent" });
    expect(telegram).toHaveBeenCalledTimes(1);
    expect(lark).toHaveBeenCalledTimes(2);
  });

  it("keeps explicit notifications always-send compatible", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-notification-gateway-"));
    const telegram = vi.fn(async (_message: string, _request?: unknown) => {});
    const gateway = new NotificationGateway({ stateDir });
    gateway.register("telegram", telegram);

    await gateway.notify({ title: "Operator message", source: "tmux-claude-bot" });
    await gateway.notify({ title: "Operator message", source: "tmux-claude-bot" });

    expect(telegram).toHaveBeenCalledTimes(2);
    expect(telegram.mock.calls[0]?.[0]).not.toContain("source:");
    expect(telegram.mock.calls[0]?.[1]).toMatchObject({ source: "tmux-claude-bot" });
  });
});
