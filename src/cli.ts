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
import { registerCapabilityCommands } from "./cli/capability-commands.js";
import { registerConfigurationCommands } from "./cli/configuration-commands.js";
import { registerPowerCommands } from "./cli/power-commands.js";
import { registerResourceCommands } from "./cli/resource-commands.js";
import { registerRuntimeGuardianCommands } from "./cli/runtime-guardian-commands.js";
import { createResourceGuardianStore } from "./core/resource-guardian/store.js";
import { SCHEDULED_TASK_SOURCES } from "./core/tasks/task-ledger.js";
import { appStateDir } from "./shared/state-dir.js";
import { tildeifyHome, tildeifyHomeDeep } from "./shared/utils/path.js";
import { appVersion } from "./shared/version.js";

// Operational logs mirror to stdout only for the bot itself (the `run` command,
// whose stdout launchd captures). Every OTHER subcommand prints machine/CLI
// output to stdout, so default the logger's stdout mirror OFF here and let `run`
// re-enable it — keeping `--json` and query output clean for all data commands
// without each one having to remember the flag. (The JSONL log file is written
// regardless; only the stdout mirror is suppressed.)
process.env.TCB_LOG_QUIET ??= "1";

process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
});

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

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

const program = new Command();

program
  .name("tmux-claude-bot")
  .description("Telegram/Feishu bot that drives Claude Code in managed sessions")
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

registerConfigurationCommands(program);

registerPowerCommands(program);

registerResourceCommands(program);

registerCapabilityCommands(program);

registerRuntimeGuardianCommands(program);

