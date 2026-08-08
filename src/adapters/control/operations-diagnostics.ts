import { buildDashboard } from "../../core/dashboard/dashboard.js";
import type { HandlerDeps } from "../../core/deps.js";
import {
  defaultSystemLoadProbes,
  gatherSystemLoad,
  renderSystemLoad,
} from "../../core/infra/system-load.js";
import { queryLogs } from "../../core/logs/log-query.js";
import { formatLogsForChat, logsArgToFilter } from "../../core/logs/logs-view.js";
import { getPathBySession } from "../../core/projects/sessionPathMap.js";
import {
  applyPromptTranslateCommand,
  formatPromptTranslateCommandResult,
} from "../../core/read/prompt-translation.js";
import { getRecentInputs } from "../../core/read/recent-inputs.js";
import { renderPeekPane } from "../../core/session/output.js";
import type { ControlOperationHandler } from "./operations-types.js";

/** Read-only Project Session and diagnostics handlers for the Control adapter. */
export function createControlDiagnosticsHandlers(deps: HandlerDeps): {
  snapshot: ControlOperationHandler<
    Extract<Parameters<ControlOperationHandler>[0], { op: "snapshot" }>
  >;
  peek: ControlOperationHandler<Extract<Parameters<ControlOperationHandler>[0], { op: "peek" }>>;
  logs: ControlOperationHandler<Extract<Parameters<ControlOperationHandler>[0], { op: "logs" }>>;
  sysload: ControlOperationHandler<
    Extract<Parameters<ControlOperationHandler>[0], { op: "sysload" }>
  >;
  inputs: ControlOperationHandler<
    Extract<Parameters<ControlOperationHandler>[0], { op: "inputs" }>
  >;
  promptTranslate: ControlOperationHandler<
    Extract<Parameters<ControlOperationHandler>[0], { op: "promptTranslate" }>
  >;
} {
  return {
    snapshot: async (_req, { ok }) => ok(await buildDashboard(deps)),
    peek: async (req, { ok }) => {
      const snapshot = await deps.bridge.capturePaneColored(req.session, req.lines);
      ok(renderPeekPane(snapshot, deps.output));
    },
    logs: async (req, { ok }) => {
      const filter = logsArgToFilter(undefined, req.session);
      ok(filter ? formatLogsForChat(queryLogs(filter), { maxChars: 3500 }) : "no session");
    },
    sysload: async (_req, { ok }) => {
      ok(renderSystemLoad(await gatherSystemLoad(defaultSystemLoadProbes())));
    },
    inputs: async (req, { ok }) => {
      ok(
        await getRecentInputs(deps, req.session, getPathBySession(req.session) ?? req.session, 12),
      );
    },
    promptTranslate: async (req, { ok }) => {
      const status = await applyPromptTranslateCommand("control", req.arg);
      ok({ body: formatPromptTranslateCommandResult(status), status });
    },
  };
}
