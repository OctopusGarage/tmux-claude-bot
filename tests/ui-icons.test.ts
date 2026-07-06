import { describe, expect, it } from "vitest";
import { UI_ICON_MEANINGS, UI_ICONS } from "../src/shared/ui/icons.js";

function leafKeys(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object") return [prefix];
  return Object.entries(value).flatMap(([key, child]) =>
    leafKeys(child, prefix ? `${prefix}.${key}` : key),
  );
}

describe("UI icon registry", () => {
  it("documents every canonical icon key", () => {
    const keys = leafKeys(UI_ICONS).sort();
    const documented = UI_ICON_MEANINGS.map((entry) => entry.key).sort();
    expect(documented).toEqual(keys);
  });
});
