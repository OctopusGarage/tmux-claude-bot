import { afterEach, describe, expect, it } from "vitest";
import { redactSecrets } from "../src/shared/utils/logger.js";

describe("redactSecrets", () => {
  afterEach(() => {
    delete process.env.BOT_TOKEN;
  });

  it("redacts a Bot API token embedded in a fetch error URL", () => {
    const msg =
      "request to https://api.telegram.org/bot8539533731:AAFWBBIGehnl7oevUjrQwjJ1ir5IBdijq_U/getUpdates failed";
    const out = redactSecrets(msg);
    expect(out).not.toContain("AAFWBBIGehnl7oevUjrQwjJ1ir5IBdijq_U");
    expect(out).toContain("bot<redacted-token>");
  });

  it("redacts the exact configured token wherever it appears", () => {
    process.env.BOT_TOKEN = "8539533731:AAFWBBIGehnl7oevUjrQwjJ1ir5IBdijq_U";
    const out = redactSecrets("token leaked: 8539533731:AAFWBBIGehnl7oevUjrQwjJ1ir5IBdijq_U end");
    expect(out).toBe("token leaked: <redacted-token> end");
  });

  it("leaves token-free messages untouched", () => {
    const msg = "[smart-fetch] recovered via direct after preferred route failed";
    expect(redactSecrets(msg)).toBe(msg);
  });
});
