#!/usr/bin/env node
/**
 * Single entry point for tmux-claude-bot. Every user-facing operation is a
 * subcommand here — running the bot, the setup wizards, the health check, and
 * launchd service management. This is what the `bin` field and (after Stage 2)
 * the launchd wrapper invoke.
 *
 * Service registration lives behind `service install`, never an npm
 * postinstall: installing the package must never touch the user's system.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";

// dist/cli.js -> package root is one level up. Works the same when this file is
// run from source (src/cli.ts) via tsx.
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = join(PKG_ROOT, "scripts");

function version(): string {
  const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8"));
  return pkg.version ?? "0.0.0";
}

/** Run one of the project's bash scripts, inheriting stdio, and exit with its code. */
function runScript(file: string, args: string[] = []): never {
  const res = spawnSync("bash", [join(SCRIPTS, file), ...args], { stdio: "inherit" });
  process.exit(res.status ?? 1);
}

const program = new Command();

program
  .name("tmux-claude-bot")
  .description("Telegram/Feishu bot that drives Claude Code in tmux sessions")
  .version(version(), "-v, --version");

program
  .command("run")
  .description("run the bot in the foreground (what the launchd service execs)")
  .action(async () => {
    // index.ts starts the bot via top-level side effects on import.
    await import("./index.js");
  });

program
  .command("setup")
  .description("interactive setup wizard (writes .env)")
  .option("--reconfigure", "re-run even if .env already exists")
  .action(async () => {
    await import("./scripts/setup.js");
  });

program
  .command("setup:lark")
  .description("Feishu/Lark onboarding wizard (QR scan -> .env)")
  .action(async () => {
    await import("./scripts/lark-setup.js");
  });

program
  .command("doctor")
  .description("run health checks against the install")
  .action(async () => {
    await import("./scripts/doctor.js");
  });

const service = program.command("service").description("manage the launchd service (macOS)");

service
  .command("install")
  .description("register the auto-restarting launchd service")
  .action(() => runScript("install-launchd.sh"));
service
  .command("uninstall")
  .description("remove the launchd service")
  .action(() => runScript("uninstall-launchd.sh"));
for (const action of ["status", "pause", "resume", "restart", "logs"] as const) {
  service
    .command(action)
    .description(`service.sh ${action}`)
    .action(() => runScript("service.sh", [action]));
}

program.parseAsync();
