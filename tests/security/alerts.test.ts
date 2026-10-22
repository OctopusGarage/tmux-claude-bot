import { describe, expect, it, vi } from "vitest";
import { SecurityAlerts } from "../../src/core/security/alerts.js";
import { createLogger } from "../../src/shared/utils/logger.js";

vi.mock("../../src/shared/utils/logger.js", () => {
  const log = { warn: vi.fn() };
  return { createLogger: () => log };
});

function fixture() {
  let now = 1_000_000;
  const alerts = new SecurityAlerts({ now: () => now });
  const send = vi.fn(async (_recipient: string, _text: string) => {});
  alerts.register("telegram", ["123", "123", "456"], send);
  return {
    alerts,
    send,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
const settle = async () => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

describe("passive security alerts", () => {
  it("aggregates denials and privately warns each distinct configured recipient at five", async () => {
    const f = fixture();
    for (let i = 0; i < 4; i++) f.alerts.record("telegram", "identity");
    await settle();
    expect(f.send).not.toHaveBeenCalled();
    f.alerts.record("lark", "approval");
    await settle();
    expect(f.send.mock.calls.map(([recipient]) => recipient)).toEqual(["123", "456"]);
    const text = f.send.mock.calls[0]?.[1];
    expect(text).toContain("/lock");
    expect(text).toContain("tcb security revoke");
    expect(text).toContain("lark");
    expect(text).not.toContain("undefined");
  });
  it("excludes group identifiers and unlisted recipients from private delivery", async () => {
    const f = fixture();
    const telegram = vi.fn(async () => {});
    const lark = vi.fn(async () => {});
    f.alerts.register("telegram", ["123", "-100123", "@group"], telegram);
    f.alerts.register("lark", ["ou_owner", "oc_group"], lark);
    for (let i = 0; i < 5; i++) f.alerts.record("telegram", "identity");
    await settle();
    expect(telegram).toHaveBeenCalledExactlyOnceWith("123", expect.any(String));
    expect(lark).toHaveBeenCalledExactlyOnceWith("ou_owner", expect.any(String));
  });
  it("expires old events at the rolling window boundary", async () => {
    const f = fixture();
    for (let i = 0; i < 4; i++) f.alerts.record("telegram", "authorization");
    f.advance(600_000);
    f.alerts.record("telegram", "authorization");
    await settle();
    expect(f.send).not.toHaveBeenCalled();
    for (let i = 0; i < 4; i++) f.alerts.record("telegram", "authorization");
    await settle();
    expect(f.send).toHaveBeenCalledTimes(2);
  });
  it("reserves cooldown before delivery and discards attempts during cooldown", async () => {
    const f = fixture();
    for (let i = 0; i < 100; i++) f.alerts.record("telegram", "approval");
    await settle();
    expect(f.send).toHaveBeenCalledTimes(2);
    f.advance(600_000);
    f.alerts.record("telegram", "identity");
    await settle();
    expect(f.send).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 4; i++) f.alerts.record("lark", "identity");
    await settle();
    expect(f.send).toHaveBeenCalledTimes(4);
  });
  it("does not wait for a stuck sender or prevent another channel from receiving", async () => {
    const f = fixture();
    const slow = vi.fn(() => new Promise<void>(() => {}));
    const lark = vi.fn(async () => {});
    f.alerts.register("telegram", ["123"], slow);
    f.alerts.register("lark", ["ou_owner"], lark);
    for (let i = 0; i < 5; i++) expect(f.alerts.record("telegram", "approval")).toBeUndefined();
    await settle();
    expect(lark).toHaveBeenCalledOnce();
    expect(slow).toHaveBeenCalledOnce();
  });
  it("contains synchronous and asynchronous send failures and keeps the cooldown", async () => {
    const f = fixture();
    const send = vi.fn((recipient: string) => {
      if (recipient === "123") throw new Error("sensitive provider details");
      return Promise.reject(new Error("sensitive request details"));
    });
    const other = vi.fn(async () => {});
    f.alerts.register("telegram", ["123", "456"], send);
    f.alerts.register("lark", ["ou_owner"], other);
    for (let i = 0; i < 10; i++) f.alerts.record("telegram", "identity");
    await settle();
    expect(send).toHaveBeenCalledTimes(2);
    expect(other).toHaveBeenCalledOnce();
    expect(
      JSON.stringify(vi.mocked(createLogger("security.alerts").warn).mock.calls),
    ).not.toContain("sensitive");
  });
});
