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
  .command("autopilot [project] [verb...]")
  .description(
    "no args: status across sessions · <project>: its autopilot view · <project> <verb>: drive it (on|off|stop|`goal <id>`|`goals <id,id> [rounds N]`|confirm|reject)",
  )
  .option("--json", "output JSON")
  .action(async (project: string | undefined, verb: string[], o) => {
    if (project) return (await ctl()).cmdAutopilot(project, verb, o);
    try {
      const { bootstrap } = await import("./bootstrap.js");
      const { buildAutopilotSnapshot, formatAutopilotText } = await import(
        "./core/autopilot/autopilot-snapshot.js"
      );
      const deps = bootstrap();
      const snap = await buildAutopilotSnapshot(deps);
      process.stdout.write(
        o.json ? `${JSON.stringify(snap, null, 2)}\n` : `${formatAutopilotText(snap)}\n`,
      );
      process.exit(0); // bootstrap starts a live fs.watch (activity watcher) that would otherwise hang the process
    } catch (err) {
      process.stderr.write(
        `autopilot failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  });

program
  .command("sysload")
  .description("show machine load, thermal state, top CPU, and runaway/orphan shells")
  .action(async () => {
    const { gatherSystemLoad, renderSystemLoad, defaultSystemLoadProbes } = await import(
      "./core/infra/system-load.js"
    );
    process.stdout.write(
      `${renderSystemLoad(await gatherSystemLoad(defaultSystemLoadProbes()))}\n`,
    );
  });

program
  .command("tui")
  .description("interactive terminal UI to drive the bot's sessions (needs the bot running)")
  .action(async () => {
    const { runTui } = await import("./tui/run.js");
    await runTui();
  });

// One-shot control-socket clients — drive the running bot from the shell (for an AI
// agent / scripts) without the TUI or a chat app. All need the bot running.
const ctl = (): Promise<typeof import("./cli/control.js")> => import("./cli/control.js");

program
  .command("sessions")
  .description("list the bot's running sessions")
  .option("--json", "output JSON")
  .action(async (o) => (await ctl()).cmdSessions(o));

program
  .command("projects")
  .description("list projects (live + recent) — `tcb open <name>` to start one")
  .option("--json", "output JSON")
  .action(async (o) => (await ctl()).cmdProjects(o));

program
  .command("send <project> <text...>")
  .description("send a prompt to a project's agent; waits for the reply by default")
  .option("--no-wait", "fire-and-forget instead of waiting for the reply")
  .option("--timeout <seconds>", "how long to wait for the reply", "120")
  .option("--json", "output JSON")
  .action(async (project, text, o) => (await ctl()).cmdSend(project, text, o));

program
  .command("peek <project>")
  .description("print a snapshot of a project's tmux pane")
  .option("--lines <n>", "lines of scrollback")
  .option("--json", "output JSON")
  .action(async (project, o) => (await ctl()).cmdPeek(project, o));

program
  .command("open <project>")
  .description(
    "switch to / start a project — by name (incl. stopped) or a filesystem path to create a new one",
  )
  .option("--json", "output JSON")
  .action(async (project, o) => (await ctl()).cmdOpen(project, o));

program
  .command("adopt [pid]")
  .description(
    "list claude/codex running outside tmux, or adopt one by PID (stops it, resumes under management)",
  )
  .option("--json", "output JSON")
  .action(async (pid, o) => (await ctl()).cmdAdopt(pid, o));

program
  .command("control <project> <action>")
  .description("send a control action (esc|enter|interrupt|restart|clear|compact|…)")
  .option("--json", "output JSON")
  .action(async (project, action, o) => (await ctl()).cmdControl(project, action, o));

program
  .command("attach <file...>")
  .description("send an image/file to the session's chat (defaults to the current tmux session)")
  .option("--to <project>", "target a specific project instead of the current tmux session")
  .option("--caption <text>", "optional caption (attached to the first file)")
  .option("--json", "output JSON")
  .action(async (files, o) => (await ctl()).cmdSendAttachment(files, o));

program
  .command("skill")
  .description(
    "install the AI operating skill into Claude Code / Codex (so an agent can drive the bot)",
  )
  .argument("[action]", "install", "install")
  .option("--tool <claude|codex>", "install for one tool only")
  .option("--json", "output JSON")
  .action(async (action: string, o: { tool?: "claude" | "codex"; json?: boolean }) => {
    if (action !== "install") {
      console.error(`unknown skill action "${action}". Try: tmux-claude-bot skill install`);
      process.exit(1);
    }
    const { installSkill } = await import("./cli/skill.js");
    const { tildeifyHome } = await import("./shared/utils/path.js");
    const done = installSkill({
      pkgRoot: PKG_ROOT,
      only: o.tool ? [o.tool] : undefined,
      log: o.json ? undefined : (m) => console.log(`  ${tildeifyHome(m)}`),
    });
    if (o.json) console.log(JSON.stringify(done, null, 2));
    else
      console.log(`Installed the tmux-claude-bot skill for: ${done.map((d) => d.tool).join(", ")}`);
  });

program
  .command("recover")
  .description("Recreate every project's tmux session and relaunch its agent (after a reboot)")
  .option("--dry-run", "show what would be recovered without doing it")
  .option("--json", "output the plan/result as JSON")
  .action(async (o) => {
    try {
      const { bootstrap } = await import("./bootstrap.js");
      const { recoverProjects } = await import("./core/recovery/recover.js");
      const { formatRecoverResult } = await import("./core/recovery/recover-view.js");
      const deps = bootstrap();
      const res = await recoverProjects(deps, { dryRun: o.dryRun });
      process.stdout.write(
        o.json
          ? `${JSON.stringify(res, null, 2)}\n`
          : `${formatRecoverResult(res, { dryRun: o.dryRun })}\n`,
      );
      process.exit(res.failed.length > 0 ? 1 : 0); // bootstrap's fs.watch would otherwise hang
    } catch (err) {
      process.stderr.write(`recover failed: ${err instanceof Error ? err.message : String(err)}\n`);
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

const batch = program.command("batch").description("manage batch scheduler plans and runs");

batch
  .command("load <file>")
  .description("parse and save a YAML batch plan")
  .action(async (file: string) => {
    const { readFileSync } = await import("node:fs");
    const { parsePlanYaml } = await import("./core/scheduler/plan-yaml.js");
    const { SchedulerStore } = await import("./core/scheduler/scheduler-store.js");
    try {
      const plan = parsePlanYaml(readFileSync(file, "utf8"));
      new SchedulerStore().savePlan(plan);
      console.log(`loaded ${plan.id}`);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

batch
  .command("export <id> [file]")
  .description("export a saved plan to YAML (stdout or file)")
  .action(async (id: string, file: string | undefined) => {
    const { writeFileSync } = await import("node:fs");
    const { planToYaml } = await import("./core/scheduler/plan-yaml.js");
    const { SchedulerStore } = await import("./core/scheduler/scheduler-store.js");
    const { tildeifyHome } = await import("./shared/utils/path.js");
    const plan = new SchedulerStore().getPlan(id);
    if (!plan) {
      console.error(`unknown plan "${id}"`);
      process.exit(1);
    }
    const yaml = planToYaml(plan);
    if (file) {
      // Bug #6 fix: write real paths to the file (it must be loadable back), but
      // tildeify only the confirmation message printed to the terminal.
      writeFileSync(file, yaml, "utf8");
      console.log(`exported ${id} -> ${tildeifyHome(file)}`);
    } else {
      // Bug #6 fix: tildeify home paths in the YAML printed to stdout.
      console.log(tildeifyHome(yaml));
    }
  });

batch
  .command("start [id]")
  .description("start a batch run for the given plan id")
  .action(async (id: string | undefined) => {
    const { startPlan } = await import("./core/scheduler/controls.js");
    const { SchedulerStore } = await import("./core/scheduler/scheduler-store.js");
    if (!id) {
      console.error("plan id required");
      process.exit(1);
    }
    const result = startPlan(new SchedulerStore(), id, Date.now());
    if (result.ok) {
      console.log(`started run for plan "${id}"`);
    } else {
      console.error(result.error);
      process.exit(1);
    }
  });

batch
  .command("status")
  .description("show the active batch run status")
  .action(async () => {
    const { renderStatus } = await import("./core/scheduler/report.js");
    const { SchedulerStore } = await import("./core/scheduler/scheduler-store.js");
    const { tildeifyHome } = await import("./shared/utils/path.js");
    console.log(tildeifyHome(renderStatus(new SchedulerStore().getActiveRun())));
  });

batch
  .command("report")
  .description("show a summary report of the active run")
  .action(async () => {
    const { renderSummary } = await import("./core/scheduler/report.js");
    const { SchedulerStore } = await import("./core/scheduler/scheduler-store.js");
    const { tildeifyHome } = await import("./shared/utils/path.js");
    const run = new SchedulerStore().getActiveRun();
    if (!run) {
      console.log("No active batch run.");
      return;
    }
    console.log(tildeifyHome(renderSummary(run)));
  });

batch
  .command("pause")
  .description("pause the active batch run")
  .action(async () => {
    const { pauseRun } = await import("./core/scheduler/controls.js");
    const { SchedulerStore } = await import("./core/scheduler/scheduler-store.js");
    const result = pauseRun(new SchedulerStore());
    if (result.ok) console.log("run paused");
    else {
      console.error(result.error);
      process.exit(1);
    }
  });

batch
  .command("resume")
  .description("resume a paused batch run")
  .action(async () => {
    const { resumeRun } = await import("./core/scheduler/controls.js");
    const { SchedulerStore } = await import("./core/scheduler/scheduler-store.js");
    const result = resumeRun(new SchedulerStore());
    if (result.ok) console.log("run resumed");
    else {
      console.error(result.error);
      process.exit(1);
    }
  });

batch
  .command("stop")
  .description("cancel and clear the active batch run")
  .action(async () => {
    const { stopRun } = await import("./core/scheduler/controls.js");
    const { SchedulerStore } = await import("./core/scheduler/scheduler-store.js");
    stopRun(new SchedulerStore());
    console.log("run stopped");
  });

program.parseAsync().catch((err) => {
  // An async action (e.g. `run`) rejecting would otherwise be an unhandled
  // rejection — surface it cleanly and exit non-zero instead.
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
