import { InputFile } from "grammy";
import { describe, expect, it, vi } from "vitest";
import { sendTelegramAttachment } from "../../../src/adapters/telegram/media.js";

const api = () => ({ sendPhoto: vi.fn(async () => {}), sendDocument: vi.fn(async () => {}) });

describe("sendTelegramAttachment", () => {
  it("sends an image via sendPhoto to the numeric chatId with caption", async () => {
    const a = api();
    await sendTelegramAttachment(a as never, "55", "/x.png", "image", "cap");
    expect(a.sendPhoto).toHaveBeenCalledTimes(1);
    expect(a.sendPhoto).toHaveBeenCalledWith(55, expect.any(InputFile), { caption: "cap" });
    expect(a.sendDocument).not.toHaveBeenCalled();
  });
  it("sends a file via sendDocument", async () => {
    const a = api();
    await sendTelegramAttachment(a as never, "55", "/x.pdf", "file");
    expect(a.sendDocument).toHaveBeenCalledTimes(1);
    expect(a.sendDocument).toHaveBeenCalledWith(55, expect.any(InputFile), {});
    expect(a.sendPhoto).not.toHaveBeenCalled();
  });
});
