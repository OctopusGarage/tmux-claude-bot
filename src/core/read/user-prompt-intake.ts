import type { QueuedMessage } from "../command/queue.js";
import {
  type PromptTransformSource,
  prepareUserPrompt,
  type TranslateText,
} from "./prompt-translation.js";

export type UserPromptPreview =
  | { kind: "none" }
  | { kind: "text-translated"; from: string; to: string }
  | { kind: "voice"; sourceText: string }
  | {
      kind: "voice-translated";
      sourceText: string;
      deliveredText: string;
      from: string;
      to: string;
    };

export type PreparedUserPromptDelivery =
  | {
      ok: true;
      text: string;
      origin: "user";
      promptSource: PromptTransformSource;
      sourceText?: string | undefined;
      transform?: QueuedMessage["transform"];
      preview: UserPromptPreview;
    }
  | { ok: false; reason: "translate"; sourceText: string };

export type UserPromptPreviewKind = "text" | "voice";

type UserPromptQueueFields = Pick<
  QueuedMessage,
  "text" | "origin" | "promptSource" | "sourceText" | "transform"
>;

export async function prepareUserPromptDelivery(
  source: PromptTransformSource,
  text: string,
  previewKind: UserPromptPreviewKind = "text",
  deps: { translate?: TranslateText } = {},
): Promise<PreparedUserPromptDelivery> {
  const prepared = await prepareUserPrompt(source, text, deps);
  if (!prepared.ok) return { ok: false, reason: prepared.reason, sourceText: prepared.original };
  return {
    ok: true,
    text: prepared.text,
    origin: prepared.origin,
    promptSource: prepared.promptSource,
    sourceText: prepared.sourceText,
    transform: prepared.transform,
    preview: previewFor(previewKind, text, prepared.text, prepared.transform),
  };
}

export function userPromptQueueFields(
  delivery: Extract<PreparedUserPromptDelivery, { ok: true }>,
): UserPromptQueueFields {
  return {
    text: delivery.text,
    origin: delivery.origin,
    promptSource: delivery.promptSource,
    sourceText: delivery.sourceText,
    transform: delivery.transform,
  };
}

export type UserPromptRewriteQueue = {
  sessionByAck?: (ackMsgId: string, chatId: string | number) => string | null;
  rewriteByAck: (
    ackMsgId: string,
    chatId: string | number,
    newText: string,
    patch?: Partial<Pick<QueuedMessage, "origin" | "promptSource" | "sourceText" | "transform">>,
  ) => { kind: "rewritten" | "duplicate"; session: string } | { kind: "not-found" };
};

export type UserPromptRewriteResult =
  | { kind: "rewritten" | "duplicate"; session: string }
  | { kind: "not-found" }
  | { kind: "failed"; reason: "translate" };

export async function rewriteUserPromptByAck(
  queue: UserPromptRewriteQueue,
  req: {
    source: PromptTransformSource;
    ackMsgId: string;
    chatId: string | number;
    text: string;
    translate?: TranslateText;
  },
): Promise<UserPromptRewriteResult> {
  const text = req.text.trim();
  if (!text) return { kind: "not-found" };

  const session = queue.sessionByAck?.(req.ackMsgId, req.chatId) ?? null;
  if (!session) {
    return queue.rewriteByAck(req.ackMsgId, req.chatId, text);
  }

  const delivery = await prepareUserPromptDelivery(req.source, text, "text", {
    ...(req.translate ? { translate: req.translate } : {}),
  });
  if (!delivery.ok) return { kind: "failed", reason: delivery.reason };

  const { text: deliveredText, ...patch } = userPromptQueueFields(delivery);
  return queue.rewriteByAck(req.ackMsgId, req.chatId, deliveredText, patch);
}

function previewFor(
  kind: UserPromptPreviewKind,
  sourceText: string,
  deliveredText: string,
  transform: QueuedMessage["transform"],
): UserPromptPreview {
  if (kind === "voice") {
    if (transform?.kind === "translation") {
      return {
        kind: "voice-translated",
        sourceText,
        deliveredText,
        from: transform.from,
        to: transform.to,
      };
    }
    return { kind: "voice", sourceText };
  }
  if (transform?.kind === "translation") {
    return { kind: "text-translated", from: transform.from, to: transform.to };
  }
  return { kind: "none" };
}
