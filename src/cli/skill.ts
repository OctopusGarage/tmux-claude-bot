/**
 * Install the AI operating skill (`skills/tmux-claude-bot/SKILL.md`) into the
 * local agent tools so an assistant in Claude Code / Codex can drive the bot via
 * the `tcb` CLI in natural language. Shipped with the package and run by
 * install.sh (opt out with TCB_SKIP_SKILL=1) or on demand via `tcb skill install`.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const SKILL_NAME = "tmux-claude-bot";
export type Tool = "claude" | "codex";

/** Split a SKILL.md into its YAML frontmatter and the markdown body. */
export function splitFrontmatter(src: string): { frontmatter: string; body: string } {
  const m = src.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { frontmatter: "", body: src.trim() };
  return { frontmatter: m[1] as string, body: src.slice(m[0].length).trim() };
}

type Target = { tool: Tool; path: string; frame: (src: string) => string };

/** Where the skill lands for each tool, and how its content is framed there. */
export function skillTargets(home: string = homedir()): Target[] {
  return [
    {
      tool: "claude",
      // Claude Code reads the YAML frontmatter to index the skill — ship verbatim.
      path: join(home, ".claude", "skills", SKILL_NAME, "SKILL.md"),
      frame: (src) => `${src.trimEnd()}\n`,
    },
    {
      tool: "codex",
      // Codex custom prompts are plain markdown invoked as /tmux-claude-bot; the
      // YAML frontmatter would render as literal text, so drop it.
      path: join(home, ".codex", "prompts", `${SKILL_NAME}.md`),
      frame: (src) => `${splitFrontmatter(src).body}\n`,
    },
  ];
}

export type InstallResult = { tool: Tool; path: string };

/** Copy the bundled SKILL.md into each selected tool's skill/prompt dir. */
export function installSkill(opts: {
  pkgRoot: string;
  home?: string | undefined;
  only?: Tool[] | undefined;
  log?: ((msg: string) => void) | undefined;
}): InstallResult[] {
  const src = readFileSync(join(opts.pkgRoot, "skills", SKILL_NAME, "SKILL.md"), "utf8");
  const targets = skillTargets(opts.home).filter((t) => !opts.only || opts.only.includes(t.tool));
  const done: InstallResult[] = [];
  for (const t of targets) {
    mkdirSync(dirname(t.path), { recursive: true });
    writeFileSync(t.path, t.frame(src));
    opts.log?.(`${t.tool}: ${t.path}`);
    done.push({ tool: t.tool, path: t.path });
  }
  return done;
}
