import { afterEach, describe, expect, it } from "vitest";
import { formatScheduledTime, scheduleMessages } from "../../src/core/i18n/scheduled-messages.js";

const originalLanguage = process.env.TELEGRAM_UI_LANG;
afterEach(() => {
  if (originalLanguage === undefined) delete process.env.TELEGRAM_UI_LANG;
  else process.env.TELEGRAM_UI_LANG = originalLanguage;
});

describe("scheduled-message localization", () => {
  it("provides usable scheduling controls in every supported UI language", () => {
    const keys: string[] = [];
    for (const language of ["en", "zh", "zh-TW", "yue", "ja", "es"]) {
      process.env.TELEGRAM_UI_LANG = language;
      const catalog = scheduleMessages("telegram");
      expect(catalog.confirm.length).toBeGreaterThan(0);
      expect(catalog.uncertain.length).toBeGreaterThan(0);
      expect(catalog.enterText.length).toBeGreaterThan(0);
      expect(
        Object.values(catalog).every((value) => typeof value === "string" && value.length > 0),
      ).toBe(true);
      if (keys.length === 0) keys.push(...Object.keys(catalog).sort());
      else expect(Object.keys(catalog).sort()).toEqual(keys);
    }
  });

  it("selects the requested channel's language", () => {
    process.env.TELEGRAM_UI_LANG = "en";
    expect(scheduleMessages("telegram").create).toBe("Schedule message");
    process.env.TELEGRAM_UI_LANG = "zh";
    expect(scheduleMessages("telegram").create).toBe("定时发送");
  });
  it("renders the selected offset rather than the host timezone", () => {
    const dueAt = Date.parse("2026-10-24T09:00:00+08:00");
    expect(formatScheduledTime(dueAt, "UTC+08:00", "en-GB")).toContain("09:00");
    expect(formatScheduledTime(dueAt, "UTC-04:30", "en-GB")).toContain("20:30");
    expect(formatScheduledTime(dueAt, "Asia/Tokyo", "en-GB")).toContain("10:00");
  });
});
