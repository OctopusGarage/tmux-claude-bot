import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  installSkill,
  SKILL_NAME,
  skillInstallStatus,
  skillTargets,
  splitFrontmatter,
  uninstallSkill,
} from "../../src/cli/skill.js";

// The bundled Home Operator skill ships at <repo>/skills/tcb-home-operator/SKILL.md.
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
    expect(SKILL_NAME).toBe("tcb-home-operator");
    expect(claude.path).toBe("/home/u/.claude/skills/tcb-home-operator/SKILL.md");
    expect(codex.path).toBe("/home/u/.codex/prompts/tcb-home-operator.md");
    const src = "---\nname: tmux-claude-bot\n---\n\n# Body\n";
    expect(claude.frame(src)).toContain("name: tcb-home-operator");
    expect(codex.frame(src)).toBe("# Body\n"); // frontmatter stripped
  });

  it("labels operator-home targets separately from global targets", () => {
    expect(skillTargets("/operator/home", "operator-home")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tool: "claude",
          scope: "operator-home",
          path: "/operator/home/.claude/skills/tcb-home-operator/SKILL.md",
        }),
        expect.objectContaining({
          tool: "codex",
          scope: "operator-home",
          path: "/operator/home/.codex/prompts/tcb-home-operator.md",
        }),
      ]),
    );
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
    const done = installSkill({ pkgRoot: PKG_ROOT, home, scope: "operator-home" });
    expect(done.map((d) => `${d.scope}/${d.tool}`).sort()).toEqual([
      "operator-home/claude",
      "operator-home/codex",
    ]);
    const claude = readFileSync(join(home, ".claude/skills/tcb-home-operator/SKILL.md"), "utf8");
    const codex = readFileSync(join(home, ".codex/prompts/tcb-home-operator.md"), "utf8");
    expect(claude).toMatch(/^---\nname: tcb-home-operator/); // Claude keeps frontmatter
    expect(codex).not.toMatch(/^---/); // Codex prompt has none
    expect(codex).toContain("tcb send"); // the operating instructions survive
  });

  it("honours an `only` filter", () => {
    const done = installSkill({ pkgRoot: PKG_ROOT, home, only: ["codex"] });
    expect(done.map((d) => d.tool)).toEqual(["codex"]);
  });

  it("removes legacy global skill names when installing the canonical skill", () => {
    const legacyClaudeDir = join(home, ".claude/skills/tmux-claude-bot");
    const legacyCodexPrompt = join(home, ".codex/prompts/tmux-claude-bot.md");
    mkdirSync(legacyClaudeDir, { recursive: true });
    mkdirSync(join(home, ".codex/prompts"), { recursive: true });
    writeFileSync(join(legacyClaudeDir, "SKILL.md"), "legacy", { flag: "w" });
    writeFileSync(legacyCodexPrompt, "legacy", { flag: "w" });

    installSkill({ pkgRoot: PKG_ROOT, home, scope: "global" });

    expect(existsSync(legacyClaudeDir)).toBe(false);
    expect(existsSync(legacyCodexPrompt)).toBe(false);
    expect(existsSync(join(home, ".claude/skills/tcb-home-operator/SKILL.md"))).toBe(true);
    expect(existsSync(join(home, ".codex/prompts/tcb-home-operator.md"))).toBe(true);
  });

  it("reports and uninstalls current plus legacy global skill files", () => {
    installSkill({ pkgRoot: PKG_ROOT, home, scope: "global" });
    mkdirSync(join(home, ".codex/prompts"), { recursive: true });
    writeFileSync(join(home, ".codex/prompts/tmux-claude-bot.md"), "legacy");

    expect(skillInstallStatus({ home }).filter((item) => item.installed)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tool: "claude", legacy: false }),
        expect.objectContaining({ tool: "codex", legacy: false }),
        expect.objectContaining({ tool: "codex", legacy: true }),
      ]),
    );

    const result = uninstallSkill({ home });

    expect(result.filter((item) => item.removed).length).toBe(3);
    expect(existsSync(join(home, ".claude/skills/tcb-home-operator"))).toBe(false);
    expect(existsSync(join(home, ".codex/prompts/tcb-home-operator.md"))).toBe(false);
    expect(existsSync(join(home, ".codex/prompts/tmux-claude-bot.md"))).toBe(false);
  });

  it("keeps operator-home uninstall scoped away from global legacy files", () => {
    installSkill({ pkgRoot: PKG_ROOT, home, scope: "operator-home" });
    mkdirSync(join(home, ".codex/prompts"), { recursive: true });
    writeFileSync(join(home, ".codex/prompts/tmux-claude-bot.md"), "legacy");

    const result = uninstallSkill({ home, scope: "operator-home" });

    expect(result.filter((item) => item.removed).length).toBe(2);
    expect(existsSync(join(home, ".codex/prompts/tmux-claude-bot.md"))).toBe(true);
  });
});
