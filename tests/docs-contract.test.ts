import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { BOT_COMMANDS } from "../src/core/command/action-registry.js";
import { envSchema } from "../src/shared/config.js";

/**
 * Docs contract: user-visible docs must track the live runtime surfaces.
 * Derived from source (BOT_COMMANDS, envSchema) so adding a command or a
 * config key without documenting it fails CI — instead of the docs silently
 * rotting (modeled on lark-coding-agent-bridge's readme-contract test).
 */

const root = path.resolve(__dirname, "..");
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), "utf8");
const readJson = <T>(rel: string): T => JSON.parse(read(rel)) as T;
const walkFiles = (rel: string): string[] => {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(rel, entry.name);
    if (entry.isDirectory()) return walkFiles(child);
    return entry.isFile() ? [child] : [];
  });
};

describe("docs contract", () => {
  it("docs/commands.md documents every Telegram menu command", () => {
    const doc = read("docs/commands.md");
    for (const { command } of BOT_COMMANDS) {
      expect(doc, `missing \`${command}\` in docs/commands.md`).toContain(`\`${command}\``);
    }
  });

  it(".env.example documents every supported config key", () => {
    // Legacy aliases are read as fallbacks but intentionally undocumented.
    const LEGACY = new Set([
      "BOT_TOKEN",
      "ALLOWED_USER_IDS",
      "HTTP_PROXY",
      "VOICE_TRANSLATE_MODE",
      "VOICE_TRANSLATE_FROM",
      "VOICE_TRANSLATE_TO",
      "VOICE_TRANSLATE_TIMEOUT_MS",
      "TELEGRAM_VOICE_TRANSLATE_MODE",
      "TELEGRAM_VOICE_TRANSLATE_FROM",
      "TELEGRAM_VOICE_TRANSLATE_TO",
      "LARK_VOICE_TRANSLATE_MODE",
      "LARK_VOICE_TRANSLATE_FROM",
      "LARK_VOICE_TRANSLATE_TO",
    ]);
    const example = read(".env.example");
    for (const key of Object.keys(envSchema.shape)) {
      if (LEGACY.has(key)) continue;
      expect(example, `missing ${key} in .env.example`).toMatch(new RegExp(`^${key}=`, "m"));
    }
  });

  it("documents the AI capability boundary and keeps direct model eval scripts out", () => {
    const manual = read("docs/manual.md");
    const projectRules = read("CLAUDE.md");
    const agentRules = read("AGENTS.md");

    expect(projectRules).toContain(
      "Do not add source, scripts, smoke tests, docs, or `.env.example` entries",
    );
    expect(projectRules).toContain(
      "call OpenAI, Anthropic, Gemini/Google, or other LLM/model HTTP APIs directly",
    );
    expect(projectRules).toContain("AI work is active-agent-only");
    expect(projectRules).toContain("Do not ship helper scripts that instantiate model SDK clients");
    expect(projectRules).toContain("GoogleGenerativeAI");
    expect(projectRules).toContain("adapter that talks to the running bot/agent control surface");
    expect(projectRules).toContain("reuse the active Claude Code / Codex session");
    expect(projectRules).toContain(
      "`eval.command`, assessment/execution commands, smoke helpers, and scripts are",
    );
    expect(projectRules).toContain("command-contract boundaries, not model-integration points");
    expect(projectRules).toContain("This is not a model-client application");
    expect(projectRules).toContain("Historical names such as `aiEval`");
    expect(projectRules).toContain("do not authorize a new script, helper, or module");
    expect(projectRules).toContain("architectural regression");
    expect(projectRules).toContain("stop and redesign");
    expect(agentRules).toContain("Do not implement bot-owned AI behavior");
    expect(agentRules).toContain("AI work is active-agent-only");
    expect(agentRules).toContain("model-provider APIs directly");
    expect(agentRules).toContain("This project is not a model-client application");
    expect(agentRules).toContain("Historical names such as `aiEval`");
    expect(agentRules).toContain("not permission");
    expect(agentRules).toContain("redesign it around the current");
    expect(agentRules).toContain("currently running Claude Code / Codex agent sessions");
    expect(agentRules).toContain(
      "Do not add OpenAI/Anthropic/Gemini SDK clients, AI SDK provider packages",
    );
    expect(agentRules).toContain("reuse the active Claude Code / Codex session");
    expect(agentRules).toContain("model-integration points");
    expect(manual).not.toContain("external AI judges can emit");
  });

  it("documents active goal discipline for broad autonomous work", () => {
    const projectRules = read("CLAUDE.md");
    const agentRules = read("AGENTS.md");

    expect(projectRules).toContain("## Active Goal Discipline");
    expect(projectRules).toContain(
      "Do not turn a broad active goal into an endless opportunistic sweep",
    );
    expect(projectRules).toContain("work in explicit, reviewable slices");
    expect(projectRules).toContain("stop after each slice");
    expect(projectRules).toContain("Clean up or revert opportunistic changes");
    expect(agentRules).toContain("Active Goal Discipline");
    expect(agentRules).toContain("explicit, reviewable slices");
  });

  it("keeps project-owned AI behavior off direct model provider clients", () => {
    const forbidden = [
      /from\s+["']openai["']/,
      /require\(["']openai["']\)/,
      /new\s+OpenAI\s*\(/,
      /responses\.create\s*\(/,
      /chat\.completions\.create\s*\(/,
      /@anthropic-ai\/sdk/,
      /from\s+["']@anthropic-ai\/sdk["']/,
      /new\s+Anthropic\s*\(/,
      /anthropic\.messages\.create\s*\(/,
      /@google\/(?:generative-ai|genai)/,
      /from\s+["']@google\/(?:generative-ai|genai)["']/,
      /new\s+(?:GoogleGenerativeAI|GoogleGenAI)\s*\(/,
      /@ai-sdk\/(?:openai|anthropic|google)/,
      /https?:\/\/api\.(?:openai|anthropic)\.com\/v1\//,
      /https?:\/\/api\.(?:deepseek|mistral)\.com\/v1\//,
      /https?:\/\/generativelanguage\.googleapis\.com\/v1/,
      /\/v1\/(?:responses|messages|chat\/completions)/,
    ];
    const keyDocsAndConfig = [
      ".env.example",
      "AGENTS.md",
      "CLAUDE.md",
      "README.md",
      "docs/manual.md",
      "package.json",
    ];
    const checked = [
      ...walkFiles("src"),
      ...walkFiles("scripts"),
      ...walkFiles("docs/examples"),
      ...keyDocsAndConfig,
    ];
    for (const file of checked) {
      const content = read(file);
      for (const pattern of forbidden) {
        expect(content, `${file} must not contain ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it("keeps direct model-provider SDK packages out of project dependencies", () => {
    const forbiddenPackages = [
      "openai",
      "@anthropic-ai/sdk",
      "@ai-sdk/openai",
      "@ai-sdk/anthropic",
      "@ai-sdk/google",
      "@google/generative-ai",
      "@google/genai",
      "@mistralai/mistralai",
      "groq-sdk",
      "cohere-ai",
      "replicate",
    ];
    const packageJson = readJson<{
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      overrides?: Record<string, string>;
    }>("package.json");
    const declared = new Set([
      ...Object.keys(packageJson.dependencies ?? {}),
      ...Object.keys(packageJson.devDependencies ?? {}),
      ...Object.keys(packageJson.optionalDependencies ?? {}),
      ...Object.keys(packageJson.peerDependencies ?? {}),
      ...Object.keys(packageJson.overrides ?? {}),
    ]);
    for (const pkg of forbiddenPackages) {
      expect(declared, `${pkg} must not be declared as a project dependency`).not.toContain(pkg);
    }

    const lock = readJson<{
      packages?: Record<string, unknown>;
      dependencies?: Record<string, unknown>;
    }>("package-lock.json");
    const locked = new Set([
      ...Object.keys(lock.dependencies ?? {}),
      ...Object.keys(lock.packages ?? {}).map((pkgPath) => pkgPath.replace(/^node_modules\//, "")),
    ]);
    for (const pkg of forbiddenPackages) {
      expect(locked, `${pkg} must not be present in package-lock.json`).not.toContain(pkg);
    }
  });

  it("docs/manual.md documents every CLI command (tcb …)", () => {
    // Source-derived: a `.command("x")` added to the CLI without a mention in the
    // manual fails here, keeping the user manual in sync with the runtime surface.
    const cli = read("src/cli.ts");
    // Capture just the command NAME (the token before any `<arg>` / space).
    const commands = new Set(
      [...cli.matchAll(/\.command\("([^"\s<]+)/g)].map((m) => m[1] as string),
    );
    const manual = read("docs/manual.md");
    for (const cmd of commands) {
      expect(manual, `missing \`${cmd}\` in docs/manual.md`).toMatch(new RegExp(`\\b${cmd}\\b`));
    }
  });

  it("docs/manual.md links the detailed references", () => {
    const manual = read("docs/manual.md");
    expect(manual).toContain("commands.md"); // full chat-command table
    expect(manual).toContain("tui.md"); // terminal-UI guide
  });

  it("llms.txt points agents and documentation indexers at the primary docs", () => {
    const llms = read("llms.txt");
    for (const doc of [
      "docs/manual.md",
      "docs/commands.md",
      "docs/tui.md",
      "docs/agents/usage-guide.md",
      "docs/TESTING.md",
    ]) {
      expect(llms, `missing ${doc} in llms.txt`).toContain(doc);
    }
  });

  it("context7.json narrows Context7 parsing to maintained docs", () => {
    const config = JSON.parse(read("context7.json")) as {
      projectTitle?: string;
      folders?: string[];
      excludeFolders?: string[];
      rules?: string[];
    };

    expect(config.projectTitle).toBe("tmux-claude-bot");
    expect(config.folders).toEqual(expect.arrayContaining(["docs", "skills"]));
    expect(config.excludeFolders).toEqual(
      expect.arrayContaining(["docs/superpowers", "docs/research"]),
    );
    expect(config.rules?.join("\n")).toContain("docs/agents/usage-guide.md");
  });

  it("README documents the operational entry points", () => {
    const readme = read("README.md");
    for (const phrase of [
      "npm run setup:lark",
      "npm run doctor",
      "npm run service:install",
      "npm run service:uninstall",
    ]) {
      expect(readme, `missing "${phrase}" in README.md`).toContain(phrase);
    }
  });
});
