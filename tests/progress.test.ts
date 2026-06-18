import { describe, expect, it, vi } from "vitest";

vi.mock("../src/shared/utils/logger.js", () => {
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { logger: log, createLogger: () => log };
});

import { startProgress } from "../src/adapters/telegram/progress.js";

function okApi() {
  return {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 555 }),
    editMessageText: vi.fn().mockResolvedValue(undefined),
  };
}

describe("startProgress", () => {
  it("sends an initial progress message and exposes its id", async () => {
    const api = okApi();
    const handle = await startProgress(api, 12345, "⏳ 处理中…");
    expect(api.sendMessage).toHaveBeenCalledWith(12345, "⏳ 处理中…", expect.any(Object));
    expect(handle?.messageId).toBe(555);
  });

  it("update() edits the same progress message in place", async () => {
    const api = okApi();
    const handle = await startProgress(api, 12345, "⏳ 处理中…");
    await handle?.update("⏳ 处理中…(用时 5s)");
    expect(api.editMessageText).toHaveBeenCalledWith(12345, 555, "⏳ 处理中…(用时 5s)");
  });

  it("update() after finalize() is a no-op (a late tick can't revert the result)", async () => {
    const api = okApi();
    const handle = await startProgress(api, 12345, "⏳ 处理中…");
    await handle?.finalize("✅ done");
    api.editMessageText.mockClear();
    await handle?.update("⏳ 处理中…(stale tick)");
    expect(api.editMessageText).not.toHaveBeenCalled();
  });

  it("finalize() edits the message with the given extra (e.g. parse_mode)", async () => {
    const api = okApi();
    const handle = await startProgress(api, 12345, "⏳ 处理中…");
    await handle?.finalize("✅ done", { parse_mode: "Markdown" });
    expect(api.editMessageText).toHaveBeenCalledWith(12345, 555, "✅ done", {
      parse_mode: "Markdown",
    });
  });

  it("returns null when the initial send fails (caller falls back)", async () => {
    const api = {
      sendMessage: vi.fn().mockRejectedValue(new Error("network")),
      editMessageText: vi.fn(),
    };
    const handle = await startProgress(api, 1, "x");
    expect(handle).toBeNull();
  });

  it("swallows edit errors so a failed update never breaks the flow", async () => {
    const api = okApi();
    api.editMessageText.mockRejectedValue(new Error("message not modified"));
    const handle = await startProgress(api, 1, "x");
    await expect(handle?.update("y")).resolves.toBeUndefined();
  });

  it("finalize retries without parse_mode when Markdown parsing fails, and reports success", async () => {
    const api = okApi();
    api.editMessageText
      .mockRejectedValueOnce({ error_code: 400, description: "can't parse entities" })
      .mockResolvedValueOnce(undefined);
    const handle = await startProgress(api, 1, "x");
    const ok = await handle?.finalize("**unbalanced", { parse_mode: "Markdown" });
    expect(ok).toBe(true);
    expect(api.editMessageText).toHaveBeenCalledTimes(2);
    const secondExtra = (api.editMessageText.mock.calls[1]?.[3] ?? {}) as Record<string, unknown>;
    expect(secondExtra.parse_mode).toBeUndefined();
  });

  it("finalize returns true on a successful edit", async () => {
    const api = okApi();
    const handle = await startProgress(api, 1, "x");
    expect(await handle?.finalize("done")).toBe(true);
  });

  it("finalize returns false when the edit ultimately fails", async () => {
    const api = okApi();
    api.editMessageText.mockRejectedValue(new Error("boom"));
    const handle = await startProgress(api, 1, "x");
    expect(await handle?.finalize("x", { parse_mode: "Markdown" })).toBe(false);
  });
});
