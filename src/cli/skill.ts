/**
 * Explicitly install the Home Operator skill (`skills/tcb-home-operator/SKILL.md`)
 * into global Claude Code / Codex discovery. Managed install does not run this by
 * default; the isolated Home Operator workspace owns the default operator context.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  type AiToolClient,
  type AiToolInstallScope,
  HOME_OPERATOR_SKILL_NAME,
  homeOperatorSkillFiles,
  legacyGlobalHomeOperatorSkillFiles,
} from "../core/ai-tools/install-contract.js";

export const SKILL_NAME = HOME_OPERATOR_SKILL_NAME;
export type Tool = AiToolClient;
export type SkillScope = AiToolInstallScope;

/** Split a SKILL.md into its YAML frontmatter and the markdown body. */
export function splitFrontmatter(src: string): { frontmatter: string; body: string } {
  const m = src.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { frontmatter: "", body: src.trim() };
  return { frontmatter: m[1] as string, body: src.slice(m[0].length).trim() };
}

type Target = {
  tool: Tool;
  scope: SkillScope;
  path: string;
  root: string;
  frame: (src: string) => string;
};
type RemovableTarget = {
  tool: Tool;
  scope: SkillScope;
  path: string;
  root: string;
  legacy: boolean;
};

function withFrontmatterName(src: string, name: string): string {
  const { frontmatter, body } = splitFrontmatter(src);
  if (frontmatter.length === 0) return `---\nname: ${name}\n---\n\n${body}\n`;
  const next = frontmatter.match(/^name:\s*/m)
    ? frontmatter.replace(/^name:\s*.*/m, `name: ${name}`)
    : `name: ${name}\n${frontmatter}`;
  return `---\n${next}\n---\n\n${body}\n`;
}

/** Where the skill lands for each tool, and how its content is framed there. */
export function skillTargets(home: string = homedir(), scope: SkillScope = "global"): Target[] {
  const files = homeOperatorSkillFiles(home, scope);
  const claude = files.find((file) => file.client === "claude");
  const codex = files.find((file) => file.client === "codex");
  if (claude === undefined || codex === undefined) {
    throw new Error("home operator skill contract must declare Claude and Codex targets");
  }
  const claudeRoot = dirname(claude.path);
  const codexPath = codex.path;
  return [
    {
      tool: "claude",
      scope,
      // Claude Code reads the YAML frontmatter to index the skill.
      root: claudeRoot,
      path: join(claudeRoot, "SKILL.md"),
      frame: (src) => withFrontmatterName(src, SKILL_NAME),
    },
    {
      tool: "codex",
      scope,
      // Codex custom prompts are plain markdown invoked as /tcb-home-operator; the
      // YAML frontmatter would render as literal text, so drop it.
      root: codexPath,
      path: codexPath,
      frame: (src) => `${splitFrontmatter(src).body}\n`,
    },
  ];
}

export type InstallResult = { tool: Tool; scope: SkillScope; path: string };
export type SkillStatus = {
  tool: Tool;
  scope: SkillScope;
  path: string;
  installed: boolean;
  legacy: boolean;
};
export type UninstallResult = {
  tool: Tool;
  scope: SkillScope;
  path: string;
  removed: boolean;
  legacy: boolean;
};

function legacySkillTargets(home: string = homedir()): RemovableTarget[] {
  const files = legacyGlobalHomeOperatorSkillFiles(home);
  const claude = files.find((file) => file.client === "claude");
  const codex = files.find((file) => file.client === "codex");
  if (claude === undefined || codex === undefined) {
    throw new Error("legacy home operator skill contract must declare Claude and Codex targets");
  }
  const claudeRoot = dirname(claude.path);
  const codexPath = codex.path;
  return [
    {
      tool: "claude",
      scope: "global",
      root: claudeRoot,
      path: join(claudeRoot, "SKILL.md"),
      legacy: true,
    },
    {
      tool: "codex",
      scope: "global",
      root: codexPath,
      path: codexPath,
      legacy: true,
    },
  ];
}

function removableTargets(
  home: string = homedir(),
  only?: Tool[],
  scope: SkillScope = "global",
): RemovableTarget[] {
  const current = skillTargets(home, scope).map((target) => ({
    tool: target.tool,
    scope: target.scope,
    path: target.path,
    root: target.root,
    legacy: false,
  }));
  const legacy = scope === "global" ? legacySkillTargets(home) : [];
  return [...current, ...legacy].filter((target) => !only || only.includes(target.tool));
}

function removeTarget(target: RemovableTarget): boolean {
  const existed = existsSync(target.root) || existsSync(target.path);
  if (existed) rmSync(target.root, { recursive: true, force: true });
  return existed;
}

export function skillInstallStatus(opts: {
  home?: string | undefined;
  only?: Tool[] | undefined;
  scope?: SkillScope | undefined;
}): SkillStatus[] {
  return removableTargets(opts.home, opts.only, opts.scope).map((target) => ({
    tool: target.tool,
    scope: target.scope,
    path: target.path,
    installed: existsSync(target.path),
    legacy: target.legacy,
  }));
}

export function uninstallSkill(opts: {
  home?: string | undefined;
  only?: Tool[] | undefined;
  scope?: SkillScope | undefined;
  log?: ((msg: string) => void) | undefined;
}): UninstallResult[] {
  return removableTargets(opts.home, opts.only, opts.scope).map((target) => {
    const removed = removeTarget(target);
    opts.log?.(
      `${target.scope}/${target.tool}: ${target.path}${removed ? "" : " (not installed)"}`,
    );
    return {
      tool: target.tool,
      scope: target.scope,
      path: target.path,
      removed,
      legacy: target.legacy,
    };
  });
}

/** Copy the bundled SKILL.md into each selected tool's skill/prompt dir. */
export function installSkill(opts: {
  pkgRoot: string;
  home?: string | undefined;
  only?: Tool[] | undefined;
  scope?: SkillScope | undefined;
  cleanupLegacy?: boolean | undefined;
  log?: ((msg: string) => void) | undefined;
}): InstallResult[] {
  const src = readFileSync(join(opts.pkgRoot, "skills", SKILL_NAME, "SKILL.md"), "utf8");
  const scope = opts.scope ?? "global";
  if (scope === "global" && opts.cleanupLegacy !== false) {
    for (const target of legacySkillTargets(opts.home).filter(
      (target) => !opts.only || opts.only.includes(target.tool),
    )) {
      removeTarget(target);
    }
  }
  const targets = skillTargets(opts.home, scope).filter(
    (t) => !opts.only || opts.only.includes(t.tool),
  );
  const done: InstallResult[] = [];
  for (const t of targets) {
    mkdirSync(dirname(t.path), { recursive: true });
    writeFileSync(t.path, t.frame(src));
    opts.log?.(`${t.scope}/${t.tool}: ${t.path}`);
    done.push({ tool: t.tool, scope: t.scope, path: t.path });
  }
  return done;
}
