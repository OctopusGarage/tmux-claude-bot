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

describe("docs contract", () => {
  it("docs/commands.md documents every Telegram menu command", () => {
    const doc = read("docs/commands.md");
    for (const { command } of BOT_COMMANDS) {
      expect(doc, `missing \`${command}\` in docs/commands.md`).toContain(`\`${command}\``);
    }
  });

  it(".env.example documents every supported config key", () => {
    // Legacy aliases are read as fallbacks but intentionally undocumented.
    const LEGACY = new Set(["BOT_TOKEN", "ALLOWED_USER_IDS", "HTTP_PROXY"]);
    const example = read(".env.example");
    for (const key of Object.keys(envSchema.shape)) {
      if (LEGACY.has(key)) continue;
      expect(example, `missing ${key} in .env.example`).toMatch(new RegExp(`^${key}=`, "m"));
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