program
  .command("install")
  .description(`provision the managed service (launchd/systemd) into ${tildeifyHome(MANAGED_DIR)}`)
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
  .description("Show the unified Runtime Overview and Project Sessions")
  .option("--json", "output the raw snapshot as JSON")
  .option("--problems", "show only health and attention")
  .option("--project <id>", "narrow active work, outcomes, and sessions by project")
  .option("--limit <n>", "maximum items per bounded overview section", "10")
  .action(async (o: { json?: boolean; problems?: boolean; project?: string; limit: string }) => {
    try {
      // stdout stays clean for the snapshot (esp. --json) via the CLI-wide
      // TCB_LOG_QUIET default set at the top of this file.
      const { bootstrap } = await import("./bootstrap.js");
      const { buildDashboard } = await import("./core/dashboard/dashboard.js");
      const { formatDashboardText } = await import("./core/dashboard/dashboard-view.js");
      const { tildeifyHomeDeep } = await import("./shared/utils/path.js");
      const limit = Number(o.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new Error("--limit must be an integer from 1 to 100");
      }
      const deps = bootstrap();
      const snap = await buildDashboard(deps, {
        overviewOptions: {
          attentionLimit: limit,
          activeWorkLimit: limit,
          recentOutcomeLimit: limit,
          ...(o.problems ? { problemsOnly: true } : {}),
          ...(o.project === undefined ? {} : { project: o.project }),
        },
      });
      process.stdout.write(
        o.json
          ? `${JSON.stringify(tildeifyHomeDeep(snap), null, 2)}\n`
          : `${formatDashboardText(snap, {
              ...(o.problems ? { problemsOnly: true } : {}),
            })}\n`,
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
    "<project> [delegate [requirement]|cancel]: delegate the current session's work to the Loop Supervisor",
  )
  .option("--json", "output JSON")
  .action(async (project: string | undefined, verb: string[], o) => {
    if (project) return (await ctl()).cmdAutopilot(project, verb, o);
    const message =
      "Usage: tcb autopilot <project> [delegate [requirement]|cancel]\nAutopilot now means supervisor-backed delegation only.\n";
    process.stdout.write(
      o.json ? `${JSON.stringify({ usage: message.trim() }, null, 2)}\n` : message,
    );
    process.exit(0);
  });

program
  .command("sysload")
  .description(
    "show machine load, thermal state, top CPU, runaway/orphan shells, and Resource Guardian",
  )
  .action(async () => {
    const { gatherSystemLoad, renderSystemLoad, defaultSystemLoadProbes } = await import(
      "./core/infra/system-load.js"
    );
    process.stdout.write(
      `${renderSystemLoad(
        await gatherSystemLoad(defaultSystemLoadProbes()),
        createResourceGuardianStore({ stateDir: appStateDir() }).readCurrentReadOnly().view,
      )}\n`,
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
  .command("notify [text...]")
  .description("send a local notification through the configured Telegram/Feishu bot")
  .option("--title <text>", "notification title")
  .option("--body <text>", "notification body")
  .option("--stdin", "read notification body from stdin")
  .option("--channel <telegram|lark|both>", "target channel; default is every configured channel")
  .option("--level <info|success|warning|error>", "notification level", "info")
  .option("--source <name>", "source label, such as deploy or backup")
  .option("--session <session>", "project session used for bound Feishu group routing")
  .option("--attach <file>", "attach a file to the notification; repeatable", collect, [])
  .option("--json", "output JSON")
  .action(async (text, o) => (await ctl()).cmdNotify(text ?? [], o));

program
  .command("prompt-translate [args...]")
  .description(
    "view or change prompt translation for local control input: status | off | on [from] [to]",
  )
  .option("--json", "output JSON")
  .action(async (args, o) => (await ctl()).cmdPromptTranslate(args ?? [], o));

program
  .command("peek <project>")
  .description("print a snapshot of a project's session pane")
  .option("--lines <n>", "lines of scrollback")
  .option("--json", "output JSON")
  .action(async (project, o) => (await ctl()).cmdPeek(project, o));

program
  .command("open <project>")
  .description(
    "switch to / start a project — by name (incl. stopped) or a filesystem path to create a new one",
  )
  .option(
    "--agent <kind>",
    "start with a specific agent when the project is stopped (claude|codex)",
  )
  .option("--json", "output JSON")
  .action(async (project, o) => (await ctl()).cmdOpen(project, o));

program
  .command("open-worker <session> <path>")
  .description("start an isolated automation worker session at a project path")
  .option("--agent <kind>", "start with a specific agent when the worker is stopped (claude|codex)")
  .option("--json", "output JSON")
  .action(async (session, projectPath, o) => (await ctl()).cmdOpenWorker(session, projectPath, o));

program
  .command("adopt [pid]")
  .description(
    "list unmanaged claude/codex processes, or adopt one by PID (stops it, resumes under management)",
  )
  .option("--json", "output JSON")
  .action(async (pid, o) => (await ctl()).cmdAdopt(pid, o));

program
  .command("control <project> <action>")
  .description("send a control action (esc|enter|interrupt|resume|restart|clear|compact|…)")
  .option("-y, --yes", "confirm dangerous control actions without prompting")
  .option("--json", "output JSON")
  .action(async (project, action, o) => (await ctl()).cmdControl(project, action, o));

program
  .command("attach <file...>")
  .description("send an image/file to the session's chat (defaults to the current session)")
  .option("--to <project>", "target a specific project instead of the current session")
  .option("--caption <text>", "optional caption (attached to the first file)")
  .option("--json", "output JSON")
  .action(async (files, o) => (await ctl()).cmdSendAttachment(files, o));

program
  .command("skill")
  .description("manage Home Operator skill installation scopes for Claude Code / Codex discovery")
  .argument("[action]", "install", "install")
  .option("--tool <claude|codex>", "install for one tool only")
  .option(
    "--scope <operator-home|global|all>",
    "installation scope (install default: operator-home)",
  )
  .option("--json", "output JSON")
  .action(
    async (
      action: string,
      o: { tool?: "claude" | "codex"; scope?: "operator-home" | "global" | "all"; json?: boolean },
    ) => {
      if (!["install", "status", "uninstall"].includes(action)) {
        console.error(
          `unknown skill action "${action}". Try: tmux-claude-bot skill install|status|uninstall`,
        );
        process.exit(1);
      }
      const { installSkill, skillInstallStatus, uninstallSkill } = await import("./cli/skill.js");
      const { operatorHomeDir, provisionOperatorHome } = await import(
        "./core/projects/operator-home.js"
      );
      const { tildeifyHome } = await import("./shared/utils/path.js");
      const only = o.tool ? [o.tool] : undefined;
      const operatorHome = operatorHomeDir({
        homeOperator: { dir: process.env.HOME_OPERATOR_DIR ?? "" },
      });
      const requestedScope = o.scope ?? (action === "status" ? "all" : "operator-home");
      if (!["operator-home", "global", "all"].includes(requestedScope)) {
        console.error(
          `unknown skill scope "${requestedScope}". Try: operator-home, global, or all`,
        );
        process.exit(1);
      }
      const scopedHomes =
        requestedScope === "all"
          ? ([
              ["operator-home", operatorHome],
              ["global", undefined],
            ] as const)
          : ([
              [requestedScope, requestedScope === "operator-home" ? operatorHome : undefined],
            ] as const);
      if (action === "status") {
        const status = scopedHomes.flatMap(([scope, home]) =>
          skillInstallStatus({ ...(home !== undefined ? { home } : {}), only, scope }),
        );
        if (o.json) console.log(JSON.stringify(status, null, 2));
        else {
          for (const item of status) {
            console.log(
              `${item.scope}/${item.tool}${item.legacy ? " legacy" : ""}: ${
                item.installed ? "installed" : "missing"
              } ${tildeifyHome(item.path)}`,
            );
          }
        }
        return;
      }
      if (action === "uninstall") {
        const done = scopedHomes.flatMap(([scope, home]) =>
          uninstallSkill({
            ...(home !== undefined ? { home } : {}),
            only,
            scope,
            log: o.json ? undefined : (m) => console.log(`  ${tildeifyHome(m)}`),
          }),
        );
        if (o.json) console.log(JSON.stringify(done, null, 2));
        else console.log(`Removed ${done.filter((d) => d.removed).length} tcb skill file(s).`);
        return;
      }
      const done = scopedHomes.flatMap(([scope, home]) => {
        if (scope === "operator-home") provisionOperatorHome(operatorHome);
        return installSkill({
          pkgRoot: PKG_ROOT,
          ...(home !== undefined ? { home } : {}),
          only,
          scope,
          log: o.json ? undefined : (m) => console.log(`  ${tildeifyHome(m)}`),
        });
      });
      if (o.json) console.log(JSON.stringify(done, null, 2));
      else {
        console.log(
          `Installed tcb-home-operator skill targets: ${done
            .map((d) => `${d.scope}/${d.tool}`)
            .join(", ")}`,
        );
        if (requestedScope !== "operator-home") {
          console.log("Legacy global skill names were removed if present.");
        }
      }
    },
  );

program
  .command("ai-tools")
  .description("install or inspect role-scoped AI tool surfaces")
  .argument("[action]", "status")
  .option("--dir <path>", "operator home directory for generated skill and MCP files")
  .option("--command <command>", "stdio command written into generated MCP profile files")
  .option("--json", "output JSON")
  .action(async (action: string, opts: { dir?: string; command?: string; json?: boolean }) => {
    if (!["install", "status"].includes(action)) {
      console.error(`unknown ai-tools action "${action}". Try: install or status`);
      process.exit(1);
    }
    const { existsSync } = await import("node:fs");
    const { installSkill, skillInstallStatus, uninstallSkill } = await import("./cli/skill.js");
    const {
      defaultOperatorHomeAiToolFiles,
      globalHomeOperatorSkillFiles,
      legacyGlobalHomeOperatorSkillFiles,
    } = await import("./core/ai-tools/install-contract.js");
    const { installMcpProfiles, MCP_PROFILES } = await import("./core/mcp/profiles.js");
    const { operatorHomeDir, provisionOperatorHome } = await import(
      "./core/projects/operator-home.js"
    );
    const { tildeifyHome, tildeifyHomeDeep } = await import("./shared/utils/path.js");
    const operatorHome =
      opts.dir ??
      operatorHomeDir({
        homeOperator: { dir: process.env.HOME_OPERATOR_DIR ?? "" },
      });

    if (action === "install") {
      provisionOperatorHome(operatorHome);
      const removedGlobal = uninstallSkill({ scope: "global" });
      const skills = installSkill({
        pkgRoot: PKG_ROOT,
        home: operatorHome,
        scope: "operator-home",
      });
      const mcp = installMcpProfiles({
        homeDir: operatorHome,
        profiles: [...MCP_PROFILES],
        ...(opts.command !== undefined ? { command: opts.command } : {}),
      });
      const result = { operatorHome, removedGlobal, skills, mcp };
      if (opts.json) {
        console.log(JSON.stringify(tildeifyHomeDeep(result), null, 2));
      } else {
        console.log(`Installed default AI tool surfaces in ${tildeifyHome(operatorHome)}.`);
        console.log(
          `Removed ${removedGlobal.filter((item) => item.removed).length} global skill file(s).`,
        );
        for (const item of skills) {
          console.log(`  skill ${item.scope}/${item.tool}: ${tildeifyHome(item.path)}`);
        }
        for (const item of mcp) {
          console.log(
            `  mcp ${item.profile}: ${tildeifyHome(item.path)} (${item.command} ${item.args.join(" ")})`,
          );
        }
      }
      return;
    }

    const expected = defaultOperatorHomeAiToolFiles(operatorHome).map((file) => ({
      ...file,
      installed: existsSync(file.path),
    }));
    const global = [
      ...globalHomeOperatorSkillFiles(),
      ...legacyGlobalHomeOperatorSkillFiles().map((file) => ({ ...file, legacy: true })),
    ].map((file) => ({
      ...file,
      installed: existsSync(file.path),
    }));
    const skillStatus = skillInstallStatus({ home: operatorHome, scope: "operator-home" });
    const result = { operatorHome, expected, global, skillStatus };
    if (opts.json) {
      console.log(JSON.stringify(tildeifyHomeDeep(result), null, 2));
    } else {
      console.log(`Operator home: ${tildeifyHome(operatorHome)}`);
      for (const item of expected) {
        const label =
          item.surface === "mcp" ? `mcp/${item.profile ?? "unknown"}` : `skill/${item.client}`;
        console.log(`  ${item.installed ? "ok" : "missing"} ${label}: ${tildeifyHome(item.path)}`);
      }
      for (const item of global) {
        console.log(
          `  ${item.installed ? "present" : "absent"} global/${item.client}${
            "legacy" in item ? " legacy" : ""
          }: ${tildeifyHome(item.path)}`,
        );
      }
    }
  });

program
  .command("mcp")
  .description("run tmux-claude-bot MCP servers")
  .argument("[profileOrAction]", "observer")
  .option("--profile <observer|home>", "profile to install (default: all)")
  .option("--dir <path>", "operator home directory for generated MCP profile files")
  .option("--command <command>", "stdio command written into generated profile files")
  .option("--json", "output JSON")
  .action(
    async (
      profileOrAction: string,
      opts: { profile?: string; dir?: string; command?: string; json?: boolean },
    ) => {
      if (profileOrAction === "install") {
        const { installMcpProfiles, MCP_PROFILES, parseMcpProfile } = await import(
          "./core/mcp/profiles.js"
        );
        const { operatorHomeDir, provisionOperatorHome } = await import(
          "./core/projects/operator-home.js"
        );
        const { tildeifyHome } = await import("./shared/utils/path.js");
        const profile =
          opts.profile === undefined ? null : parseMcpProfile(opts.profile.toLowerCase());
        if (opts.profile !== undefined && profile === null) {
          console.error(`unknown MCP profile "${opts.profile}". Try: observer or home`);
          process.exit(1);
        }
        const homeDir =
          opts.dir ??
          operatorHomeDir({
            homeOperator: { dir: process.env.HOME_OPERATOR_DIR ?? "" },
          });
        provisionOperatorHome(homeDir);
        const done = installMcpProfiles({
          homeDir,
          profiles: profile === null ? [...MCP_PROFILES] : [profile],
          ...(opts.command !== undefined ? { command: opts.command } : {}),
        });
        if (opts.json) {
          console.log(JSON.stringify(done, null, 2));
        } else {
          for (const item of done) {
            console.log(
              `${item.profile}: ${tildeifyHome(item.path)} (${item.command} ${item.args.join(" ")})`,
            );
          }
        }
        return;
      }
      const profile = profileOrAction;
      if (profile === "observer") {
        const { runObserverMcpServer } = await import("./mcp/observer.js");
        await runObserverMcpServer();
        return;
      }
      if (profile === "home") {
        const { runHomeMcpServer } = await import("./mcp/home.js");
        await runHomeMcpServer();
        return;
      }
      console.error(`unknown MCP profile "${profile}". Try: tmux-claude-bot mcp observer|home`);
      process.exit(1);
    },
  );

program
  .command("recover")
  .description("Recreate every project's session and relaunch its agent (after a reboot)")
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
  .option("--run-id <id>", "match a loop run id anywhere in the structured record")
  .option("--since <time>", "ISO time, epoch ms, or relative duration such as 30m, 2h, 1d")
  .option("--days <n>", "how many daily files back to read", "1")
  .option("-n, --n <count>", "keep the last N")
  .option("--summary", "summarize volume, integrity, components, and repeated WARN/ERROR issues")
  .option("--json", "output JSON lines")
  .action(async (o) => {
    const {
      argsToFilter,
      filterRecords,
      formatLogSummary,
      parseLogDays,
      readLogReport,
      summarizeLogs,
    } = await import("./core/logs/log-query.js");
    const days = parseLogDays(o.days);
    const filter = argsToFilter({ ...o, n: o.n ?? (o.summary ? undefined : "200") });
    const read = readLogReport(days);
    const recs = filterRecords(read.records, filter);
    if (o.summary) {
      const summary = summarizeLogs(recs, read);
      process.stdout.write(
        `${o.json ? JSON.stringify(tildeifyHomeDeep(summary), null, 2) : tildeifyHome(formatLogSummary(summary))}\n`,
      );
      return;
    }
    for (const r of recs) {
      if (o.json) process.stdout.write(`${JSON.stringify(tildeifyHomeDeep(r))}\n`);
      else
        process.stdout.write(
          `${tildeifyHome(`${r.ts} ${r.level} ${r.component ?? "-"} ${r.traceId ?? "-"} ${r.msg}`)}\n`,
        );
    }
  });

const task = program.command("task").description("report external scheduled task status");

task
  .command("audit")
  .description("run the daily scheduled task audit through the running bot")
  .option("--now <time>", "override current time for automation/testing (epoch ms or ISO)")
  .option("--force", "run immediately even if the configured schedule is not due")
  .option("--json", "output JSON")
  .action(async (o: { now?: string; force?: boolean; json?: boolean }) => {
    const { cmdTaskAudit } = await ctl();
    await cmdTaskAudit(o);
  });

task
  .command("report")
  .description("record an external scheduled task in the shared daily task ledger")
  .requiredOption("--id <id>", "stable task id")
  .requiredOption("--source <source>", `task source: ${SCHEDULED_TASK_SOURCES.join(", ")}`)
  .requiredOption("--name <name>", "human readable task name")
  .requiredOption("--scheduled-at <time>", "scheduled time, epoch ms or ISO")
  .requiredOption("--status <status>", "running, success, failed, or skipped")
  .option("--started-at <time>", "start time, epoch ms or ISO")
  .option("--ended-at <time>", "end time, epoch ms or ISO")
  .option("--summary <text>", "short result summary")
  .option("--error <text>", "failure reason")
  .option("--report <path>", "path to a generated report")
  .option(
    "--repair-status <status>",
    "repair state: not-needed, pending, running, fixed, blocked, failed, superseded, or not-reproducible",
  )
  .option("--json", "output JSON")
  .action(async (o) => {
    const { recordExternalTaskReport } = await import("./core/tasks/task-report.js");
    const sources = new Set(SCHEDULED_TASK_SOURCES);
    const statuses = new Set(["running", "success", "failed", "skipped"]);
    const repairStatuses = new Set([
      "not-needed",
      "pending",
      "running",
      "fixed",
      "blocked",
      "failed",
      "superseded",
      "not-reproducible",
    ]);
    const parseTime = (value: string | undefined): number | undefined => {
      if (value === undefined) return undefined;
      const numeric = Number(value);
      return Number.isFinite(numeric) ? numeric : Date.parse(value);
    };
    const scheduledAt = parseTime(o.scheduledAt);
    if (scheduledAt === undefined || Number.isNaN(scheduledAt)) {
      console.error(`invalid --scheduled-at "${o.scheduledAt}"`);
      process.exit(1);
    }
    const startedAt = parseTime(o.startedAt);
    if (o.startedAt !== undefined && (startedAt === undefined || Number.isNaN(startedAt))) {
      console.error(`invalid --started-at "${o.startedAt}"`);
      process.exit(1);
    }
    const endedAt = parseTime(o.endedAt);
    if (o.endedAt !== undefined && (endedAt === undefined || Number.isNaN(endedAt))) {
      console.error(`invalid --ended-at "${o.endedAt}"`);
      process.exit(1);
    }
    if (!sources.has(o.source)) {
      console.error(`invalid --source "${o.source}"`);
      process.exit(1);
    }
    if (!statuses.has(o.status)) {
      console.error(`invalid --status "${o.status}"`);
      process.exit(1);
    }
    if (o.repairStatus !== undefined && !repairStatuses.has(o.repairStatus)) {
      console.error(`invalid --repair-status "${o.repairStatus}"`);
      process.exit(1);
    }
    const report = {
      taskId: o.id,
      source: o.source as Parameters<typeof recordExternalTaskReport>[0]["source"],
      name: o.name,
      scheduledAt,
      status: o.status as Parameters<typeof recordExternalTaskReport>[0]["status"],
      ...(o.summary !== undefined ? { summary: o.summary } : {}),
      ...(o.error !== undefined ? { error: o.error } : {}),
      ...(o.report !== undefined ? { reportPath: o.report } : {}),
      ...(o.repairStatus !== undefined
        ? {
            repairStatus: o.repairStatus as NonNullable<
              Parameters<typeof recordExternalTaskReport>[0]["repairStatus"]
            >,
          }
        : {}),
    };
    recordExternalTaskReport({
      ...report,
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(endedAt !== undefined ? { endedAt } : {}),
    });
    const result = { ok: true, taskId: o.id };
    console.log(o.json ? JSON.stringify(result) : `recorded ${o.id}`);
  });

const loop = program.command("loop").description("validate Loop Engineering configs");

const prompts = program
  .command("prompts")
  .description("inspect prompt libraries and governed system prompts");

const governedPrompts = prompts
  .command("governed")
  .description("inspect and evaluate repo-owned governed system prompts");

governedPrompts
  .command("list")
  .description("list governed system prompts")
  .option("--json", "output prompt metadata as JSON")
  .action(async (o: { json?: boolean }) => {
    const { runGovernedPromptsCommand } = await import("./core/prompts/command.js");
    const result = runGovernedPromptsCommand(["list", ...(o.json ? ["--json"] : [])]);
    if (result.exitCode === 0) console.log(result.stdout);
    else {
      console.error(result.stderr);
      process.exit(1);
    }
  });

governedPrompts
  .command("show <promptId>")
  .description("show governed prompt metadata and source owner")
  .option("--json", "output prompt metadata as JSON")
  .action(async (promptId: string, o: { json?: boolean }) => {
    const { runGovernedPromptsCommand } = await import("./core/prompts/command.js");
    const result = runGovernedPromptsCommand(["show", promptId, ...(o.json ? ["--json"] : [])]);
    if (result.exitCode === 0) console.log(result.stdout);
    else {
      console.error(result.stderr);
      process.exit(1);
    }
  });

governedPrompts
  .command("render <promptId>")
  .description("render a governed prompt with a built-in fixture")
  .option("--fixture <name>", "fixture name", "default")
  .option("--json", "output rendered prompt as JSON")
  .action(async (promptId: string, o: { fixture?: string; json?: boolean }) => {
    const { runGovernedPromptsCommand } = await import("./core/prompts/command.js");
    const result = runGovernedPromptsCommand([
      "render",
      promptId,
      ...(o.fixture !== undefined ? ["--fixture", o.fixture] : []),
      ...(o.json ? ["--json"] : []),
    ]);
    if (result.exitCode === 0) console.log(result.stdout);
    else {
      console.error(result.stderr);
      process.exit(1);
    }
  });

governedPrompts
  .command("check")
  .description("run deterministic governed prompt metadata checks")
  .option("--json", "output check result as JSON")
  .action(async (o: { json?: boolean }) => {
    const { runGovernedPromptsCommand } = await import("./core/prompts/command.js");
    const result = runGovernedPromptsCommand(["check", ...(o.json ? ["--json"] : [])]);
    if (result.exitCode === 0) console.log(result.stdout);
    else {
      console.error(result.stderr);
      process.exit(1);
    }
  });

governedPrompts
  .command("eval [promptId]")
  .description("generate an active-agent AI eval prompt for governed prompts")
  .option("--all", "evaluate every governed prompt")
  .option("--output <file>", "write the generated eval prompt to a file")
  .action(async (promptId: string | undefined, o: { all?: boolean; output?: string }) => {
    const { runGovernedPromptsCommand } = await import("./core/prompts/command.js");
    const result = runGovernedPromptsCommand([
      "eval",
      ...(o.all ? ["--all"] : []),
      ...(promptId !== undefined ? [promptId] : []),
      ...(o.output !== undefined ? ["--output", o.output] : []),
    ]);
    if (result.exitCode === 0) console.log(result.stdout);
    else {
      console.error(result.stderr);
      process.exit(1);
    }
  });

loop
  .command("validate <file>")
  .description("validate a Loop Engineering YAML config without executing projects")
  .option("--json", "output a machine-readable validation summary")
  .action(async (file: string, o: { json?: boolean }) => {
    const { runLoopCommand } = await import("./core/loop/loop-command.js");
    const result = runLoopCommand(["validate", file, ...(o.json ? ["--json"] : [])]);
    if (result.exitCode === 0) {
      console.log(result.stdout);
    } else {
      console.error(result.stderr);
      process.exit(1);
    }
  });

loop
  .command("tick <file>")
  .description("check due Loop Engineering projects without executing them")
  .option(
    "--now <time>",
    "override current time for automation/testing (epoch ms or ISO timestamp)",
  )
  .option("--json", "output a machine-readable tick summary")
  .action(async (file: string, o: { now?: string; json?: boolean }) => {
    const { runLoopCommand } = await import("./core/loop/loop-command.js");
    const result = runLoopCommand([
      "tick",
      file,
      ...(o.now !== undefined ? ["--now", o.now] : []),
      ...(o.json ? ["--json"] : []),
    ]);
    if (result.exitCode === 0) {
      console.log(result.stdout);
    } else {
      console.error(result.stderr);
      process.exit(1);
    }
  });

loop
  .command("run <file> <projectId>")
  .description("run a deterministic command-backed Loop Engineering project")
  .option("--json", "output a machine-readable run summary")
  .action(async (file: string, projectId: string, o: { json?: boolean }) => {
    const { runLoopCommand } = await import("./core/loop/loop-command.js");
    const result = runLoopCommand(["run", file, projectId, ...(o.json ? ["--json"] : [])]);
    if (result.exitCode === 0) {
      console.log(result.stdout);
    } else {
      console.error(result.stderr);
      process.exit(1);
    }
  });

const loopReports = loop.command("reports").description("list Loop Engineering run reports");

loopReports
  .command("list")
  .description("list recorded Loop Engineering run reports")
  .option("--project <id>", "filter reports by project id")
  .option("--status <passed|failed>", "filter reports by terminal status")
  .option("--limit <number>", "maximum reports to return (1-100)")
  .option("--json", "output reports as JSON")
  .action(async (o: { project?: string; status?: string; limit?: string; json?: boolean }) => {
    const { runLoopCommand } = await import("./core/loop/loop-command.js");
    const result = runLoopCommand([
      "reports",
      "list",
      ...(o.project === undefined ? [] : ["--project", o.project]),
      ...(o.status === undefined ? [] : ["--status", o.status]),
      ...(o.limit === undefined ? [] : ["--limit", o.limit]),
      ...(o.json ? ["--json"] : []),
    ]);
    if (result.exitCode === 0) {
      console.log(result.stdout);
    } else {
      console.error(result.stderr);
      process.exit(1);
    }
  });

const loopTargets = loop
  .command("targets")
  .description("inspect and toggle Loop Engineering targets");

loopTargets
  .command("list <file>")
  .description("list Loop Engineering projects, workspaces, and PR review repositories")
  .option("--json", "output targets as JSON")
  .action(async (file: string, o: { json?: boolean }) => {
    const { runLoopCommand } = await import("./core/loop/loop-command.js");
    const result = runLoopCommand(["targets", "list", file, ...(o.json ? ["--json"] : [])]);
    if (result.exitCode === 0) {
      console.log(result.stdout);
    } else {
      console.error(result.stderr);
      process.exit(1);
    }
  });

for (const action of ["enable", "disable"] as const) {
  loopTargets
    .command(`${action} <file> <kind> <id>`)
    .description(`${action} a Loop Engineering project, workspace, or PR review repository`)
    .option("--json", "output toggle result as JSON")
    .action(async (file: string, kind: string, id: string, o: { json?: boolean }) => {
      const { runLoopCommand } = await import("./core/loop/loop-command.js");
      const result = runLoopCommand([
        "targets",
        action,
        file,
        kind,
        id,
        ...(o.json ? ["--json"] : []),
      ]);
      if (result.exitCode === 0) {
        console.log(result.stdout);
      } else {
        console.error(result.stderr);
        process.exit(1);
      }
    });
}

const loopBacklog = loop.command("backlog").description("manage Loop Engineering backlog items");

loopBacklog
  .command("list")
  .description("list Loop Engineering backlog items")
  .option("--all", "include closed backlog items")
  .option("--project <id>", "filter backlog items by project id")
  .option("--status <open|closed|all>", "filter backlog items by status")
  .option("--limit <number>", "maximum backlog items to return (1-100)")
  .option("--json", "output backlog items as JSON")
  .action(
    async (o: {
      all?: boolean;
      project?: string;
      status?: string;
      limit?: string;
      json?: boolean;
    }) => {
      const { runLoopCommand } = await import("./core/loop/loop-command.js");
      const result = runLoopCommand([
        "backlog",
        "list",
        ...(o.all ? ["--all"] : []),
        ...(o.project === undefined ? [] : ["--project", o.project]),
        ...(o.status === undefined ? [] : ["--status", o.status]),
        ...(o.limit === undefined ? [] : ["--limit", o.limit]),
        ...(o.json ? ["--json"] : []),
      ]);
      if (result.exitCode === 0) {
        console.log(result.stdout);
      } else {
        console.error(result.stderr);
        process.exit(1);
      }
    },
  );

loopBacklog
  .command("close <id>")
  .description("close a Loop Engineering backlog item")
  .option("--json", "output close result as JSON")
  .action(async (id: string, o: { json?: boolean }) => {
    const { runLoopCommand } = await import("./core/loop/loop-command.js");
    const result = runLoopCommand(["backlog", "close", id, ...(o.json ? ["--json"] : [])]);
    if (result.exitCode === 0) {
      console.log(result.stdout);
    } else {
      console.error(result.stderr);
      process.exit(1);
    }
  });

const loopSkills = loop
  .command("skills")
  .description("list, refresh, or sync the Loop Engineering skill registry");

loopSkills
  .command("list")
  .description("list recorded Loop Engineering skills")
  .option("--json", "output recorded skills as JSON")
  .action(async (o: { json?: boolean }) => {
    const { runLoopCommand } = await import("./core/loop/loop-command.js");
    const result = runLoopCommand(["skills", "list", ...(o.json ? ["--json"] : [])]);
    if (result.exitCode === 0) {
      console.log(result.stdout);
    } else {
      console.error(result.stderr);
      process.exit(1);
    }
  });

loopSkills
  .command("sync <file>")
  .description("reconcile approved Loop Engineering skills through skills.applyCommand")
  .option("--json", "output a machine-readable sync summary")
  .action(async (file: string, o: { json?: boolean }) => {
    const { runLoopCommand } = await import("./core/loop/loop-command.js");
    const result = runLoopCommand(["skills", "sync", file, ...(o.json ? ["--json"] : [])]);
    if (result.exitCode === 0) {
      console.log(result.stdout);
    } else {
      console.error(result.stderr);
      process.exit(1);
    }
  });

loopSkills
  .command("refresh <file>")
  .description("resolve catalog skills to pinned approved refs")
  .option("--write", "write refreshed approved skill refs back to the config file")
  .option("--json", "output a machine-readable refresh summary")
  .action(async (file: string, o: { write?: boolean; json?: boolean }) => {
    const { runLoopCommand } = await import("./core/loop/loop-command.js");
    const result = runLoopCommand([
      "skills",
      "refresh",
      file,
      ...(o.write ? ["--write"] : []),
      ...(o.json ? ["--json"] : []),
    ]);
    if (result.exitCode === 0) {
      console.log(result.stdout);
    } else {
      console.error(result.stderr);
      process.exit(1);
    }
  });

program.parseAsync().catch((err) => {
  // An async action (e.g. `run`) rejecting would otherwise be an unhandled
  // rejection — surface it cleanly and exit non-zero instead.
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
