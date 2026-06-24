import type { Context } from "grammy";
import { messages } from "../../core/i18n/index.js";
import type { PromptLib } from "../../core/promptlib/promptlib.js";
import { buildPromptsPage } from "../../core/promptlib/view.js";
import { buildPromptsKeyboard } from "./keyboards.js";
import { reply } from "./replies.js";
import type { ReplyTargetMap } from "./reply-target.js";

/** Render a browse page (optionally filtered by tag), send the list card. */
export async function sendPromptsPage(
  ctx: Context,
  lib: PromptLib,
  page: number,
  tagFilter: string,
  replyTarget: ReplyTargetMap,
  prefetchedTags?: Array<{ tag: string; count: number }>,
): Promise<void> {
  const pg = await buildPromptsPage(lib, page, tagFilter, prefetchedTags);
  if (pg.total === 0) {
    await reply(ctx, "list", messages("telegram").promptsEmpty, { replyTarget });
    return;
  }
  await reply(ctx, "list", messages("telegram").promptsTitle(pg.total), {
    replyTarget,
    replyMarkup: buildPromptsKeyboard(pg.items, pg.tags, pg.view),
  });
}
