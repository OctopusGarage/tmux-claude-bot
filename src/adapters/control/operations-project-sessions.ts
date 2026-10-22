import { join } from "node:path";
import { setAgentKind } from "../../core/agents/agentKindMap.js";
import { orphanBusyState, orphanLabel } from "../../core/agents/takeover.js";
import {
  adoptOrphan,
  composeAdoptOutcome,
  findAdoptableOrphans,
} from "../../core/agents/takeover-service.js";
import { performStart } from "../../core/command/dispatch.js";
import type { HandlerDeps } from "../../core/deps.js";
import { isLoopWorkerSessionName } from "../../core/projects/operator.js";
import {
  createProjectFromPath,
  openRecentProjectBySid,
  recentProjectButtons,
  resolveProjectPath,
} from "../../core/projects/project-ops.js";
import { getPathBySession, setPathForSession } from "../../core/projects/sessionPathMap.js";
import { recoverProjects } from "../../core/recovery/recover.js";
import { appStateDir } from "../../shared/state-dir.js";
import type { AgentKind } from "../../shared/types.js";
import type { ControlOperationHandlers } from "./operations-types.js";

const CONTROL_SCOPE = "control";

function commandForAgent(deps: HandlerDeps, agent: AgentKind | undefined): string | undefined {
  if (agent === undefined) return undefined;
  return (
    deps.config.startCommands.find((command) => command.agent === agent)?.command ??
    (agent === "claude" ? deps.config.claudeStartCommand : undefined)
  );
}

async function startRequestedAgent(
  deps: HandlerDeps,
  sessionName: string,
  agent: AgentKind | undefined,
): Promise<"started" | "already-running"> {
  const command = commandForAgent(deps, agent);
  if (agent !== undefined && command === undefined)
    throw new Error(`no start command is configured for agent: ${agent}`);
  return await performStart(deps, sessionName, command);
}

/** Project Session lifecycle handlers for the local Control adapter. */
export function createControlProjectSessionHandlers(
  deps: HandlerDeps,
): Pick<
  ControlOperationHandlers,
  "projects" | "open" | "openPath" | "openWorker" | "orphans" | "adopt" | "recover"
> {
  return {
    projects: async (_req, { ok }) => ok(await recentProjectButtons(deps, CONTROL_SCOPE)),
    open: async (req, { ok }) => {
      const res = await openRecentProjectBySid(deps, CONTROL_SCOPE, req.sid);
      if (res.status === "created" || res.status === "switched") {
        const started = await startRequestedAgent(deps, res.sessionName, req.agent);
        ok({ status: res.status, session: res.sessionName, started });
      } else ok(res);
    },
    openPath: async (req, { ok }) => {
      const res = await createProjectFromPath(deps, CONTROL_SCOPE, req.path);
      if (res.status === "created" || res.status === "switched") {
        const started = await startRequestedAgent(deps, res.sessionName, req.agent);
        ok({ status: res.status, session: res.sessionName, started });
      } else ok(res);
    },
    openWorker: async (req, { ok }) => {
      if (!isLoopWorkerSessionName(req.session, deps.config.projectSessionPrefix)) {
        ok({
          status: "invalid",
          error: "invalid-worker-session",
          message: `worker session must match ${deps.config.projectSessionPrefix}loop-worker-*`,
        });
        return;
      }
      const resolved = await resolveProjectPath(req.path, [
        ...deps.config.cdAllowedDirs,
        join(appStateDir(), "loop-worktrees"),
      ]);
      if (resolved.error !== undefined) {
        ok({ status: "invalid", error: resolved.error, resolvedPath: resolved.resolvedPath });
        return;
      }
      const mapped = getPathBySession(req.session);
      const live = await deps.bridge.hasSession(req.session);
      if (live && mapped !== null && mapped !== resolved.resolvedPath) {
        ok({
          status: "error",
          message: `worker session ${req.session} is already mapped to ${mapped}`,
        });
        return;
      }
      if (!live) await deps.bridge.createSession(req.session, resolved.resolvedPath);
      setPathForSession(req.session, resolved.resolvedPath);
      if (req.agent !== undefined) {
        setAgentKind(req.session, req.agent);
        deps.configResolver.invalidate(req.session);
      }
      const started = await startRequestedAgent(deps, req.session, req.agent);
      ok({
        status: live ? "switched" : "created",
        session: req.session,
        started,
        resolvedPath: resolved.resolvedPath,
      });
    },
    orphans: async (_req, { ok }) => {
      const orphans = await findAdoptableOrphans();
      ok(
        orphans.map((orphan) => ({
          pid: orphan.pid,
          agent: orphan.agent,
          busy: orphanBusyState(orphan),
          label: orphanLabel(orphan),
        })),
      );
    },
    adopt: async (req, { ok }) => {
      const result = await adoptOrphan(req.pid, {
        bridge: deps.bridge,
        configResolver: deps.configResolver,
        projectSessionPrefix: deps.config.projectSessionPrefix,
        warmupMs: deps.config.sessionWarmupMs,
      });
      const outcome = composeAdoptOutcome(result, CONTROL_SCOPE);
      if (outcome.ok) await deps.currentProject.set(CONTROL_SCOPE, outcome.sessionName);
      ok({
        ok: outcome.ok,
        body: outcome.body,
        ...(outcome.ok ? { session: outcome.sessionName } : {}),
      });
    },
    recover: async (_req, { ok }) => {
      const recovered = await recoverProjects(deps);
      ok({
        launched: recovered.launched.length,
        shellOnly: recovered.shellOnly.length,
        alreadyAlive: recovered.alreadyAlive.length,
      });
    },
  };
}
