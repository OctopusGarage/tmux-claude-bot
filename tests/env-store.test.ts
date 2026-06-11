import * as fs from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  chmodSync: vi.fn(),
  renameSync: vi.fn(),
}));

import { persistEnvVar } from "../src/core/env-store.js";

const existsSyncMock = fs.existsSync as ReturnType<typeof vi.fn>;

describe("persistEnvVar", () => {
  beforeEach(() => vi.clearAllMocks());

  it("is a no-op when .env does not exist", () => {
    existsSyncMock.mockReturnValue(false);
    persistEnvVar("MY_KEY", "value");
    expect(fs.readFileSync).not.toHaveBeenCalled();
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it("writes the updated key when .env exists", () => {
    existsSyncMock.mockReturnValue(true);
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue("EXISTING=1\n");
    persistEnvVar("NEW_KEY", "hello");
    expect(fs.writeFileSync).toHaveBeenCalled();
    expect(fs.renameSync).toHaveBeenCalled();
  });
});
