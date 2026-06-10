/**
 * Pure mapping from a successful `registerApp` (QR-scan) result into the
 * LARK_* env values the adapter reads from `.env`. Seeds the allowlist with
 * the scanning user's open_id so whoever onboarded is immediately authorized.
 */
export type LarkRegisterResult = {
  client_id: string;
  client_secret: string;
  user_info?: { open_id?: string; tenant_brand?: "feishu" | "lark" } | undefined;
};

export function buildLarkEnvValues(result: LarkRegisterResult): Record<string, string> {
  const domain = result.user_info?.tenant_brand === "lark" ? "lark" : "feishu";
  return {
    LARK_ENABLED: "true",
    LARK_APP_ID: result.client_id,
    LARK_APP_SECRET: result.client_secret,
    LARK_DOMAIN: domain,
    LARK_ALLOWED_OPEN_IDS: result.user_info?.open_id ?? "",
  };
}
