import type { Command } from "commander";
import { runPrReviewerCommand } from "../core/loop/pr-review-command.js";
import { readPrReviewWorkOrder, runRalphPrReviewPass } from "../core/loop/ralph-pr-review.js";
import { tildeifyHomeDeep } from "../shared/utils/path.js";

export function registerPrReviewCommands(loop: Command): void {
  const family = loop
    .command("pr-review")
    .description("configure optional PR reviewers and execute one immutable external review pass");
  family
    .command("get <file> <scope> <id>")
    .description("inspect project|repository reviewer with params redacted")
    .action((file: string, scope: string, id: string) =>
      print(runPrReviewerCommand({ action: "get", file, scope, id })),
    );
  family
    .command("set <file> <scope> <id> <kind>")
    .option("--profile <reference>", "opaque RalphWorks profile (default builtin:code-review)")
    .option("--runtime <reference>", "opaque RalphWorks runtime; credentials remain external")
    .option(
      "--param <key=value>",
      "repeatable non-secret primitive parameter",
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .action(
      (
        file: string,
        scope: string,
        id: string,
        kind: string,
        options: { profile?: string; runtime?: string; param: string[] },
      ) => {
        try {
          const params = Object.fromEntries(
            options.param.map((entry) => {
              const index = entry.indexOf("=");
              if (index < 1) throw new Error("invalid parameter");
              const raw = entry.slice(index + 1);
              const value =
                raw === "true"
                  ? true
                  : raw === "false"
                    ? false
                    : /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw)
                      ? Number(raw)
                      : raw;
              return [entry.slice(0, index), value];
            }),
          );
          print(
            runPrReviewerCommand({
              action: "set",
              file,
              scope,
              id,
              selection: {
                kind,
                ...(options.profile === undefined ? {} : { profile: options.profile }),
                ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
                ...(options.param.length === 0 ? {} : { params }),
              },
            }),
          );
        } catch {
          console.error("Invalid reviewer parameters; use non-secret --param key=value entries.");
          process.exitCode = 1;
        }
      },
    );
  family
    .command("pass <workOrderFile> <number>")
    .description(
      "execute one revision-bound external review pass within the stored WorkOrder deadline",
    )
    .requiredOption("--repository <owner/repo>", "canonical candidate repository")
    .requiredOption("--base <sha>", "exact base SHA")
    .requiredOption("--head <sha>", "exact head SHA")
    .option(
      "--timeout-minutes <minutes>",
      "shorter pass budget; cannot extend the WorkOrder deadline",
    )
    .action(
      async (
        workOrderFile: string,
        rawNumber: string,
        options: { repository: string; base: string; head: string; timeoutMinutes?: string },
      ) => {
        const controller = new AbortController();
        const stop = () => controller.abort();
        try {
          const number = Number(rawNumber);
          const minutes =
            options.timeoutMinutes === undefined ? 30 : Number(options.timeoutMinutes);
          if (
            !/^\d+$/.test(rawNumber) ||
            !Number.isSafeInteger(number) ||
            number < 1 ||
            !Number.isFinite(minutes) ||
            minutes <= 0
          )
            throw new Error("invalid pass arguments");
          const workOrder = readPrReviewWorkOrder(workOrderFile);
          process.once("SIGINT", stop);
          process.once("SIGTERM", stop);
          const result = await runRalphPrReviewPass({
            workOrder,
            number,
            repository: options.repository,
            baseSha: options.base,
            headSha: options.head,
            timeoutMs: minutes * 60000,
            signal: controller.signal,
          });
          console.log(JSON.stringify(tildeifyHomeDeep(result)));
          if (result.verdict !== "clean") process.exitCode = 1;
        } catch {
          console.error(
            "PR review pass rejected or blocked; inspect preserved WorkOrder evidence. No native fallback is allowed.",
          );
          process.exitCode = 1;
        } finally {
          process.removeListener("SIGINT", stop);
          process.removeListener("SIGTERM", stop);
        }
      },
    );
}

function print(result: ReturnType<typeof runPrReviewerCommand>): void {
  if (result.exitCode === 0) console.log(result.stdout);
  else {
    console.error(result.stderr);
    process.exitCode = result.exitCode;
  }
}
