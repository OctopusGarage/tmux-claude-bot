import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AgentSkillCommandRun,
  AgentSkillRegistryStore,
  applyAgentSkillRegistryActions,
  type InstalledAgentSkill,
  listAgentSkills,
  planAgentSkillRegistryActions,
  refreshAgentSkillCatalog,
  resolveLatestGitSkill,
} from "../../src/core/skills/registry.js";
import type { ApprovedSkill } from "../../src/core/skills/schema.js";

const approvedSkill = {
  id: "improve-codebase-architecture",
  sourceUrl: "https://github.com/mattpocock/skills",
  sourcePath: "skills/engineering/improve-codebase-architecture",
  ref: "2f3c4d5e6a",
  checksum: "sha256:abc",
  platforms: ["claude", "codex"],
  tags: ["architecture"],
  trustLevel: "approved",
  risk: "medium",
  updatePolicy: "notify",
} satisfies ApprovedSkill;

const originalStateDir = process.env.TCB_STATE_DIR;

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
  else process.env.TCB_STATE_DIR = originalStateDir;
});

function installed(overrides: Partial<InstalledAgentSkill> = {}): InstalledAgentSkill {
  return {
    skillId: approvedSkill.id,
    sourceUrl: approvedSkill.sourceUrl,
    sourcePath: approvedSkill.sourcePath,
    ref: approvedSkill.ref,
    checksum: approvedSkill.checksum,
    platforms: approvedSkill.platforms,
    tags: approvedSkill.tags,
    trustLevel: approvedSkill.trustLevel,
    risk: approvedSkill.risk,
    updatePolicy: approvedSkill.updatePolicy,
    status: "installed",
    installedAt: 1,
    ...overrides,
  };
}

describe("planAgentSkillRegistryActions", () => {
  it("plans install, update, keep, and remove actions from approved specs and installed state", () => {
    const changedSkill = { ...approvedSkill, id: "changed", checksum: "sha256:new" };
    const installedChanged = installed({
      skillId: "changed",
      checksum: "sha256:old",
    });
    const removedSkill = installed({
      skillId: "removed",
      sourceUrl: "https://example.com/removed",
      sourcePath: "skills/removed",
      checksum: "sha256:removed",
    });

    const actions = planAgentSkillRegistryActions({
      approved: [approvedSkill, changedSkill, { ...approvedSkill, id: "new" }],
      installed: [installed(), installedChanged, removedSkill],
    });

    expect(actions.map((action) => [action.skillId, action.action])).toEqual([
      ["changed", "update"],
      ["improve-codebase-architecture", "keep"],
      ["new", "install"],
      ["removed", "remove"],
    ]);
  });

  it("quarantines approved skills that still use floating refs", () => {
    const actions = planAgentSkillRegistryActions({
      approved: [{ ...approvedSkill, ref: "main" }],
      installed: [],
    });

    expect(actions).toEqual([
      expect.objectContaining({
        action: "quarantine",
        skillId: "improve-codebase-architecture",
        reason: "floating ref is unsafe",
      }),
    ]);
  });

  it("plans an update when approved metadata changes without changing content pins", () => {
    const actions = planAgentSkillRegistryActions({
      approved: [{ ...approvedSkill, risk: "high", tags: ["architecture", "audit"] }],
      installed: [installed()],
    });

    expect(actions).toEqual([
      expect.objectContaining({
        action: "update",
        skillId: "improve-codebase-architecture",
        reason: "approved metadata changed",
      }),
    ]);
  });
});

