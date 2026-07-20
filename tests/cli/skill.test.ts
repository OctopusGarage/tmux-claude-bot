import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installSkill, skillTargets, splitFrontmatter } from "../../src/cli/skill.js";

// The bundled skill ships at <repo>/skills/tmux-claude-bot/SKILL.md; PKG_ROOT is
// the repo root in dev and the install dir in prod (rsync -a copies skills/).
const PKG_ROOT = join(__dirname, "..", "..");

describe("splitFrontmatter", () => {
  it("separates YAML frontmatter from the body", () => {
    const { frontmatter, body } = splitFrontmatter("---\nname: x\n---\n\n# Title\n\nbody\n");
    expect(frontmatter).toBe("name: x");
    expect(body).toBe("# Title\n\nbody");
  });

  it("returns the whole text as body when there is no frontmatter", () => {
    expect(splitFrontmatter("# Title\nbody")).toEqual({ frontmatter: "", body: "# Title\nbody" });
  });
});

describe("skillTargets", () => {
  it("ships the Claude skill with frontmatter and the Codex prompt without it", () => {
    const targets = skillTargets("/home/u");
    const claude = targets.find((t) => t.tool === "claude");
    const codex = targets.find((t) => t.tool === "codex");
    expect(claude).toBeDefined();
    expect(codex).toBeDefined();
    if (claude === undefined || codex === undefined) {
      throw new Error("expected both Claude and Codex skill targets");
    }
    expect(claude.tool).toBe("claude");
    expect(claude.path).toBe("/home/u/.claude/skills/tmux-claude-bot/SKILL.md");
    expect(codex.path).toBe("/home/u/.codex/prompts/tmux-claude-bot.md");
    const src = "---\nname: tmux-claude-bot\n---\n\n# Body\n";
    expect(claude.frame(src)).toContain("name: tmux-claude-bot"); // verbatim
    expect(codex.frame(src)).toBe("# Body\n"); // frontmatter stripped
  });
});

describe("installSkill", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "tcb-skill-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("writes both tools' files from the bundled SKILL.md", () => {
    const done = installSkill({ pkgRoot: PKG_ROOT, home });
    expect(done.map((d) => d.tool).sort()).toEqual(["claude", "codex"]);
    const claude = readFileSync(join(home, ".claude/skills/tmux-claude-bot/SKILL.md"), "utf8");
    const codex = readFileSync(join(home, ".codex/prompts/tmux-claude-bot.md"), "utf8");
    expect(claude).toMatch(/^---\nname: tmux-claude-bot/); // Claude keeps frontmatter
    expect(codex).not.toMatch(/^---/); // Codex prompt has none
    expect(codex).toContain("tcb send"); // the operating instructions survive
  });

  it("honours an `only` filter", () => {
    const done = installSkill({ pkgRoot: PKG_ROOT, home, only: ["codex"] });
    expect(done.map((d) => d.tool)).toEqual(["codex"]);
  });
});
