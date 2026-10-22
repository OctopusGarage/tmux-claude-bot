import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

const SCANNED_ROOTS = [
  "src/adapters",
  "src/cli.ts",
  "src/core/notifications",
  "src/core/read",
  "src/core/opportunities/command.ts",
  "src/scripts",
  "src/tui",
] as const;

const CJK_COPY = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

function isAllowedNonCopyLiteral(rel: string, line: string): boolean {
  // Native language labels and translation health-check probes are data, not UI copy.
  if (rel === "src/core/read/voice-support.ts") {
    return /\{\s*code:\s*"(zh|yue|ja)",\s*label:/.test(line);
  }
  if (rel === "src/core/read/prompt-translation.ts") {
    return line.includes('"你好"');
  }
  return false;
}

function walk(path: string): string[] {
  const stat = statSync(path);
  if (stat.isFile()) return path.endsWith(".ts") ? [path] : [];
  return readdirSync(path).flatMap((entry) => walk(join(path, entry)));
}

function scannedFiles(): string[] {
  return SCANNED_ROOTS.flatMap((root) => walk(join(ROOT, root))).sort();
}

describe("i18n hardcoded copy contract", () => {
  it("keeps localized chat-surface copy out of adapters and chat formatters", () => {
    const offenders = scannedFiles().flatMap((file) => {
      const rel = relative(ROOT, file);
      return readFileSync(file, "utf8")
        .split(/\r?\n/)
        .flatMap((line, index) =>
          CJK_COPY.test(line) && !isAllowedNonCopyLiteral(rel, line)
            ? [`${rel}:${index + 1}: ${line.trim()}`]
            : [],
        );
    });

    expect(offenders).toEqual([]);
  });
});
