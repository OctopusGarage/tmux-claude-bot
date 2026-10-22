import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { downloadMessageResource } = vi.hoisted(() => ({
  downloadMessageResource: vi.fn(),
}));

const { prepareUserPromptDelivery } = vi.hoisted(() => ({
  prepareUserPromptDelivery: vi.fn(),
}));

vi.mock("../../../src/adapters/lark/resource.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/adapters/lark/resource.js")>()),
  downloadMessageResource,
}));

vi.mock("../../../src/core/read/user-prompt-intake.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/core/read/user-prompt-intake.js")>()),
  prepareUserPromptDelivery,
}));

const { handleLarkImage } = await import("../../../src/adapters/lark/image.js");
const { fakeChannel, fakeDeps, fakeMessage } = await import("./_fakes.js");

describe("handleLarkImage", () => {
  let oldStateDir: string | undefined;
  let stateDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    prepareUserPromptDelivery.mockImplementation(async (_source, text) => ({
      ok: true,
      text,
      origin: "user",
      promptSource: "lark",
      preview: { kind: "none" },
    }));
    downloadMessageResource.mockImplementation(async (_cfg, _messageId, _fileKey, destPath) => {
      nodeFs.mkdirSync(nodePath.dirname(destPath), { recursive: true });
      nodeFs.writeFileSync(destPath, "fake-image");
    });
    oldStateDir = process.env.TCB_STATE_DIR;
    stateDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "tcb-lark-image-"));
    process.env.TCB_STATE_DIR = stateDir;
  });

  afterEach(() => {
    if (oldStateDir === undefined) {
      delete process.env.TCB_STATE_DIR;
    } else {
      process.env.TCB_STATE_DIR = oldStateDir;
    }
    nodeFs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("downloads an image and enqueues a prompt with the caption and local path", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps();
    const image = { type: "image" as const, fileKey: "img-1" };
    const msg = fakeMessage({
      messageId: "om_123",
      rawContentType: "image",
      content: "what is in this screenshot?",
      resources: [image],
    });

    await handleLarkImage(channel, deps, msg, image, "proj-override");

    expect(downloadMessageResource).toHaveBeenCalledWith(
      expect.anything(),
      "om_123",
      "img-1",
      expect.stringContaining(stateDir),
      "image",
    );
    expect(deps.queue.enqueued).toHaveLength(1);
    expect(deps.queue.enqueued[0]?.action).toBe("text");
    expect(deps.queue.enqueued[0]?.sessionName).toBe("proj-override");
    expect(deps.queue.enqueued[0]?.text).toContain("what is in this screenshot?");
    expect(deps.queue.enqueued[0]?.text).toMatch(/Image path: .+/);
    expect(
      nodeFs.existsSync(deps.queue.enqueued[0]?.text.match(/Image path: (.+)/)?.[1] ?? ""),
    ).toBe(true);
  });

  it("uses the default analysis instruction when the image has no caption", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps();
    const image = { type: "image" as const, fileKey: "img-2" };
    const msg = fakeMessage({
      messageId: "om_456",
      rawContentType: "image",
      content: "",
      resources: [image],
    });

    await handleLarkImage(channel, deps, msg, image);

    expect(deps.queue.enqueued).toHaveLength(1);
    expect(deps.queue.enqueued[0]?.text).toContain("Please analyze the attached image.");
    expect(deps.queue.enqueued[0]?.text).toMatch(/Image path: .+/);
  });

  it("replies with an image download failure and does not enqueue when download fails", async () => {
    downloadMessageResource.mockRejectedValueOnce(new Error("download failed"));
    const channel = fakeChannel();
    const deps = fakeDeps();
    const image = { type: "image" as const, fileKey: "img-3" };
    const msg = fakeMessage({
      messageId: "om_789",
      rawContentType: "image",
      content: "please inspect this",
      resources: [image],
    });

    await handleLarkImage(channel, deps, msg, image);

    expect(channel.texts().some((text) => text.includes("图片下载失败"))).toBe(true);
    expect(deps.queue.enqueued).toHaveLength(0);
  });

  it("keeps the local image path out of prompt translation", async () => {
    prepareUserPromptDelivery.mockImplementationOnce(async () => {
      throw new Error("translator should not see image paths");
    });
    const channel = fakeChannel();
    const deps = fakeDeps();
    const image = { type: "image" as const, fileKey: "img-4" };
    const msg = fakeMessage({
      messageId: "om_path_exact",
      rawContentType: "image",
      content: "describe exactly",
      resources: [image],
    });

    await handleLarkImage(channel, deps, msg, image);

    const destPath = downloadMessageResource.mock.calls[0]?.[3];
    expect(typeof destPath).toBe("string");
    expect(prepareUserPromptDelivery).not.toHaveBeenCalled();
    expect(deps.queue.enqueued).toHaveLength(1);
    expect(deps.queue.enqueued[0]?.text).toBe(`describe exactly\n\nImage path: ${destPath}`);
    expect(deps.queue.enqueued[0]?.origin).toBe("user");
    expect(deps.queue.enqueued[0]?.promptSource).toBe("lark");
  });

  it("stores adversarial image identifiers under a safe attachment path", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps();
    const image = { type: "image" as const, fileKey: "../../file/key" };
    const msg = fakeMessage({
      messageId: "../chat/../../om_unsafe",
      rawContentType: "image",
      content: "inspect this",
      resources: [image],
    });

    await handleLarkImage(channel, deps, msg, image);

    const destPath = downloadMessageResource.mock.calls[0]?.[3];
    expect(typeof destPath).toBe("string");
    const relativePath = nodePath.relative(stateDir, destPath as string);
    const segments = relativePath.split(nodePath.sep);
    expect(segments.slice(0, 2)).toEqual(["attachments", "lark"]);
    expect(segments).not.toContain("..");
    expect(relativePath.endsWith(".image")).toBe(true);
  });

  it("rewrites exact dot path segments before storing images", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps();
    const image = { type: "image" as const, fileKey: ".." };
    const msg = fakeMessage({
      messageId: "..",
      rawContentType: "image",
      content: "inspect this",
      resources: [image],
    });

    await handleLarkImage(channel, deps, msg, image);

    const destPath = downloadMessageResource.mock.calls[0]?.[3];
    expect(typeof destPath).toBe("string");
    const relativePath = nodePath.relative(stateDir, destPath as string);
    expect(relativePath.split(nodePath.sep)).toEqual([
      "attachments",
      "lark",
      "image",
      "image.image",
    ]);
  });
});
