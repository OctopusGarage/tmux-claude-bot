import type { Messages } from "../i18n/catalog/zh.js";

type StringKey = { [K in keyof Messages]: Messages[K] extends string ? K : never }[keyof Messages];

export type AutopilotActionId = "delegate" | "review-plan" | "confirm-delegate" | "cancel-delegate";
export type AutopilotNavigationActionId = "back";

export type TelegramAutopilotCallbackKind =
  | "apDelegate"
  | "apPlan"
  | "apConfirmDelegate"
  | "apCancelDelegate"
  | "apBack";

export type AutopilotActionMeta = {
  id: AutopilotActionId;
  labelKey: StringKey;
  larkCmd: string;
  telegramPrefix: string;
  telegramKind: Exclude<TelegramAutopilotCallbackKind, "apBack">;
  style?: "danger" | "primary";
};

export const AUTOPILOT_ACTIONS: Record<AutopilotActionId, AutopilotActionMeta> = {
  delegate: {
    id: "delegate",
    labelKey: "btnApDelegateNow",
    larkCmd: "ap_delegate",
    telegramPrefix: "apd",
    telegramKind: "apDelegate",
    style: "primary",
  },
  "review-plan": {
    id: "review-plan",
    labelKey: "btnApReviewPlan",
    larkCmd: "ap_plan",
    telegramPrefix: "app",
    telegramKind: "apPlan",
  },
  "confirm-delegate": {
    id: "confirm-delegate",
    labelKey: "btnApConfirmDelegate",
    larkCmd: "ap_confirm_delegate",
    telegramPrefix: "apc",
    telegramKind: "apConfirmDelegate",
    style: "primary",
  },
  "cancel-delegate": {
    id: "cancel-delegate",
    labelKey: "btnApCancelDelegate",
    larkCmd: "ap_cancel_delegate",
    telegramPrefix: "apz",
    telegramKind: "apCancelDelegate",
    style: "danger",
  },
};

export const AUTOPILOT_BACK_ACTION = {
  id: "back",
  labelKey: "btnApBack",
  telegramPrefix: "apl",
  telegramKind: "apBack",
} satisfies {
  id: AutopilotNavigationActionId;
  labelKey: StringKey;
  telegramPrefix: string;
  telegramKind: "apBack";
};

export const AUTOPILOT_PANEL_ROWS: readonly (readonly AutopilotActionId[])[] = [
  ["delegate", "review-plan"],
];

export const AUTOPILOT_ACTIVE_PANEL_ROWS: readonly (readonly AutopilotActionId[])[] = [
  ["cancel-delegate"],
];

export const AUTOPILOT_PLAN_ROWS: readonly (readonly AutopilotActionId[])[] = [
  ["confirm-delegate"],
];

export function autopilotTelegramCallback(action: AutopilotActionId, sid: string): string {
  return `${AUTOPILOT_ACTIONS[action].telegramPrefix}:${sid}`;
}

export function autopilotBackTelegramCallback(sid: string): string {
  return `${AUTOPILOT_BACK_ACTION.telegramPrefix}:${sid}`;
}

export function autopilotActionFromTelegramPrefix(prefix: string): AutopilotActionMeta | null {
  return (
    Object.values(AUTOPILOT_ACTIONS).find((action) => action.telegramPrefix === prefix) ?? null
  );
}
