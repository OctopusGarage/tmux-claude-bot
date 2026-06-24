import type { PromptSummary } from "./parse.js";
import type { PromptLib } from "./promptlib.js";

export const PROMPTS_PAGE_SIZE = 8;

export interface PromptsView {
  page: number;
  totalPages: number;
  /** "" = no filter; otherwise a tag name */
  tagFilter: string;
}

export interface PromptsPage {
  items: PromptSummary[];
  tags: Array<{ tag: string; count: number }>;
  view: PromptsView;
  /** Total unsliced result count (all pages combined). */
  total: number;
}

/** Single source for a browse page: fetches (search + listTags) + clamps + slices.
 *  Pass `prefetchedTags` to reuse a tag list already fetched this turn (skips a 2nd listTags). */
export async function buildPromptsPage(
  lib: PromptLib,
  page: number,
  tagFilter: string,
  prefetchedTags?: Array<{ tag: string; count: number }>,
): Promise<PromptsPage> {
  const [all, tags] = await Promise.all([
    lib.search("", tagFilter),
    prefetchedTags ? Promise.resolve(prefetchedTags) : lib.listTags(),
  ]);
  const totalPages = Math.max(1, Math.ceil(all.length / PROMPTS_PAGE_SIZE));
  const p = Math.min(Math.max(0, page), totalPages - 1);
  const items = all.slice(p * PROMPTS_PAGE_SIZE, (p + 1) * PROMPTS_PAGE_SIZE);
  return { items, tags, view: { page: p, totalPages, tagFilter }, total: all.length };
}
