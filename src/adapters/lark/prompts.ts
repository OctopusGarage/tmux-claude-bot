import type { LarkChannel } from "@larksuiteoapi/node-sdk";
import type { HandlerDeps } from "../../core/deps.js";
import { messages } from "../../core/i18n/index.js";
import { makePromptLib } from "../../core/promptlib/promptlib.js";
import { buildPromptsPage, PROMPTS_PAGE_SIZE } from "../../core/promptlib/view.js";
import { createLogger } from "../../shared/utils/logger.js";
import { promptsCard } from "./cards.js";
import { sendCard, sendText } from "./replies.js";

const log = createLogger("lark.prompts");

export async function sendPrompts(
  channel: LarkChannel,
  deps: HandlerDeps,
  chatId: string,
  arg: string | undefined,
  page = 0,
  tagFilter = "",
  prefetchedTags?: Array<{ tag: string; count: number }>,
): Promise<void> {
  const lib = makePromptLib(deps.config);
  if (!lib.isEnabled()) {
    await sendText(channel, chatId, messages("lark").promptsDisabled);
    return;
  }
  try {
    if (arg?.trim()) {
      const items = await lib.search(arg.trim(), "");
      if (!items.length) {
        await sendText(channel, chatId, messages("lark").promptsEmpty);
        return;
      }
      await sendCard(
        channel,
        chatId,
        promptsCard(items.slice(0, PROMPTS_PAGE_SIZE), [], {
          page: 0,
          totalPages: 1,
          tagFilter: "",
        }),
      );
      return;
    }
    const pg = await buildPromptsPage(lib, page, tagFilter, prefetchedTags);
    if (!pg.total) {
      await sendText(channel, chatId, messages("lark").promptsEmpty);
      return;
    }
    await sendCard(channel, chatId, promptsCard(pg.items, pg.tags, pg.view));
  } catch (err) {
    log.warn("sendPrompts failed", { err });
    await sendText(channel, chatId, messages("lark").promptsError);
  }
}
