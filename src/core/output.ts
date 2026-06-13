// ANSI escape code regex. The literal FIRST character below is an ESC byte (0x1B)
// — it renders invisibly in most editors/viewers, so the literal looks like it
// starts with `/[@-_]` but is actually `/\x1b[@-_].../`, i.e. PROPERLY ANCHORED on
// ESC. Without that anchor the class `[@-_]` would match ordinary capital letters
// and eat plain text ("Hello" → "llo"). Do NOT "simplify" by removing the leading
// ESC; output.test.ts guards that plain capitalised text survives unchanged.
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI ESC sequence
const ANSI_REGEX = /[@-_][0-?]*[ -/]*[@-~]/g;

export type OutputProcessorOptions = {
  maxOutputLines: number;
  maxMessageLength: number;
};

export class OutputProcessor {
  private readonly maxOutputLines: number;
  private readonly maxMessageLength: number;

  constructor(options: OutputProcessorOptions) {
    this.maxOutputLines = options.maxOutputLines;
    this.maxMessageLength = options.maxMessageLength;
  }

  private clean(text: string): string {
    // Remove ANSI escape codes
    let cleaned = text.replace(ANSI_REGEX, "");
    // Remove tmux box drawing chars and UI elements
    cleaned = cleaned.replace(/[╭│➜⏵⏺❯▌▛█▜▝⎿⏣╮╯╰▀▐░▒▓]+/g, "");
    // Remove hook errors and system messages (only at line start to avoid deleting legitimate content)
    cleaned = cleaned.replace(/^hook error.*$/gim, "");
    cleaned = cleaned.replace(/^UserPromptSubmit.*$/gim, "");
    cleaned = cleaned.replace(/^english-gate\.sh.*$/gim, "");
    cleaned = cleaned.replace(/^bash:.*\.sh.*$/gim, "");
    // Remove lines that are mostly noise
    cleaned = cleaned
      .split("\n")
      .filter((l) => {
        const t = l.trim();
        if (!t) return false;
        if (/^[╭│─➜⏵⏺❯▌▛█▜▝⎿⏣ \-=★•·]+$/.test(t)) return false;
        if (t.includes("UserPromptSubmit")) return false;
        if (t.includes("hook error")) return false;
        if (t.includes("english-gate")) return false;
        return true;
      })
      .join("\n");
    // Empty lines were already filtered out above; no need to collapse further
    return cleaned.trim();
  }

  process(rawOutput: string): string {
    // Step 1: Clean noise
    const cleaned = this.clean(rawOutput);

    // Step 2: Split into lines, take last N lines
    const lines = cleaned.split("\n");
    const lastLines = lines.slice(-this.maxOutputLines);

    // Step 3: Trim and join
    let result = lastLines.join("\n").trim();

    // Step 4: Truncate to message limit (leave room for code block wrapper)
    const wrapperOverhead = 8; // ```\n...\n```
    const maxContent = this.maxMessageLength - wrapperOverhead;
    if (result.length > maxContent) {
      const start = result.length - maxContent;
      // Avoid cutting mid-line: start from the next newline after the cut point
      const firstNewline = result.indexOf("\n", start);
      if (firstNewline >= 0) {
        result = result.slice(firstNewline + 1);
      } else {
        result = result.slice(start);
      }
    }

    return result;
  }
}
