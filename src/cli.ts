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
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";

// dist/cli.js -> package root is one level up. Works the same when this file is
// run from source (src/cli.ts) via tsx.
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = join(PKG_ROOT, "scripts");

// The stable managed runtime the launchd service runs from. A curl|bash install
// IS this dir; an `npm i -g` install lives elsewhere and provisions this via
// `tmux-claude-bot install`.
const MANAGED_DIR = process.env.TMUX_CLAUDE_BOT_DIR ?? join(homedir(), ".tmux-claude-bot");
const IS_MANAGED = resolve(PKG_ROOT) === resolve(MANAGED_DIR);

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
  // setup.js reads these straight from argv; declared here so commander parses
  // them as options rather than rejecting them as excess arguments.
  .option("--reconfigure", "re-run even if .env already exists")
  .option("--yes", "non-interactive: accept defaults / existing env")
  .option("--dry-run", "walk the wizard without writing .env or calling APIs")
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

program
  .command("install")
  .description(`provision the managed launchd service into ${MANAGED_DIR}`)
  .action(() => {
    // Materialize the prebuilt package into the stable managed dir and register
    // the service, so `npm i -g … && tmux-claude-bot install` stands up the same
    // managed runtime as the curl|bash installer — never running the launchd
    // daemon from the volatile global node_modules path.
    const res = spawnSync("bash", [join(PKG_ROOT, "install.sh")], {
      stdio: "inherit",
      env: { ...process.env, TCB_MATERIALIZE_FROM: PKG_ROOT },
    });
    process.exit(res.status ?? 1);
  });

const service = program.command("service").description("manage the launchd service (macOS)");

service
  .command("install")
  .description("register the auto-restarting launchd service")
  .action(() => {
    if (!IS_MANAGED) {
      console.error(
        `Refusing to register launchd from a non-managed location:\n  ${PKG_ROOT}\n` +
          `That path is volatile (e.g. a global npm dir). Run 'tmux-claude-bot install'\n` +
          `to provision the managed runtime at ${MANAGED_DIR} and register the service.`,
      );
      process.exit(1);
    }
    runScript("install-launchd.sh");
  });
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

program.parseAsync().catch((err) => {
  // An async action (e.g. `run`) rejecting would otherwise be an unhandled
  // rejection — surface it cleanly and exit non-zero instead.
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
