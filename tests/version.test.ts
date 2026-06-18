import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { appVersion } from "../src/shared/version.js";

describe("appVersion", () => {
  it("resolves the project's package.json version (not the 0.0.0 default)", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
    expect(appVersion()).toBe(pkg.version);
    expect(appVersion()).not.toBe("0.0.0");
  });
});
