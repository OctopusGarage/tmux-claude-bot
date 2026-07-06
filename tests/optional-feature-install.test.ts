import { describe, expect, it } from "vitest";
import {
  renderOptionalFeatureInstallResult,
  runOptionalFeatureInstall,
} from "../src/core/read/optional-feature-install.js";

const copy = {
  installing: "installing",
  ok: "ok",
  alreadyReady: "already",
  inProgress: "installing",
  unsupported: "unsupported",
  failed: (message: string) => `failed:${message}`,
};

describe("optional feature install workflow", () => {
  it("maps install result states to one tone/text contract", () => {
    expect(renderOptionalFeatureInstallResult({ status: "ok" }, copy)).toEqual({
      tone: "info",
      text: "ok",
    });
    expect(renderOptionalFeatureInstallResult({ status: "failed", message: "boom" }, copy)).toEqual(
      {
        tone: "err",
        text: "failed:boom",
      },
    );
    expect(renderOptionalFeatureInstallResult({ status: "unsupported" }, copy)).toEqual({
      tone: "err",
      text: "unsupported",
    });
  });

  it("short-circuits precheck states without showing an installing ack", async () => {
    let installCalled = false;
    const install = async (): Promise<{ status: "already-ready" }> => {
      installCalled = true;
      return { status: "already-ready" };
    };
    const notices: string[] = [];

    const result = await runOptionalFeatureInstall({
      copy,
      precheck: () => ({ status: "already-ready" }),
      install,
      send: async (notice): Promise<void> => {
        notices.push(`${notice.tone}:${notice.text}`);
      },
    });

    expect(result).toEqual({ status: "already-ready" });
    expect(installCalled).toBe(false);
    expect(notices).toEqual(["info:already"]);
  });

  it("sends a shared installing ack before running a slow installer", async () => {
    const notices: string[] = [];

    const result = await runOptionalFeatureInstall({
      copy,
      install: async () => ({ status: "failed" as const, message: "missing model" }),
      send: async (notice): Promise<void> => {
        notices.push(`${notice.tone}:${notice.text}`);
      },
    });

    expect(result).toEqual({ status: "failed", message: "missing model" });
    expect(notices).toEqual(["info:installing", "err:failed:missing model"]);
  });
});