describe("applyAgentSkillRegistryActions", () => {
  it("delegates install/update/remove actions to the configured command and persists state", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-loop-skills-"));
    process.env.TCB_STATE_DIR = stateDir;
    const store = new AgentSkillRegistryStore();
    store.set(installed({ skillId: "removed", sourcePath: "skills/removed" }));
    const runs: AgentSkillCommandRun[] = [];

    const summary = applyAgentSkillRegistryActions({
      approved: [approvedSkill],
      store,
      applyCommand: "sync-loop-skill",
      now: 1_234,
      runCommand: (run) => {
        runs.push(run);
        return { status: 0, stdout: "ok", stderr: "" };
      },
    });

    expect(summary.actions.map((action) => [action.skillId, action.action])).toEqual([
      ["improve-codebase-architecture", "install"],
      ["removed", "remove"],
    ]);
    expect(
      runs.map((run) => [
        run.command,
        run.env.LOOP_SKILL_ACTION,
        run.env.LOOP_SKILL_ID,
        run.env.LOOP_SKILL_SOURCE_PATH,
      ]),
    ).toEqual([
      [
        "sync-loop-skill",
        "install",
        "improve-codebase-architecture",
        "skills/engineering/improve-codebase-architecture",
      ],
      ["sync-loop-skill", "remove", "removed", "skills/removed"],
    ]);
    expect(listAgentSkills(store)).toEqual([
      expect.objectContaining({
        skillId: "improve-codebase-architecture",
        status: "installed",
        installedAt: 1_234,
      }),
    ]);
  });

  it("does not invoke the apply command for keep actions", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-loop-skills-"));
    process.env.TCB_STATE_DIR = stateDir;
    const store = new AgentSkillRegistryStore();
    store.set(installed());
    const runs: AgentSkillCommandRun[] = [];

    const summary = applyAgentSkillRegistryActions({
      approved: [approvedSkill],
      store,
      applyCommand: "sync-loop-skill",
      now: 1_234,
      runCommand: (run) => {
        runs.push(run);
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    expect(summary.actions).toEqual([
      expect.objectContaining({ action: "keep", skillId: "improve-codebase-architecture" }),
    ]);
    expect(summary.applied).toBe(0);
    expect(runs).toEqual([]);
  });

  it("requires an apply command for install/update/remove actions", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-loop-skills-"));
    process.env.TCB_STATE_DIR = stateDir;

    expect(() =>
      applyAgentSkillRegistryActions({
        approved: [approvedSkill],
        store: new AgentSkillRegistryStore(),
        now: 1_234,
        runCommand: () => ({ status: 0, stdout: "", stderr: "" }),
      }),
    ).toThrow(/applyCommand is required/i);
  });

  it("surfaces apply command failures with action and skill context", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-loop-skills-"));
    process.env.TCB_STATE_DIR = stateDir;

    expect(() =>
      applyAgentSkillRegistryActions({
        approved: [approvedSkill],
        store: new AgentSkillRegistryStore(),
        applyCommand: "sync-loop-skill",
        now: 1_234,
        runCommand: () => ({ status: 42, stdout: "stdout detail", stderr: "stderr detail" }),
      }),
    ).toThrow(/failed for install "improve-codebase-architecture": stderr detail\nstdout detail/i);
  });

  it("quarantines floating refs locally without requiring the external apply command", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-loop-skills-"));
    process.env.TCB_STATE_DIR = stateDir;
    const store = new AgentSkillRegistryStore();
    store.set(installed({ ref: "old-pin", installedAt: 100 }));

    const summary = applyAgentSkillRegistryActions({
      approved: [{ ...approvedSkill, ref: "latest" }],
      store,
      now: 1_234,
      runCommand: () => {
        throw new Error("quarantine must not run external commands");
      },
    });

    expect(summary.actions).toEqual([
      expect.objectContaining({
        action: "quarantine",
        skillId: "improve-codebase-architecture",
        reason: "floating ref is unsafe",
      }),
    ]);
    expect(summary.applied).toBe(1);
    expect(listAgentSkills(store)).toEqual([
      expect.objectContaining({
        skillId: "improve-codebase-architecture",
        ref: "latest",
        status: "quarantined",
        installedAt: 100,
        updatedAt: 1_234,
      }),
    ]);
  });
});

