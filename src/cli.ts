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
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { appVersion } from "./shared/version.js";

// Operational logs mirror to stdout only for the bot itself (the `run` command,
// whose stdout launchd captures). Every OTHER subcommand prints machine/CLI
// output to stdout, so default the logger's stdout mirror OFF here and let `run`
// re-enable it — keeping `--json` and query output clean for all data commands
// without each one having to remember the flag. (The JSONL log file is written
// regardless; only the stdout mirror is suppressed.)
process.env.TCB_LOG_QUIET ??= "1";

// dist/cli.js -> package root is one level up. Works the same when this file is
// run from source (src/cli.ts) via tsx.
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = join(PKG_ROOT, "scripts");

// The stable managed runtime the launchd service runs from. A curl|bash install
// IS this dir; an `npm i -g` install lives elsewhere and provisions this via
// `tmux-claude-bot install`.
const MANAGED_DIR = process.env.TMUX_CLAUDE_BOT_DIR ?? join(homedir(), ".tmux-claude-bot");
const IS_MANAGED = resolve(PKG_ROOT) === resolve(MANAGED_DIR);

/** Run one of the project's bash scripts, inheriting stdio, and exit with its code. */
function runScript(file: string, args: string[] = []): never {
  const res = spawnSync("bash", [join(SCRIPTS, file), ...args], { stdio: "inherit" });
  process.exit(res.status ?? 1);
}

const program = new Command();

program
  .name("tmux-claude-bot")
  .description("Telegram/Feishu bot that drives Claude Code in tmux sessions")
  .version(appVersion(), "-v, --version");

program
  .command("run")
  .description("run the bot in the foreground (what the launchd service execs)")
  .action(async () => {
    // The bot owns stdout for launchd/`tail -f`, so re-enable the logger's stdout
    // mirror that the CLI defaults off (see TCB_LOG_QUIET note at top).
    delete process.env.TCB_LOG_QUIET;
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
  .description(`provision the managed service (launchd/systemd) into ${MANAGED_DIR}`)
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

const service = program
  .command("service")
  .description("manage the bot service (launchd on macOS, systemd --user on Linux)");

service
  .command("install")
  .description("register the auto-restarting service")
  .action(() => {
    if (!IS_MANAGED) {
      console.error(
        `Refusing to register the service from a non-managed location:\n  ${PKG_ROOT}\n` +
          `That path is volatile (e.g. a global npm dir). Run 'tmux-claude-bot install'\n` +
          `to provision the managed runtime at ${MANAGED_DIR} and register the service.`,
      );
      process.exit(1);
    }
    runScript("install-service.sh");
  });
service
  .command("uninstall")
  .description("remove the service")
  .action(() => runScript("uninstall-service.sh"));
for (const action of ["status", "pause", "resume", "restart", "logs"] as const) {
  service
    .command(action)
    .description(`service.sh ${action}`)
    .action(() => runScript("service.sh", [action]));
}

program
  .command("dashboard")
  .description("Show a global status dashboard of all sessions")
  .option("--json", "output the raw snapshot as JSON")
  .action(async (o) => {
    try {
      // stdout stays clean for the snapshot (esp. --json) via the CLI-wide
      // TCB_LOG_QUIET default set at the top of this file.
      const { bootstrap } = await import("./bootstrap.js");
      const { buildDashboard } = await import("./core/dashboard/dashboard.js");
      const { formatDashboardText } = await import("./core/dashboard/dashboard-view.js");
      const deps = bootstrap();
      const snap = await buildDashboard(deps);
      process.stdout.write(
        o.json ? `${JSON.stringify(snap, null, 2)}\n` : `${formatDashboardText(snap)}\n`,
      );
      process.exit(0); // bootstrap starts a live fs.watch (activity watcher) that would otherwise hang the process
    } catch (err) {
      process.stderr.write(
        `dashboard failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  });

program
  .command("logs")
  .description("Query the structured logs")
  .option("--session <name>")
  .option("--trace <id>")
  .option("--chat <id>")
  .option("--channel <ch>")
  .option("--component <prefix>")
  .option("--level <level>", "minimum level (DEBUG|INFO|WARN|ERROR)")
  .option("--grep <text>")
  .option("--days <n>", "how many daily files back to read", "1")
  .option("-n, --n <count>", "keep the last N")
  .option("--json", "output JSON lines")
  .action(async (o) => {
    const { argsToFilter, queryLogs } = await import("./core/logs/log-query.js");
    const recs = queryLogs(argsToFilter(o), Number.parseInt(o.days, 10));
    for (const r of recs) {
      if (o.json) process.stdout.write(`${JSON.stringify(r)}\n`);
      else
        process.stdout.write(
          `${r.ts} ${r.level} ${r.component ?? "-"} ${r.traceId ?? "-"} ${r.msg}\n`,
        );
    }
  });

program.parseAsync().catch((err) => {
  // An async action (e.g. `run`) rejecting would otherwise be an unhandled
  // rejection — surface it cleanly and exit non-zero instead.
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
