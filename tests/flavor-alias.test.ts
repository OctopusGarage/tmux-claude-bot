import { describe, expect, it } from "vitest";
import { parseClaudeFlavorAliases } from "../src/core/agents/claude/claude-flavor-alias.js";
import { type FlavorAlias, matchFlavorAlias } from "../src/core/agents/flavor-alias.js";

const HOME = "/home/u";

// Mirrors the real rc shape: several flavors share CLAUDE_CONFIG_DIR=~/.claude and
// differ only by ANTHROPIC_BASE_URL; tokens after the binary are flags.
const RC = `
# unrelated
alias ll="ls -la"
alias claude-yolo="claude --dangerously-skip-permissions"
alias claude-stella="CLAUDE_CONFIG_DIR=~/.claude-stella claude  --dangerously-skip-permissions"
alias claude-minmax="CLAUDE_CONFIG_DIR=~/.claude ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic ANTHROPIC_AUTH_TOKEN=sk-secret claude --dangerously-skip-permissions"
alias claude-ollama="CLAUDE_CONFIG_DIR=~/.claude ANTHROPIC_BASE_URL=http://192.168.3.16:4000 ANTHROPIC_AUTH_TOKEN=dummy claude --dangerously-skip-permissions"
alias claude-tmux="npx tsx ~/scripts/claude-tmux.ts"
`;

describe("parseClaudeFlavorAliases", () => {
  it("extracts claude launcher aliases with their config dir + base url", () => {
    const aliases = parseClaudeFlavorAliases(RC, HOME);
    const byName = Object.fromEntries(aliases.map((a) => [a.name, a]));
    expect(byName["claude-yolo"]).toEqual({
      name: "claude-yolo",
      configDir: null,
      baseUrl: null,
    });
    expect(byName["claude-stella"]).toEqual({
      name: "claude-stella",
      configDir: "/home/u/.claude-stella",
      baseUrl: null,
    });
    expect(byName["claude-minmax"]?.baseUrl).toBe("https://api.minimaxi.com/anthropic");
    expect(byName["claude-minmax"]?.configDir).toBe("/home/u/.claude");
  });

  it("ignores aliases whose binary isn't claude (e.g. claude-tmux)", () => {
    const names = parseClaudeFlavorAliases(RC, HOME).map((a) => a.name);
    expect(names).not.toContain("claude-tmux");
  });

  it("does not leak the secret token into the parsed signature", () => {
    const minmax = parseClaudeFlavorAliases(RC, HOME).find((a) => a.name === "claude-minmax");
    expect(JSON.stringify(minmax)).not.toContain("sk-secret");
  });
});

describe("matchFlavorAlias", () => {
  const aliases = parseClaudeFlavorAliases(RC, HOME);

  it("matches a base-url flavor sharing the default config dir", () => {
    expect(
      matchFlavorAlias(
        aliases,
        { configRoot: "/home/u/.claude", baseUrl: "https://api.minimaxi.com/anthropic" },
        HOME,
      ),
    ).toBe("claude-minmax");
  });

  it("matches the default flavor (no base url, default config dir)", () => {
    expect(matchFlavorAlias(aliases, { configRoot: "/home/u/.claude", baseUrl: null }, HOME)).toBe(
      "claude-yolo",
    );
  });

  it("matches a flavor by its distinct config dir", () => {
    expect(
      matchFlavorAlias(aliases, { configRoot: "/home/u/.claude-stella", baseUrl: null }, HOME),
    ).toBe("claude-stella");
  });

  it("matches ollama by its local base url", () => {
    expect(
      matchFlavorAlias(
        aliases,
        { configRoot: "/home/u/.claude", baseUrl: "http://192.168.3.16:4000" },
        HOME,
      ),
    ).toBe("claude-ollama");
  });

  it("returns null when no alias matches the signature", () => {
    expect(
      matchFlavorAlias(
        aliases,
        { configRoot: "/home/u/.claude", baseUrl: "https://unknown.example" },
        HOME,
      ),
    ).toBeNull();
  });

  it("returns null when the match is ambiguous", () => {
    const dupes: FlavorAlias[] = [
      { name: "claude-a", configDir: null, baseUrl: null },
      { name: "claude-b", configDir: null, baseUrl: null },
    ];
    expect(
      matchFlavorAlias(dupes, { configRoot: "/home/u/.claude", baseUrl: null }, HOME),
    ).toBeNull();
  });

  it("treats an empty configRoot as the default ~/.claude", () => {
    // Line 74: `target.configRoot || defaultConfig` — an empty string falls back
    // to the home default, so the default flavor (claude-yolo) still matches.
    expect(matchFlavorAlias(aliases, { configRoot: "", baseUrl: null }, HOME)).toBe("claude-yolo");
  });

  it("returns null on an empty alias list", () => {
    expect(matchFlavorAlias([], { configRoot: "/home/u/.claude", baseUrl: null }, HOME)).toBeNull();
  });
});

describe("parseClaudeFlavorAliases edge cases", () => {
  it("returns an empty list when there are no aliases at all", () => {
    expect(parseClaudeFlavorAliases("# just a comment\nexport FOO=bar\n", HOME)).toEqual([]);
  });

  it("expands a bare ~ CLAUDE_CONFIG_DIR to home itself", () => {
    // Line 16: expandHome's `p === "~"` branch (no trailing slash).
    const aliases = parseClaudeFlavorAliases('alias claude-h="CLAUDE_CONFIG_DIR=~ claude"', HOME);
    expect(aliases[0]?.configDir).toBe(HOME);
  });

  it("keeps an absolute (non-~) CLAUDE_CONFIG_DIR verbatim", () => {
    // expandHome's pass-through branch — no ~ prefix.
    const aliases = parseClaudeFlavorAliases(
      'alias claude-abs="CLAUDE_CONFIG_DIR=/etc/claude claude"',
      HOME,
    );
    expect(aliases[0]?.configDir).toBe("/etc/claude");
  });

  it("ignores an alias with an empty body (no binary token)", () => {
    // m[3] is "" → split yields [""], no assignment, binary stays "" → dropped.
    expect(parseClaudeFlavorAliases('alias claude-empty=""', HOME)).toEqual([]);
  });

  it("records an env assignment with an empty value", () => {
    // assign[2] === "" → env key kept with empty string; binary is the next token.
    const aliases = parseClaudeFlavorAliases('alias claude-e="ANTHROPIC_BASE_URL= claude"', HOME);
    expect(aliases[0]).toEqual({ name: "claude-e", configDir: null, baseUrl: "" });
  });

  it("parses multiple env assignments before the binary and stops at the binary", () => {
    const aliases = parseClaudeFlavorAliases(
      'alias claude-multi="CLAUDE_CONFIG_DIR=~/.c ANTHROPIC_BASE_URL=http://x claude --foo BAR=baz"',
      HOME,
    );
    // BAR=baz comes after `claude`, so it must NOT become an env assignment.
    expect(aliases[0]).toEqual({
      name: "claude-multi",
      configDir: "/home/u/.c",
      baseUrl: "http://x",
    });
  });

  it("supports single-quoted alias bodies", () => {
    const aliases = parseClaudeFlavorAliases(
      "alias claude-sq='ANTHROPIC_BASE_URL=http://q claude'",
      HOME,
    );
    expect(aliases[0]).toEqual({ name: "claude-sq", configDir: null, baseUrl: "http://q" });
  });
});
