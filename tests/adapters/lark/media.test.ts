import { describe, expect, it, vi } from "vitest";
import { sendLarkAttachment } from "../../../src/adapters/lark/media.js";

function fakeClient() {
  return {
    im: {
      v1: {
        // Real Lark SDK shape: the key is at the TOP LEVEL of the response (the
        // SDK unwraps `data`). A nested `data.image_key` fake hid a real 400 bug.
        image: { create: vi.fn(async () => ({ image_key: "img_1" })) },
        file: { create: vi.fn(async () => ({ file_key: "file_1" })) },
        message: { create: vi.fn(async () => ({ data: {} })) },
      },
    },
  };
}

describe("sendLarkAttachment", () => {
  it("uploads an image then sends an image message to the chat", async () => {
    const c = fakeClient();
    await sendLarkAttachment(c as never, "oc_x", "/d.png", "image", undefined, () => "STREAM");
    expect(c.im.v1.image.create).toHaveBeenCalledTimes(1);
    expect(c.im.v1.file.create).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const msg = (c.im.v1.message.create.mock.calls as any[][])[0]?.[0] as any;
    expect(msg.params).toEqual({ receive_id_type: "chat_id" });
    expect(msg.data.receive_id).toBe("oc_x");
    expect(msg.data.msg_type).toBe("image");
    expect(JSON.parse(msg.data.content)).toEqual({ image_key: "img_1" });
  });

  it("FIX3: throws when image upload returns no image_key", async () => {
    const c = fakeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    c.im.v1.image.create = vi.fn(async () => ({}) as any);
    await expect(
      sendLarkAttachment(c as never, "oc_x", "/d.png", "image", undefined, () => "STREAM"),
    ).rejects.toThrow(/image_key/);
  });

  it("FIX3: throws when file upload returns no file_key", async () => {
    const c = fakeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    c.im.v1.file.create = vi.fn(async () => ({}) as any);
    await expect(
      sendLarkAttachment(c as never, "oc_x", "/r.pdf", "file", undefined, () => "STREAM"),
    ).rejects.toThrow(/file_key/);
  });

  it("uploads a file then sends a file message, plus a caption text message", async () => {
    const c = fakeClient();
    await sendLarkAttachment(c as never, "oc_x", "/r.pdf", "file", "see attached", () => "STREAM");
    expect(c.im.v1.file.create).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const types = (c.im.v1.message.create.mock.calls as any[][]).map(
      (call) => (call[0] as any).data.msg_type,
    );
    expect(types).toContain("file");
    expect(types).toContain("text"); // caption sent as a separate text message
  });
});
