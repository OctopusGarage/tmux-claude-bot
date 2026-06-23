/** 解析 forge-mcp-server 提示词工具返回的格式化字符串(容错:格式微变不致崩)。 */

export interface PromptSummary {
  name: string;
  tags: string[];
  description: string;
  snippet: string;
}

const ROW = /^•\s+(.+)\s+\[([^\]]*)\](?:\s+—\s+(.*))?$/;

/** 解析 search_prompts / 列表输出。无匹配/空库 → []。 */
export function parseSearchResults(text: string): PromptSummary[] {
  const out: PromptSummary[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = (lines[i] ?? "").match(ROW);
    if (!m) continue;
    const next = lines[i + 1] ?? "";
    out.push({
      name: (m[1] ?? "").trim(),
      tags: (m[2] ?? "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
      description: (m[3] ?? "").trim(),
      snippet: next.startsWith("    ") ? next.trim() : "",
    });
  }
  return out;
}

const TAG_ROW = /^\s+(.+?)\s+\((\d+)\)\s*$/;

/** 解析 list_prompt_tags 输出。无标签 → []。 */
export function parseTagList(text: string): Array<{ tag: string; count: number }> {
  const out: Array<{ tag: string; count: number }> = [];
  for (const line of text.split("\n")) {
    const m = line.match(TAG_ROW);
    if (m) out.push({ tag: (m[1] ?? "").trim(), count: Number(m[2]) });
  }
  return out;
}
