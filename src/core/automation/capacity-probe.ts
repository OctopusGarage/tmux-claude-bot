import type { ConfigResolver } from "../agents/agent-config-resolver.js";
import { resolveCodexApiInfo } from "../agents/codex/codex-usage.js";
import { profileFor } from "../agents/registry.js";
import type { AgentKind } from "../agents/types.js";
import type { UsageSnapshot } from "../read/usage.js";
import {
  type AgentAuthenticationCategory,
  type AgentCapacityObservation,
  deriveAgentCapacity,
} from "./capacity.js";

type CapacityProbeInput = {
  agent: AgentKind;
  session: string;
  projectPath: string;
  resolver: ConfigResolver;
  now: number;
  resolveAuthentication?: () => Promise<AgentAuthenticationCategory>;
  readUsage?: (resolver: ConfigResolver) => Promise<UsageSnapshot | null>;
};

async function resolverForCapacityProbe(
  agent: AgentKind,
  session: string,
  resolver: ConfigResolver,
): Promise<ConfigResolver> {
  if (agent !== "codex") return resolver;
  const configuredHome = await resolver.resolveCodexHome?.(session);
  if (configuredHome) return resolver;
  if (!(await resolver.isCodexRunning(session))) return resolver;

  // A normal Codex install leaves CODEX_HOME unset and uses ~/.codex. The
  // process probe proves that this is a live Codex session, so using the
  // profile-owned default here does not attribute an idle user's history.
  const withDefaultHome = Object.create(resolver) as ConfigResolver;
  withDefaultHome.resolveCodexHome = async () => profileFor("codex").defaultConfigRoot;
  return withDefaultHome;
}

async function authenticationFor(
  agent: AgentKind,
  session: string,
  resolver: ConfigResolver,
): Promise<AgentAuthenticationCategory> {
  if (agent === "claude") {
    const info = await resolver.resolveApiInfo?.(session);
    return info?.mode === "api"
      ? "usage-based"
      : info?.mode === "subscription"
        ? "subscription"
        : "unknown";
  }
  const home = await resolver.resolveCodexHome?.(session);
  if (home === null || home === undefined) return "unknown";
  const info = await resolveCodexApiInfo(home);
  return info?.mode === "api"
    ? "usage-based"
    : info?.mode === "subscription"
      ? "subscription"
      : "unknown";
}

/** Observe capacity from the already running agent's local auth and transcript data. */
export async function observeAgentCapacity(
  input: CapacityProbeInput,
): Promise<AgentCapacityObservation> {
  let resolver = input.resolver;
  try {
    resolver = await resolverForCapacityProbe(input.agent, input.session, input.resolver);
  } catch {
    resolver = input.resolver;
  }

  let authentication: AgentAuthenticationCategory = "unknown";
  try {
    authentication = input.resolveAuthentication
      ? await input.resolveAuthentication()
      : await authenticationFor(input.agent, input.session, resolver);
  } catch {
    authentication = "unknown";
  }

  let usage: UsageSnapshot | null = null;
  try {
    usage = input.readUsage
      ? await input.readUsage(resolver)
      : await profileFor(input.agent).readUsage(resolver, input.session, input.projectPath);
  } catch {
    usage = null;
  }
  return deriveAgentCapacity({
    agent: input.agent,
    authentication,
    now: input.now,
    usage,
  });
}
