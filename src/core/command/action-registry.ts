/**
 * Single source of truth for action metadata and UI layout.
 *
 * To add a new command:
 *   1. actions.ts    — add to MESSAGE_ACTIONS
 *      dispatch.ts   — add a case (execution logic)
 *   2. action-registry.ts — add to ACTION_META + relevant button row group(s),
 *                      then add one help taxonomy item when it is user-facing.
 *                      BOT_COMMANDS is derived from that taxonomy.
 *   3. catalog/*.ts  — add btnXxx + cmdXxx keys to zh.ts (canonical), then every
 *                      other language (en/zh-TW/yue/ja/es) — a missing key fails the build
 *   Everything else updates automatically:
 *     • lark/commands.ts  IMMEDIATE / QUEUED sets
 *     • telegram/handlers.ts  bot.command() registrations
 *     • telegram/keyboards.ts  keyboard layouts
 *     • lark/cards.ts  control panel + help card buttons
 */

import type { Messages } from "../i18n/catalog/zh.js";
import { messages } from "../i18n/index.js";
import type { MessageAction } from "./actions.js";

type StringKey = { [K in keyof Messages]: Messages[K] extends string ? K : never }[keyof Messages];

// ── Per-action metadata ──────────────────────────────────────────────────────

export interface ActionMeta {
  btnKey: StringKey;
  /** null = no slash command (action only reachable via button) */
  queuePolicy: "immediate" | "queued" | null;
  /** true = register as Telegram bot.command() */
  telegram: boolean;
  /** Button style override for surfaces that support styled actions. */
  buttonStyle?: "danger" | "primary";
  /** Present when a one-tap UI action must ask for explicit confirmation first. */
  confirmation?: ActionConfirmation;
}

export interface ActionConfirmation {
  severity: "warning" | "danger";
  impactKey: StringKey;
}

/** Metadata for every action that has a button or slash-command surface. */
export const ACTION_META: Partial<Record<MessageAction, ActionMeta>> = {
  enter: { btnKey: "btnEnter", queuePolicy: "immediate", telegram: true },
  esc: { btnKey: "btnEsc", queuePolicy: "immediate", telegram: true },
  interrupt: {
    btnKey: "btnInterrupt",
    queuePolicy: "immediate",
    telegram: true,
    buttonStyle: "danger",
  },
  restart: {
    btnKey: "btnRestart",
    queuePolicy: "queued",
    telegram: true,
    confirmation: { severity: "warning", impactKey: "confirmImpactRestart" },
  },
  clear: {
    btnKey: "btnClear",
    queuePolicy: "immediate",
    telegram: true,
    confirmation: { severity: "warning", impactKey: "confirmImpactClear" },
  },
  compact: {
    btnKey: "btnCompact",
    queuePolicy: "immediate",
    telegram: true,
    confirmation: { severity: "warning", impactKey: "confirmImpactCompact" },
  },
  up: { btnKey: "btnUp", queuePolicy: "immediate", telegram: true },
  down: { btnKey: "btnDown", queuePolicy: "immediate", telegram: true },
  left: { btnKey: "btnLeft", queuePolicy: "immediate", telegram: true },
  right: { btnKey: "btnRight", queuePolicy: "immediate", telegram: true },
  tab: { btnKey: "btnTab", queuePolicy: "immediate", telegram: true },
  exit: {
    btnKey: "btnExit",
    queuePolicy: "queued",
    telegram: true,
    confirmation: { severity: "danger", impactKey: "confirmImpactExit" },
  },
  status: { btnKey: "btnStatus", queuePolicy: "immediate", telegram: true },
  start: { btnKey: "btnStart", queuePolicy: "queued", telegram: true, buttonStyle: "primary" },
  resume: {
    btnKey: "btnResume",
    queuePolicy: "queued",
    telegram: true,
    buttonStyle: "primary",
  },
  // "text" — no button, not a slash command
};

// ── Canonical agent-control button layout ────────────────────────────────────
// ONE ordering, the single source for every control surface — Telegram's expanded
// panel, Lark's control card, and both help cards all render these rows in this
// order, so the surfaces can no longer drift. Telegram's COLLAPSED panel shows
// just the interrupts row + a "more ▾" toggle; expanding reveals the rest.
// Grouped by purpose: interrupts (mid-task essentials) → lifecycle → navigation.

