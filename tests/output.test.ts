import { describe, expect, it } from "vitest";
import { OutputProcessor } from "../src/core/output.js";

describe("OutputProcessor", () => {
  describe("constructor", () => {
    it("accepts maxOutputLines and maxMessageLength", () => {
      const processor = new OutputProcessor({ maxOutputLines: 50, maxMessageLength: 2000 });
      expect(processor).toBeDefined();
    });

    it("handles zero values", () => {
      const processor = new OutputProcessor({ maxOutputLines: 0, maxMessageLength: 0 });
      expect(processor).toBeDefined();
    });

    it("handles negative values (truncation will handle edge cases)", () => {
      const processor = new OutputProcessor({ maxOutputLines: -10, maxMessageLength: -100 });
      expect(processor).toBeDefined();
    });
  });

  describe("process", () => {
    it("removes ANSI escape codes", () => {
      const processor = new OutputProcessor({ maxOutputLines: 100, maxMessageLength: 4000 });
      const input = "\x1B[31mred\x1B[0m \x1B[32mgreen\x1B[0m normal";
      const result = processor.process(input);
      expect(result).not.toContain("\x1B");
      expect(result).toContain("red");
      expect(result).toContain("green");
      expect(result).toContain("normal");
    });

    it("keeps only last maxOutputLines lines", () => {
      const processor = new OutputProcessor({ maxOutputLines: 3, maxMessageLength: 4000 });
      const input = "line1\nline2\nline3\nline4\nline5";
      const result = processor.process(input);
      const lines = result.split("\n");
      expect(lines.length).toBeLessThanOrEqual(3);
      expect(result).toContain("line3");
      expect(result).toContain("line4");
      expect(result).toContain("line5");
    });

    it("handles fewer lines than maxOutputLines", () => {
      const processor = new OutputProcessor({ maxOutputLines: 10, maxMessageLength: 4000 });
      const input = "line1\nline2";
      const result = processor.process(input);
      expect(result).toBe("line1\nline2");
    });

    it("trims leading and trailing whitespace", () => {
      const processor = new OutputProcessor({ maxOutputLines: 100, maxMessageLength: 4000 });
      const input = "  spaced  \n  more  ";
      const result = processor.process(input);
      // trim() only removes leading/trailing, not internal spaces
      expect(result).toBe("spaced  \n  more");
    });

    it("handles empty string", () => {
      const processor = new OutputProcessor({ maxOutputLines: 100, maxMessageLength: 4000 });
      const result = processor.process("");
      expect(result).toBe("");
    });

    it("handles string with only newlines", () => {
      const processor = new OutputProcessor({ maxOutputLines: 100, maxMessageLength: 4000 });
      const result = processor.process("\n\n\n");
      expect(result).toBe("");
    });

    it("handles maxMessageLength truncation", () => {
      const processor = new OutputProcessor({ maxOutputLines: 100, maxMessageLength: 50 });
      const input = "a".repeat(200);
      const result = processor.process(input);
      // wrapperOverhead = 8, so maxContent = 50 - 8 = 42
      // result should be last 42 characters
      expect(result.length).toBeLessThanOrEqual(42);
    });

    it("preserves content near the truncation boundary", () => {
      const processor = new OutputProcessor({ maxOutputLines: 100, maxMessageLength: 60 });
      const input = `prefix_${"a".repeat(100)}`;
      const result = processor.process(input);
      // Since we're slicing from the end, we should see the tail of the content
      expect(result.length).toBeLessThanOrEqual(52); // 60 - 8 = 52
    });

    it("handles maxOutputLines of 1", () => {
      const processor = new OutputProcessor({ maxOutputLines: 1, maxMessageLength: 4000 });
      const input = "line1\nline2\nline3";
      const result = processor.process(input);
      expect(result).toBe("line3");
    });

    it("handles maxOutputLines of 0", () => {
      const processor = new OutputProcessor({ maxOutputLines: 0, maxMessageLength: 4000 });
      const input = "line1\nline2";
      const result = processor.process(input);
      // slice(-0) returns all elements, then join and trim
      expect(result).toBe("line1\nline2");
    });

    it("handles all ANSI escape code patterns", () => {
      const processor = new OutputProcessor({ maxOutputLines: 100, maxMessageLength: 4000 });
      // Various ANSI escape sequences
      const input = "\x1B[0m\x1B[1m\x1B[31m\x1B[4mcolored\x1B[0m\x1B[m";
      const result = processor.process(input);
      expect(result).toBe("colored");
      expect(result).not.toContain("\x1B");
    });

    it("handles tmux output with box drawing characters", () => {
      const processor = new OutputProcessor({ maxOutputLines: 100, maxMessageLength: 4000 });
      const input = "╭─ text ─╮\n│ content │\n╰─────────╯";
      const result = processor.process(input);
      expect(result).toBe("─ text ─\n content");
    });

    it("handles mixed ANSI and regular text", () => {
      const processor = new OutputProcessor({ maxOutputLines: 100, maxMessageLength: 4000 });
      const input = "\x1B[32m✓\x1B[0m Success: \x1B[1mbold\x1B[0m text";
      const result = processor.process(input);
      expect(result).toBe("✓ Success: bold text");
    });

    it("handles multiline with trailing newlines", () => {
      const processor = new OutputProcessor({ maxOutputLines: 100, maxMessageLength: 4000 });
      const input = "line1\nline2\nline3\n\n";
      const result = processor.process(input);
      expect(result).toBe("line1\nline2\nline3");
    });

    it("handles very long single line", () => {
      const processor = new OutputProcessor({ maxOutputLines: 100, maxMessageLength: 100 });
      const input = "a".repeat(500);
      const result = processor.process(input);
      // maxContent = 100 - 8 = 92, so should be last 92 chars
      expect(result.length).toBeLessThanOrEqual(92);
    });

    it("handles content exactly at maxMessageLength", () => {
      const maxMessageLength = 100;
      const processor = new OutputProcessor({ maxOutputLines: 100, maxMessageLength });
      // wrapperOverhead = 8, maxContent = 92
      const input = "a".repeat(92);
      const result = processor.process(input);
      expect(result.length).toBe(92);
    });

    it("handles content just over maxMessageLength", () => {
      const maxMessageLength = 100;
      const processor = new OutputProcessor({ maxOutputLines: 100, maxMessageLength });
      const input = "a".repeat(100);
      const result = processor.process(input);
      // Should be truncated to last 92 chars (100 - 8 = 92)
      expect(result.length).toBe(92);
    });
  });

  describe("edge cases", () => {
    it("handles unicode content", () => {
      const processor = new OutputProcessor({ maxOutputLines: 100, maxMessageLength: 4000 });
      const input = "中文内容\n日本語\n한국어";
      const result = processor.process(input);
      expect(result).toContain("中文内容");
      expect(result).toContain("日本語");
      expect(result).toContain("한국어");
    });

    it("handles emoji in content", () => {
      const processor = new OutputProcessor({ maxOutputLines: 100, maxMessageLength: 4000 });
      const input = "Hello 👋\nEmoji 🎉 test";
      const result = processor.process(input);
      expect(result).toContain("👋");
      expect(result).toContain("🎉");
    });

    it("handles tabs and special whitespace", () => {
      const processor = new OutputProcessor({ maxOutputLines: 100, maxMessageLength: 4000 });
      const input = "line1\twith\ttabs\nline2\tmore";
      const result = processor.process(input);
      expect(result).toContain("\t");
    });

    it("handles CRLF line endings", () => {
      const processor = new OutputProcessor({ maxOutputLines: 100, maxMessageLength: 4000 });
      const input = "line1\r\nline2\r\nline3";
      const result = processor.process(input);
      expect(result).toContain("line1");
      expect(result).toContain("line2");
    });
  });
});
