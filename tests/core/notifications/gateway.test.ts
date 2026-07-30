import { describe, expect, it, vi } from "vitest";
import { NotificationGateway } from "../../../src/core/notifications/gateway.js";

describe("NotificationGateway", () => {
  it("sends a formatted notification to every registered channel by default", async () => {
    const gateway = new NotificationGateway();
    const telegram = vi.fn(async () => {});
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
      "✅ Deploy finished\nsource: deploy\n\nstaging is live",
      expect.objectContaining({ source: "deploy" }),
    );
    expect(lark).toHaveBeenCalledWith(
      "✅ Deploy finished\nsource: deploy\n\nstaging is live",
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
        { channel: "lark", ok: false, error: "lark down" },
      ],
    });
  });

  it("truncates long Telegram notifications before sending", async () => {
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
    expect(telegramMessage).toContain("truncated for Telegram");
    expect(telegramMessage.length).toBeLessThanOrEqual(4096);
    expect(larkMessage.length).toBeGreaterThan(5000);
  });

  it("fails a requested channel that has no registered sender", async () => {
    const gateway = new NotificationGateway();

    await expect(gateway.notify({ channel: "telegram", title: "Hello" })).resolves.toEqual({
      status: "failed",
      deliveries: [{ channel: "telegram", ok: false, error: "no sender registered" }],
    });
  });

  it("fails the default target when no channels are configured", async () => {
    const gateway = new NotificationGateway();

    await expect(gateway.notify({ title: "Hello" })).resolves.toEqual({
      status: "failed",
      deliveries: [{ channel: "telegram", ok: false, error: "no sender registered" }],
    });
  });

  it("sends notification attachments through the selected channel sender", async () => {
    const gateway = new NotificationGateway();
    const telegram = vi.fn(async () => {});
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
    expect(attach).toHaveBeenCalledWith("/tmp/report.md", "file", "Markdown report");
    expect(attach).toHaveBeenCalledWith("/tmp/report.html", "file", undefined);
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
    expect(telegramAttach).toHaveBeenCalledWith("/tmp/report.html", "file", "HTML report");
    expect(larkAttach).toHaveBeenCalledWith("/tmp/report.html", "file", "HTML report");
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
      deliveries: [{ channel: "lark", ok: false, error: "upload failed" }],
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
      deliveries: [{ channel: "telegram", ok: false, error: "no attachment sender registered" }],
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
      deliveries: [{ channel: "telegram", ok: false, error: "file not found: missing.html" }],
    });
    expect(telegram).toHaveBeenCalledTimes(1);
    expect(attach).not.toHaveBeenCalled();
  });
});
