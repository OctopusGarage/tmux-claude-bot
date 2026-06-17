import { describe, expect, it } from "vitest";
import { parseCodexFlavorAliases } from "../src/core/agents/codex/codex-flavor-alias.js";

const HOME = "/home/user";

describe("parseCodexFlavorAliases", () => {
  it("parses CODEX_HOME into configDir and expands ~", () => {
    const rc = `alias codex-stella="CODEX_HOME=~/.codex-stella codex --yolo"`;
    expect(parseCodexFlavorAliases(rc, HOME)).toEqual([
      { name: "codex-stella", configDir: "/home/user/.codex-stella", baseUrl: null },
    ]);
  });
  it("parses an absolute CODEX_HOME unchanged", () => {
    const rc = `alias codex-farmer="CODEX_HOME=/opt/codex-farmer codex --yolo"`;
    expect(parseCodexFlavorAliases(rc, HOME)[0]?.configDir).toBe("/opt/codex-farmer");
  });
  it("yields null configDir when CODEX_HOME is unset", () => {
    const rc = `alias codex-bare="codex --yolo"`;
    expect(parseCodexFlavorAliases(rc, HOME)[0]).toEqual({
      name: "codex-bare",
      configDir: null,
      baseUrl: null,
    });
  });
  it("ignores aliases whose binary is not codex", () => {
    const rc = `alias codex-helper="npx tsx scripts/codex-helper.ts"`;
    expect(parseCodexFlavorAliases(rc, HOME)).toEqual([]);
  });
  it("ignores claude aliases entirely", () => {
    const rc = `alias claude-stella="CLAUDE_CONFIG_DIR=~/.claude-stella claude"`;
    expect(parseCodexFlavorAliases(rc, HOME)).toEqual([]);
  });
  it("parses several codex aliases", () => {
    const rc = [
      `alias codex-stella="CODEX_HOME=~/.codex-stella-team codex --yolo"`,
      `alias codex-farmer="CODEX_HOME=~/.codex-code-farmer codex --yolo"`,
    ].join("\n");
    expect(parseCodexFlavorAliases(rc, HOME).map((a) => a.name)).toEqual([
      "codex-stella",
      "codex-farmer",
    ]);
  });
});
