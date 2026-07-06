import { describe, expect, it, vi } from "vitest";
import { inspectAgentActivity } from "../../src/core/agents/agent-activity.js";
import type { AgentKind } from "../../src/shared/types.js";
import { fakeDeps } from "../adapters/lark/_fakes.js";

describe("inspectAgentActivity", () => {
  it("reports queue-backed busy state and live agent kind through one read model", async () => {
    const deps = fakeDeps({
      configResolver: { detectAgentKind: vi.fn(async (): Promise<AgentKind> => "codex") },
      queue: { isSessionProcessing: vi.fn(() => true) },
    });

    await expect(inspectAgentActivity(deps, "tmux_proj_app", "/repo")).resolves.toMatchObject({
      agentKind: "codex",
      agentRunning: true,
      agentBusy: true,
      pathDrifted: false,
    });
  });
});