/** Always-visible mid-task controls (also the Telegram collapsed row). */
export const CONTROL_INTERRUPTS: MessageAction[] = ["esc", "enter", "interrupt"];
/** Agent lifecycle. */
export const CONTROL_LIFECYCLE: MessageAction[] = ["restart", "clear", "compact", "exit"];
/** TUI navigation keys (rarely needed → only in the expanded / help surfaces). */
export const CONTROL_NAV: MessageAction[] = ["up", "down", "left", "right", "tab"];

/** Full control rows for the expanded Telegram panel and the Lark control card. */
export const CONTROL_ROWS_FULL: MessageAction[][] = [
  CONTROL_INTERRUPTS,
  CONTROL_LIFECYCLE,
  CONTROL_NAV,
];

/** Agent-action button rows for the help card "Session" section (adds start/status). */
export const HELP_SESSION_ROWS: MessageAction[][] = [
  ...CONTROL_ROWS_FULL,
  ["start", "resume", "status"],
];

// ── Derived sets / lists ─────────────────────────────────────────────────────

/**
 * Actions that bypass the queue and run immediately (keypresses, status).
 * Channel-neutral: both adapters share the same immediate/queued split, so the
 * Telegram executor and the Lark command router both derive from this — neither
 * hardcodes its own list (which drifted historically: telegram once omitted
 * `tab`).
 */
export function getImmediateActions(): Set<MessageAction> {
  return new Set(
    (Object.entries(ACTION_META) as [MessageAction, ActionMeta][])
      .filter(([, m]) => m.queuePolicy === "immediate")
      .map(([a]) => a),
  );
}

export function getQueuedActions(): Set<MessageAction> {
  return new Set(
    (Object.entries(ACTION_META) as [MessageAction, ActionMeta][])
      .filter(([, m]) => m.queuePolicy === "queued")
      .map(([a]) => a),
  );
}

export function getActionQueuePolicy(action: MessageAction): ActionMeta["queuePolicy"] {
  return ACTION_META[action]?.queuePolicy ?? null;
}

/** MessageActions that should be registered as Telegram bot.command() handlers. */
export function getTelegramActions(): MessageAction[] {
  return (Object.entries(ACTION_META) as [MessageAction, ActionMeta][])
    .filter(([, m]) => m.telegram)
    .map(([a]) => a);
}

export function getActionConfirmation(action: string): ActionConfirmation | null {
  if (!isRegisteredAction(action)) return null;
  return ACTION_META[action]?.confirmation ?? null;
}

export function requiresActionConfirmation(action: string): action is MessageAction {
  return getActionConfirmation(action) !== null;
}

export function actionLabel(action: MessageAction, channel: "telegram" | "lark"): string {
  const meta = ACTION_META[action];
  if (!meta) return action;
  const m = messages(channel);
  return m[meta.btnKey] as string;
}

export function actionConfirmationText(
  action: MessageAction,
  channel: "telegram" | "lark",
  target: string,
): string | null {
  const confirmation = getActionConfirmation(action);
  if (!confirmation) return null;
  const m = messages(channel);
  return m.confirmActionBody(
    actionLabel(action, channel),
    m[confirmation.impactKey] as string,
    target,
  );
}

export function actionConfirmButtonText(
  action: MessageAction,
  channel: "telegram" | "lark",
): string {
  return messages(channel).btnConfirmAction(actionLabel(action, channel));
}

function isRegisteredAction(action: string): action is MessageAction {
  return action in ACTION_META;
}

export interface ActionButtonSpec {
  action: MessageAction;
  text: string;
  style?: "danger" | "primary";
}

export function actionButtonSpec(
  action: MessageAction,
  channel: "telegram" | "lark",
): ActionButtonSpec | null {
  const meta = ACTION_META[action];
  if (!meta) return null;
  const m = messages(channel);
  return {
    action,
    text: m[meta.btnKey] as string,
    ...(meta.buttonStyle ? { style: meta.buttonStyle } : {}),
  };
}

export function actionButtonRows(
  rows: readonly (readonly MessageAction[])[],
  channel: "telegram" | "lark",
): ActionButtonSpec[][] {
  return rows.map((row) =>
    row.flatMap((action) => {
      const spec = actionButtonSpec(action, channel);
      return spec ? [spec] : [];
    }),
  );
}

export { BOT_COMMANDS, buildHelpBody } from "./help-catalog.js";
