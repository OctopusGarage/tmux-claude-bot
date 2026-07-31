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

  it("docs/cli-reference.md documents every CLI command and long option (tcb …)", () => {
    // Source-derived: a `.command("x")` added to the CLI without a mention in the
    // CLI reference fails here, keeping docs in sync with the runtime surface.
    const cli = read("src/cli.ts");
    // Capture just the command NAME (the token before any `<arg>` / space).
    const commands = new Set(
      [...cli.matchAll(/\.command\("([^"\s<]+)/g)].map((m) => m[1] as string),
    );
    const reference = read("docs/cli-reference.md");
    for (const cmd of commands) {
      expect(reference, `missing \`${cmd}\` in docs/cli-reference.md`).toMatch(
        new RegExp(`\\b${cmd}\\b`),
      );
    }

    const longOptions = new Set(
      [...cli.matchAll(/\.(?:requiredOption|option)\("([^"]+)"/g)]
        .flatMap((m) => [...(m[1] ?? "").matchAll(/--[a-z0-9-]+/g)])
        .map((m) => m[0]),
    );
    for (const option of longOptions) {
      expect(reference, `missing \`${option}\` in docs/cli-reference.md`).toContain(option);
    }
  });

  it("docs/manual.md links the detailed references", () => {
    const manual = read("docs/manual.md");
    expect(manual).toContain("commands.md"); // full chat-command table
    expect(manual).toContain("cli-reference.md"); // full CLI command/option table
    expect(manual).toContain("tui.md"); // terminal-UI guide
  });

  it("llms.txt points agents and documentation indexers at the primary docs", () => {
    const llms = read("llms.txt");
    for (const doc of [
      "docs/README.md",
      "docs/manual.md",
      "docs/cli-reference.md",
      "docs/commands.md",
      "docs/tui.md",
      "docs/agents/usage-guide.md",
      "docs/automation-alignment.md",
      "docs/automation-capability-matrix.md",
      "docs/agent-maintenance-guidelines.md",
      "docs/intelligent-automation.md",
      "docs/intelligent-automation-architecture.md",
      "docs/intelligent-automation-ascii-architecture.md",
      "docs/TESTING.md",
    ]) {
      expect(llms, `missing ${doc} in llms.txt`).toContain(doc);
    }
  });

  it("keeps maintained docs in English", () => {
    for (const file of walkFiles("docs")) {
      expect(read(file), `${file} should be written in English`).not.toMatch(/\p{Script=Han}/u);
    }
  });

  it("keeps Autopilot docs on current supervisor-backed delegation semantics", () => {
    const manual = read("docs/manual.md");
    const cliReference = read("docs/cli-reference.md");
    const usageGuide = read("docs/agents/usage-guide.md");
    const skill = read("skills/tmux-claude-bot/SKILL.md");
    const iconography = read("docs/domain/iconography.md");
    const icons = read("src/shared/ui/icons.ts");
    const operatorHome = read("src/core/projects/operator-home.ts");

    for (const doc of [manual, cliReference, usageGuide, skill]) {
      expect(doc).toContain("tcb autopilot <project>");
    }
    expect(operatorHome).toContain("tcb autopilot <name> [requirement]");
    expect(manual).not.toContain("autopilot status across all sessions");
    expect(iconography).toContain("Supervisor-backed Autopilot delegation");
    expect(iconography).not.toContain("hands-free agent loop");
    expect(icons).toContain("supervisor-backed Autopilot delegation");
    expect(icons).not.toContain("hands-free agent loop");
  });

  it("documents cross-surface automation alignment governance", () => {
    const alignment = read("docs/automation-alignment.md");
    const matrix = read("docs/automation-capability-matrix.md");
    const maintenance = read("docs/agent-maintenance-guidelines.md");
    const architecture = read("docs/intelligent-automation-architecture.md");
    const projectRules = read("CLAUDE.md");
    const agentRules = read("AGENTS.md");

    for (const phrase of [
      "Rule Placement",
      "Alignment Matrix",
      "Drift Audit Checklist",
      "Known Alignment Gaps To Investigate",
      "Memory and instruction files are context, not a policy engine",
      "enforced, add a schema check, contract test, hook, runtime gate",
      "CI/local",
      "Telegram and Feishu/Lark capability parity",
      "Lark project-bound group routing",
      "command-local `GH_TOKEN` from `gh auth token --user`",
      "Agent-backed/control-surface path only",
      "docs/automation-capability-matrix.md",
    ]) {
      expect(alignment, `missing alignment guidance: ${phrase}`).toContain(phrase);
    }

    for (const phrase of [
      "Automation Capability Matrix",
      "CLI",
      "Telegram",
      "Feishu/Lark",
      "TUI",
      "Home/operator skill",
      "Autopilot active delegation",
      "Opportunity Discovery suggestions",
      "Daily Task Audit",
      "Repository-wide PR review",
      "No keep-alive, goal-cycle, enable/disable, or old human gate UI",
    ]) {
      expect(matrix, `missing capability matrix guidance: ${phrase}`).toContain(phrase);
    }

    expect(projectRules).toContain("docs/automation-alignment.md");
    expect(projectRules).toContain("Alignment Governance");
    expect(projectRules).toContain("docs/agent-maintenance-guidelines.md");
    expect(agentRules).toContain("docs/automation-alignment.md");
    expect(agentRules).toContain("Alignment Governance");
    expect(agentRules).toContain("docs/agent-maintenance-guidelines.md");

    for (const phrase of [
      "Service And Runtime Management",
      "Supervisor And System Gates",
      "Conflict And Isolation Rules",
      "Notifications",
      "GitHub Automation",
      "Documentation And Skills",
    ]) {
      expect(maintenance, `missing maintenance guidance: ${phrase}`).toContain(phrase);
    }

    for (const phrase of [
      "System Role",
      "Session Model",
      "Core Execution Pipeline",
      "Task Families",
      "Isolation And Conflict Control",
      "Evidence And Acceptance",
      "Notification Model",
      "GitHub Identity",
      "AI Boundary",
      "Drift Risks And Controls",
      "Prevent",
      "Detect",
      "Recover",
    ]) {
      expect(architecture, `missing architecture guidance: ${phrase}`).toContain(phrase);
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
    expect(config.excludeFolders).toEqual(expect.arrayContaining(["docs/future"]));
    expect(config.excludeFolders).not.toContain("docs/superpowers");
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