describe("refreshAgentSkillCatalog", () => {
  it("resolves catalog entries into pinned approved skill specs and preserves custom approved skills", () => {
    const customSkill = {
      ...approvedSkill,
      id: "custom-local-skill",
      sourceUrl: "https://example.com/custom",
      sourcePath: "skills/custom-local-skill",
      ref: "1111111",
      checksum: "sha256:custom",
    } satisfies ApprovedSkill;

    const summary = refreshAgentSkillCatalog({
      catalog: [
        {
          id: "improve-codebase-architecture",
          sourceUrl: "https://github.com/mattpocock/skills",
          sourcePath: "skills/engineering/improve-codebase-architecture",
          trackingRef: "main",
          platforms: ["claude", "codex"],
          tags: ["architecture"],
          trustLevel: "approved",
          risk: "medium",
          updatePolicy: "notify",
        },
      ],
      approved: [{ ...approvedSkill, ref: "old-ref", checksum: "sha256:old" }, customSkill],
      resolveLatest: (skill) => ({
        ref: `resolved-${skill.trackingRef}`,
        checksum: `sha256:${skill.id}`,
      }),
    });

    expect(summary.refreshed).toBe(1);
    expect(summary.changed).toBe(1);
    expect(summary.updates).toEqual([
      expect.objectContaining({
        skillId: "improve-codebase-architecture",
        previousRef: "old-ref",
        ref: "resolved-main",
        changed: true,
      }),
    ]);
    expect(summary.approved.map((skill) => [skill.id, skill.ref, skill.checksum])).toEqual([
      ["custom-local-skill", "1111111", "sha256:custom"],
      ["improve-codebase-architecture", "resolved-main", "sha256:improve-codebase-architecture"],
    ]);
  });

  it("marks catalog refresh changed when non-pin metadata changes", () => {
    const summary = refreshAgentSkillCatalog({
      catalog: [
        {
          id: "improve-codebase-architecture",
          sourceUrl: approvedSkill.sourceUrl,
          sourcePath: approvedSkill.sourcePath,
          trackingRef: "main",
          platforms: ["codex"],
          tags: ["architecture", "audit"],
          trustLevel: "approved",
          risk: "high",
          updatePolicy: "auto-minor",
        },
      ],
      approved: [approvedSkill],
      resolveLatest: () => ({
        ref: approvedSkill.ref,
        checksum: approvedSkill.checksum,
      }),
    });

    expect(summary.changed).toBe(1);
    expect(summary.updates).toEqual([
      expect.objectContaining({
        skillId: "improve-codebase-architecture",
        changed: true,
      }),
    ]);
  });

  it("keeps catalog refresh stable when the resolved approved spec is unchanged", () => {
    const summary = refreshAgentSkillCatalog({
      catalog: [
        {
          id: approvedSkill.id,
          sourceUrl: approvedSkill.sourceUrl,
          sourcePath: approvedSkill.sourcePath,
          trackingRef: "main",
          platforms: approvedSkill.platforms,
          tags: approvedSkill.tags,
          trustLevel: approvedSkill.trustLevel,
          risk: approvedSkill.risk,
          updatePolicy: approvedSkill.updatePolicy,
        },
      ],
      approved: [approvedSkill],
      resolveLatest: () => ({
        ref: approvedSkill.ref,
        checksum: approvedSkill.checksum,
      }),
    });

    expect(summary.changed).toBe(0);
    expect(summary.updates).toEqual([
      expect.objectContaining({
        skillId: "improve-codebase-architecture",
        previousRef: approvedSkill.ref,
        changed: false,
      }),
    ]);
    expect(summary.approved).toEqual([approvedSkill]);
  });
});

describe("resolveLatestGitSkill", () => {
  it("resolves a tracking ref to a commit SHA and deterministic checksum", () => {
    const binDir = mkdtempSync(join(tmpdir(), "tcb-fake-git-"));
    const git = join(binDir, "git");
    writeFileSync(
      git,
      `#!/bin/sh
if [ "$1" = "ls-remote" ]; then
  printf '%s\\trefs/heads/main\\n' '1234567890abcdef1234567890abcdef12345678'
  exit 0
fi
exit 1
`,
    );
    chmodSync(git, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
    try {
      const result = resolveLatestGitSkill({
        id: "improve-codebase-architecture",
        sourceUrl: "https://github.com/mattpocock/skills",
        sourcePath: "skills/engineering/improve-codebase-architecture",
        trackingRef: "main",
        platforms: ["claude", "codex"],
        tags: ["architecture"],
        trustLevel: "approved",
        risk: "medium",
        updatePolicy: "notify",
      });

      expect(result).toEqual({
        ref: "1234567890abcdef1234567890abcdef12345678",
        checksum: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      });
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });

  it("rejects git refs that do not resolve to a commit SHA", () => {
    const binDir = mkdtempSync(join(tmpdir(), "tcb-fake-git-"));
    const git = join(binDir, "git");
    writeFileSync(
      git,
      `#!/bin/sh
printf '%s\\trefs/heads/main\\n' 'not-a-sha'
`,
    );
    chmodSync(git, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
    try {
      expect(() =>
        resolveLatestGitSkill({
          id: "bad-skill",
          sourceUrl: "https://example.com/repo",
          sourcePath: "skills/bad",
          trackingRef: "main",
          platforms: ["claude"],
          tags: [],
          trustLevel: "community",
          risk: "high",
          updatePolicy: "manual",
        }),
      ).toThrow(/to a commit SHA/i);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });

  it("reports git ls-remote failures with stderr context", () => {
    const binDir = mkdtempSync(join(tmpdir(), "tcb-fake-git-"));
    const git = join(binDir, "git");
    writeFileSync(
      git,
      `#!/bin/sh
printf '%s\\n' 'remote rejected ref' >&2
exit 128
`,
    );
    chmodSync(git, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
    try {
      expect(() =>
        resolveLatestGitSkill({
          id: "bad-skill",
          sourceUrl: "https://example.com/repo",
          sourcePath: "skills/bad",
          trackingRef: "main",
          platforms: ["claude"],
          tags: [],
          trustLevel: "community",
          risk: "high",
          updatePolicy: "manual",
        }),
      ).toThrow(
        /failed to resolve skill "bad-skill" from https:\/\/example.com\/repo: remote rejected ref/i,
      );
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });
});
