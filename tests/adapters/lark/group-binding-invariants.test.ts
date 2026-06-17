import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import {
  bindCurrentGroupBySid,
  handleBind,
  handleUnbind,
} from "../../../src/adapters/lark/group-commands.js";
import { listBindings, unbindGroup } from "../../../src/core/projects/group-bindings.js";
import { appendRecentProject } from "../../../src/core/projects/recentProjects.js";
import { sessionNameFromPath } from "../../../src/core/projects/sessionPathMap.js";
import { sessionShortId } from "../../../src/shared/utils/hash.js";
import { fakeChannel, fakeDeps } from "./_fakes.js";

/**
 * Property-based invariant test for the group-binding state machine. Random
 * sequences of bind / rebind / unbind across a small pool of groups and projects
 * are applied to the REAL handlers; after every step the core invariant must
 * hold:
 *
 *   one workspace ↔ one group — no two groups are ever bound to the same session.
 *
 * This is the class of bug a unit test misses: the guard was on the create path
 * but not the (re)bind path, so two groups could end up driving one session.
 * Fuzzing the operation order surfaces such asymmetries without us having to
 * hand-pick the breaking sequence.
 */
describe("group-binding invariants (property-based)", () => {
  const PREFIX = "tmux_proj_";
  const GROUPS = ["oc_g0", "oc_g1", "oc_g2"];
  let root: string;
  let projects: { path: string; sid: string }[];
  let deps: ReturnType<typeof fakeDeps>;
  const channel = fakeChannel();

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "tcb-inv-"));
    projects = ["alpha", "beta", "gamma"].map((name) => {
      const path = mkdtempSync(join(root, `${name}-`));
      return { path, sid: sessionShortId(sessionNameFromPath(path, PREFIX)) };
    });
    deps = fakeDeps({ config: { cdAllowedDirs: [root] } });
    for (const p of projects) await appendRecentProject(p.path, PREFIX);
  });

  it("no two groups ever share a session, under any bind/rebind/unbind order", async () => {
    const opArb = fc.record({
      kind: fc.constantFrom("bind", "rebind", "unbind"),
      group: fc.integer({ min: 0, max: GROUPS.length - 1 }),
      proj: fc.integer({ min: 0, max: 2 }),
    });

    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 12 }), async (ops) => {
        // Isolate each generated sequence: start from an empty binding store.
        for (const { chatId } of listBindings()) unbindGroup(chatId);

        for (const op of ops) {
          const chatId = GROUPS[op.group]!;
          if (op.kind === "bind") {
            await handleBind(channel, deps, chatId, "group", projects[op.proj]!.path);
          } else if (op.kind === "rebind") {
            await bindCurrentGroupBySid(channel, deps, chatId, projects[op.proj]!.sid);
          } else {
            await handleUnbind(channel, deps, chatId, "group");
          }

          const sessions = listBindings().map((b) => b.binding.sessionName);
          expect(new Set(sessions).size, `dup session after ${JSON.stringify(op)}`).toBe(
            sessions.length,
          );
        }
      }),
      { numRuns: 60 },
    );
  }, 30_000); // each op does real atomic-file writes; give the fuzz run headroom
});
