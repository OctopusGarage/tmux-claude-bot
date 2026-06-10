#!/usr/bin/env npx tsx

/**
 * claude-tmux - Unified Claude + tmux session manager
 *
 * Run this script to attach to or create a tmux session for the current project.
 * The session is named after the absolute path of the current directory.
 *
 * Usage: npx tsx src/scripts/claude-tmux.ts
 *
 * Add to ~/.zshrc:
 *   alias claude="npx tsx ~/programming/OctopusGarage/tmux-claude-bot/src/scripts/claude-tmux.ts"
 */

import { execFile } from "node:child_process";
import * as nodePath from "node:path";
import { promisify } from "node:util";
import { config as loadEnv } from "dotenv";
import { createConfigResolver, createExecProbe } from "../core/claude-config-resolver.js";
import { DEFAULT_CONFIG_ROOT } from "../core/history.js";
import { sessionNameFromPath, setPathForSession } from "../core/sessionPathMap.js";
import { TmuxBridge } from "../core/tmux.js";
import { claudeBinFromStartCommand, loadScriptConfig } from "../shared/config.js";
import { sleep } from "../shared/utils/sleep.js";

const execFileAsync = promisify(execFile);

// Load .env from the project root (two levels above this script)
const projectRoot = nodePath.resolve(
  nodePath.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
loadEnv({ override: true, path: nodePath.join(projectRoot, ".env") });

const config = loadScriptConfig();

// Same process-based detection the bot uses (a claude process in the pane's
// process tree), not screen scraping.
const resolver = createConfigResolver(createExecProbe(), {
  defaultRoot: DEFAULT_CONFIG_ROOT,
  claudeBin: claudeBinFromStartCommand(config.claudeStartCommand),
  ttlMs: 60_000,
});

async function startClaude(bridge: TmuxBridge, sessionName: string): Promise<void> {
  const alreadyRunning = await resolver.isClaudeRunning(sessionName);
  if (alreadyRunning) {
    console.log("✅ Claude is already running");
    return;
  }
  await bridge.sendKeys(config.claudeStartCommand, sessionName);
  console.log("🚀 Claude started");
}

async function main() {
  const cwd = process.cwd();
  const sessionName = sessionNameFromPath(cwd, config.projectSessionPrefix);

  console.log(`📁 Project: ${cwd}`);
  console.log(`🔖 Session: ${sessionName}`);

  const bridge = new TmuxBridge({
    getSessionName: async () => sessionName,
    projectSessionPrefix: config.projectSessionPrefix,
  });

  const exists = await bridge.hasSession(sessionName);

  if (!exists) {
    console.log("🆕 Creating new tmux session...");
    await bridge.createSession(sessionName);
    await sleep(config.sessionWarmupMs);
    await bridge.sendKeys(`cd "${cwd}"`, sessionName);
    await sleep(config.sessionWarmupMs);
    setPathForSession(sessionName, cwd);
    console.log("🚀 Starting Claude...");
    await bridge.sendKeys(config.claudeStartCommand, sessionName);
  } else {
    console.log("📍 Session exists, checking Claude status...");
    setPathForSession(sessionName, cwd);
    await startClaude(bridge, sessionName);
  }

  const attachCmd = `tmux attach -t ${sessionName}`;
  await execFileAsync("sh", ["-c", `printf '%s' "${attachCmd}" | pbcopy`]);
  console.log(`\n✅ Attach command copied to clipboard!`);
}

main().catch(console.error);
