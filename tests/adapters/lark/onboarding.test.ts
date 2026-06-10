import { describe, expect, it } from "vitest";
import { buildLarkEnvValues } from "../../../src/adapters/lark/onboarding.js";

describe("buildLarkEnvValues", () => {
  it("maps credentials + tenant and seeds the scanner's open_id", () => {
    expect(
      buildLarkEnvValues({
        client_id: "cli_x",
        client_secret: "sec_x",
        user_info: { open_id: "ou_me", tenant_brand: "lark" },
      }),
    ).toEqual({
      LARK_ENABLED: "true",
      LARK_APP_ID: "cli_x",
      LARK_APP_SECRET: "sec_x",
      LARK_DOMAIN: "lark",
      LARK_ALLOWED_OPEN_IDS: "ou_me",
    });
  });

  it("defaults domain to feishu and tolerates missing user_info", () => {
    expect(buildLarkEnvValues({ client_id: "a", client_secret: "b" })).toEqual({
      LARK_ENABLED: "true",
      LARK_APP_ID: "a",
      LARK_APP_SECRET: "b",
      LARK_DOMAIN: "feishu",
      LARK_ALLOWED_OPEN_IDS: "",
    });
  });
});
