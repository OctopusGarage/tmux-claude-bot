import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the MCP SDK so we exercise client.ts's connect-cache / dedup / drop-on-error
// logic without spawning a real forge-mcp-server subprocess.
const connect = vi.fn(async () => {});
const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "hi" }] }) as unknown);
const close = vi.fn(async () => {});
const ClientCtor = vi.fn(function Client() {
  return { connect, callTool, close };
});
const TransportCtor = vi.fn(function StdioClientTransport() {
  return {};
});

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({ Client: ClientCtor }));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: TransportCtor,
}));
vi.mock("../../src/shared/utils/logger.js", () => {
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { logger: log, createLogger: () => log };
});

const cfg = { command: "uv", args: ["run", "x"] };

// Each test gets a fresh client.ts module so its module-level cached/connecting reset.
async function freshClient() {
  vi.resetModules();
  return import("../../src/core/promptlib/client.js");
}

beforeEach(() => {
  for (const m of [connect, callTool, close, ClientCtor, TransportCtor]) m.mockClear();
  connect.mockResolvedValue(undefined);
  callTool.mockResolvedValue({ content: [{ type: "text", text: "hi" }] });
});

describe("promptLibEnabled", () => {
  it("is true with a command, false when blank", async () => {
    const { promptLibEnabled } = await freshClient();
    expect(promptLibEnabled({ command: "uv", args: [] })).toBe(true);
    expect(promptLibEnabled({ command: "", args: [] })).toBe(false);
    expect(promptLibEnabled({ command: "   ", args: [] })).toBe(false);
  });
});

describe("callPromptTool", () => {
  it("joins text content, filtering non-text and missing text", async () => {
    const { callPromptTool } = await freshClient();
    callTool.mockResolvedValueOnce({
      content: [
        { type: "text", text: "a" },
        { type: "image", data: "x" },
        { type: "text" }, // missing text → ""
        { type: "text", text: "b" },
      ],
    });
    expect(await callPromptTool(cfg, "search", { q: 1 })).toBe("a\n\nb");
    expect(callTool).toHaveBeenCalledWith({ name: "search", arguments: { q: 1 } });
  });

  it("returns an empty string when the result has no content", async () => {
    const { callPromptTool } = await freshClient();
    callTool.mockResolvedValueOnce({});
    expect(await callPromptTool(cfg, "t", {})).toBe("");
  });

  it("caches the client across calls (connects once)", async () => {
    const { callPromptTool } = await freshClient();
    await callPromptTool(cfg, "t", {});
    await callPromptTool(cfg, "t", {});
    expect(connect).toHaveBeenCalledTimes(1);
    expect(ClientCtor).toHaveBeenCalledTimes(1);
  });

  it("dedups concurrent connects into one in-flight connection", async () => {
    const { callPromptTool } = await freshClient();
    let release = () => {};
    connect.mockImplementationOnce(() => new Promise<void>((r) => (release = () => r())));
    const p1 = callPromptTool(cfg, "t", {});
    const p2 = callPromptTool(cfg, "t", {});
    release();
    await Promise.all([p1, p2]);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("drops the client on a failed call and reconnects on the next one", async () => {
    const { callPromptTool } = await freshClient();
    callTool.mockRejectedValueOnce(new Error("boom"));
    await expect(callPromptTool(cfg, "t", {})).rejects.toThrow("boom");
    expect(close).toHaveBeenCalledTimes(1); // dropClient closed the cached client
    await callPromptTool(cfg, "t", {}); // succeeds → must reconnect
    expect(connect).toHaveBeenCalledTimes(2);
    expect(ClientCtor).toHaveBeenCalledTimes(2);
  });

  it("passes cwd to the transport when set, and omits it when not", async () => {
    const a = await freshClient();
    await a.callPromptTool({ command: "uv", args: ["r"], cwd: "wd" }, "t", {});
    expect(TransportCtor).toHaveBeenLastCalledWith({ command: "uv", args: ["r"], cwd: "wd" });
    const b = await freshClient();
    await b.callPromptTool({ command: "uv", args: ["r"] }, "t", {});
    expect(TransportCtor).toHaveBeenLastCalledWith({ command: "uv", args: ["r"] });
  });
});
