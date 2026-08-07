/** Parse formatted prompt-tool output from forge-mcp-server. Tolerates minor format drift. */

export interface PromptSummary {
  name: string;
  tags: string[];
  description: string;
  snippet: string;
}

const ROW = /^•\s+(.+)\s+\[([^\]]*)\](?:\s+—\s+(.*))?$/;

/** Parse search_prompts/list output. No matches or an empty library returns []. */
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

/** Parse list_prompt_tags output. No tags returns []. */
export function parseTagList(text: string): Array<{ tag: string; count: number }> {
  const out: Array<{ tag: string; count: number }> = [];
  for (const line of text.split("\n")) {
    const m = line.match(TAG_ROW);
    if (m) out.push({ tag: (m[1] ?? "").trim(), count: Number(m[2]) });
  }
  return out;
}
