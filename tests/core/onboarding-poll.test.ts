import { describe, expect, it, vi } from "vitest";
import { pollForCaptureIds } from "../../src/core/onboarding.js";

const msg = (id: number, username?: string, updateId = id) => ({
  update_id: updateId,
  message: { from: { id, ...(username ? { username } : {}) } },
});
const noSleep = (): Promise<void> => Promise.resolve();

describe("pollForCaptureIds", () => {
  it("captures the pending message on the first poll and returns immediately", async () => {
    const getUpdates = vi.fn().mockResolvedValueOnce([msg(777, "alice")]);
    const onCapture = vi.fn();
    const ids = await pollForCaptureIds(
      { getUpdates, now: () => 0, sleep: noSleep, onCapture },
      10_000,
    );
    expect(ids).toEqual(["777"]);
    expect(onCapture).toHaveBeenCalledWith("777", "alice");
    expect(getUpdates).toHaveBeenCalledTimes(1);
  });

  it("is crash-proof: retries after a failing poll, then captures", async () => {
    const getUpdates = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce([msg(42)]);
    const ids = await pollForCaptureIds({ getUpdates, now: () => 0, sleep: noSleep }, 10_000);
    expect(ids).toEqual(["42"]);
    expect(getUpdates).toHaveBeenCalledTimes(2);
  });

  it("returns [] on timeout (proxy never delivers) so the wizard falls back to manual", async () => {
    let t = 0;
    const now = (): number => {
      const v = t;
      t += 50;
      return v;
    };
    const getUpdates = vi.fn().mockResolvedValue([]); // always empty
    const ids = await pollForCaptureIds({ getUpdates, now, sleep: noSleep }, 100);
    expect(ids).toEqual([]);
  });

  it("skips non-message updates, advances the offset, captures the real sender", async () => {
    const getUpdates = vi
      .fn()
      .mockResolvedValueOnce([{ update_id: 5 }]) // no message
      .mockResolvedValueOnce([msg(99, "bob", 6)]);
    const ids = await pollForCaptureIds({ getUpdates, now: () => 0, sleep: noSleep }, 10_000);
    expect(ids).toEqual(["99"]);
    expect(getUpdates).toHaveBeenNthCalledWith(2, 6); // offset = 5 + 1
  });
});
