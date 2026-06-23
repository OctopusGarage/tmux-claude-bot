/** 窄接口:UI 唯一依赖。工厂可注入 fake caller 供测试。 */

import type { AppConfig } from "../../shared/types.js";
import { sessionShortId } from "../../shared/utils/hash.js";
import { callPromptTool, promptLibEnabled } from "./client.js";
import { type PromptSummary, parseSearchResults, parseTagList } from "./parse.js";

export type PromptCaller = (tool: string, args: Record<string, unknown>) => Promise<string>;

export interface PromptLib {
  isEnabled(): boolean;
  search(query: string, tag: string): Promise<PromptSummary[]>;
  get(name: string): Promise<string>;
  listTags(): Promise<Array<{ tag: string; count: number }>>;
}

export function makePromptLib(config: AppConfig, caller?: PromptCaller): PromptLib {
  const cfg = config.promptMcp;
  const call: PromptCaller = caller ?? ((tool, args) => callPromptTool(cfg, tool, args));
  return {
    isEnabled: () => promptLibEnabled(cfg),
    search: async (query, tag) => parseSearchResults(await call("search_prompts", { query, tag })),
    get: (name) => call("get_prompt", { name }),
    listTags: async () => parseTagList(await call("list_prompt_tags", {})),
  };
}

/** 反查:short-id → 提示词名(扫全量)。镜像 resolveAliveSessionByShortId。 */
export async function resolvePromptByShortId(lib: PromptLib, id: string): Promise<string | null> {
  const all = await lib.search("", "");
  return all.find((p) => sessionShortId(p.name) === id)?.name ?? null;
}

/** 反查:short-id → 标签。Pass `prefetched` to skip a redundant listTags call. */
export async function resolveTagByShortId(
  lib: PromptLib,
  id: string,
  prefetched?: Array<{ tag: string; count: number }>,
): Promise<string | null> {
  const tags = prefetched ?? (await lib.listTags());
  return tags.find((t) => sessionShortId(t.tag) === id)?.tag ?? null;
}
