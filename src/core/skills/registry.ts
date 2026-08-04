import { spawnSync } from "node:child_process";
import { JsonMapStore } from "../infra/json-map-store.js";
import { skillChecksum } from "./checksum.js";
import {
  approvedFromCatalogEntry,
  approvedSkillSpecsEqual,
  installedFromApprovedSkill,
  installedSkillMatchesApprovedSkill,
} from "./registry-policy.js";
import type { ApprovedSkill, SkillCatalogEntry } from "./schema.js";

export type InstalledAgentSkill = {
  skillId: string;
  sourceUrl: string;
  sourcePath?: string;
  ref: string;
  checksum: string;
  platforms: Array<"claude" | "codex">;
  tags: string[];
  trustLevel: "core" | "approved" | "community";
  risk: "low" | "medium" | "high";
  updatePolicy: "manual" | "notify" | "auto-minor";
  status: "installed" | "quarantined";
  installedAt: number;
  updatedAt?: number;
};

export type AgentSkillAction = {
  action: "install" | "update" | "remove" | "keep" | "quarantine";
  skillId: string;
  reason?: string;
  spec?: ApprovedSkill;
  previous?: InstalledAgentSkill;
};

export type AgentSkillCommandRun = {
  command: string;
  cwd: string;
  env: Record<string, string>;
};

export type AgentSkillCommandResult = {
  status: number;
  stdout: string;
  stderr: string;
};

export type AgentSkillSyncSummary = {
  phase: "skill-sync";
  actions: AgentSkillAction[];
  applied: number;
  installed: InstalledAgentSkill[];
};

export type AgentSkillResolvedVersion = {
  ref: string;
  checksum: string;
};

export type AgentSkillRefreshUpdate = {
  skillId: string;
  sourceUrl: string;
  sourcePath: string;
  trackingRef: string;
  previousRef?: string;
  ref: string;
  checksum: string;
  changed: boolean;
};

export type AgentSkillRefreshSummary = {
  phase: "skill-refresh";
  refreshed: number;
  changed: number;
  approved: ApprovedSkill[];
  updates: AgentSkillRefreshUpdate[];
};

export class AgentSkillRegistryStore {
  private readonly skills = new JsonMapStore<InstalledAgentSkill>("loop_skills.json");

  set(skill: InstalledAgentSkill): void {
    this.skills.set(skill.skillId, skill);
  }

  delete(skillId: string): boolean {
    return this.skills.delete(skillId);
  }

  list(): InstalledAgentSkill[] {
    return this.skills.sortedEntries().map(([, skill]) => skill);
  }
}

function isFloatingRef(ref: string): boolean {
  return ["main", "master", "HEAD", "latest"].includes(ref);
}

export function planAgentSkillRegistryActions(input: {
  approved: ApprovedSkill[];
  installed: InstalledAgentSkill[];
}): AgentSkillAction[] {
  const approvedById = new Map(input.approved.map((skill) => [skill.id, skill]));
  const installedById = new Map(input.installed.map((skill) => [skill.skillId, skill]));
  const ids = new Set([...approvedById.keys(), ...installedById.keys()]);

  return [...ids]
    .sort((a, b) => a.localeCompare(b))
    .map((skillId): AgentSkillAction => {
      const spec = approvedById.get(skillId);
      const previous = installedById.get(skillId);
      if (spec === undefined) {
        return {
          action: "remove",
          skillId,
          reason: "skill is no longer approved",
          ...(previous !== undefined ? { previous } : {}),
        };
      }
      if (isFloatingRef(spec.ref)) {
        return {
          action: "quarantine",
          skillId,
          spec,
          reason: "floating ref is unsafe",
          ...(previous !== undefined ? { previous } : {}),
        };
      }
      if (previous === undefined) return { action: "install", skillId, spec };
      if (!installedSkillMatchesApprovedSkill(previous, spec)) {
        return { action: "update", skillId, spec, previous, reason: "approved metadata changed" };
      }
      return { action: "keep", skillId, spec, previous };
    });
}

function envForAction(action: AgentSkillAction): Record<string, string> {
  const source = action.spec ?? action.previous;
  return {
    LOOP_SKILL_ACTION: action.action,
    LOOP_SKILL_ID: action.skillId,
    LOOP_SKILL_SOURCE_URL: source?.sourceUrl ?? "",
    LOOP_SKILL_SOURCE_PATH: source?.sourcePath ?? "",
    LOOP_SKILL_REF: source?.ref ?? "",
    LOOP_SKILL_CHECKSUM: source?.checksum ?? "",
    LOOP_SKILL_PLATFORMS: source?.platforms.join(",") ?? "",
    LOOP_SKILL_TAGS: source?.tags.join(",") ?? "",
    LOOP_SKILL_TRUST_LEVEL: source?.trustLevel ?? "",
    LOOP_SKILL_RISK: source?.risk ?? "",
    LOOP_SKILL_UPDATE_POLICY: source?.updatePolicy ?? "",
  };
}

export function refreshAgentSkillCatalog(input: {
  catalog: SkillCatalogEntry[];
  approved: ApprovedSkill[];
  resolveLatest: (skill: SkillCatalogEntry) => AgentSkillResolvedVersion;
}): AgentSkillRefreshSummary {
  const approvedById = new Map(input.approved.map((skill) => [skill.id, skill]));
  const refreshedById = new Map<string, ApprovedSkill>();
  const updates: AgentSkillRefreshUpdate[] = [];

  for (const skill of input.catalog) {
    const version = input.resolveLatest(skill);
    const previous = approvedById.get(skill.id);
    const approved = approvedFromCatalogEntry(skill, version);
    const changed = previous === undefined || !approvedSkillSpecsEqual(previous, approved);
    refreshedById.set(skill.id, approved);
    updates.push({
      skillId: skill.id,
      sourceUrl: skill.sourceUrl,
      sourcePath: skill.sourcePath,
      trackingRef: skill.trackingRef,
      ...(previous !== undefined ? { previousRef: previous.ref } : {}),
      ref: approved.ref,
      checksum: approved.checksum,
      changed,
    });
  }

  const preserved = input.approved.filter((skill) => !refreshedById.has(skill.id));
  const approved = [...preserved, ...refreshedById.values()].sort((a, b) =>
    a.id.localeCompare(b.id),
  );

  return {
    phase: "skill-refresh",
    refreshed: input.catalog.length,
    changed: updates.filter((update) => update.changed).length,
    approved,
    updates,
  };
}

export function resolveLatestGitSkill(skill: SkillCatalogEntry): AgentSkillResolvedVersion {
  const result = spawnSync("git", ["ls-remote", skill.sourceUrl, skill.trackingRef], {
    encoding: "utf8",
  });
  if ((result.status ?? 1) !== 0) {
    const message =
      result.stderr || result.error?.message || result.stdout || "git ls-remote failed";
    throw new Error(`failed to resolve skill "${skill.id}" from ${skill.sourceUrl}: ${message}`);
  }
  const line = result.stdout
    .split("\n")
    .map((entry) => entry.trim())
    .find(Boolean);
  const ref = line?.split(/\s+/)[0];
  if (ref === undefined || !/^[0-9a-f]{40}$/i.test(ref)) {
    throw new Error(
      `failed to resolve skill "${skill.id}" tracking ref "${skill.trackingRef}" to a commit SHA`,
    );
  }
  return {
    ref,
    checksum: skillChecksum({
      id: skill.id,
      sourceUrl: skill.sourceUrl,
      sourcePath: skill.sourcePath,
      ref,
    }),
  };
}

function applyExternalCommand(input: {
  action: AgentSkillAction;
  applyCommand: string;
  runCommand: (run: AgentSkillCommandRun) => AgentSkillCommandResult;
}): void {
  const result = input.runCommand({
    command: input.applyCommand,
    cwd: process.cwd(),
    env: envForAction(input.action),
  });
  if (result.status !== 0) {
    const output = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
    throw new Error(
      `loop skills apply command failed for ${input.action.action} "${input.action.skillId}"${
        output ? `: ${output}` : ""
      }`,
    );
  }
}

export function applyAgentSkillRegistryActions(input: {
  approved: ApprovedSkill[];
  store: AgentSkillRegistryStore;
  applyCommand?: string;
  now: number;
  runCommand: (run: AgentSkillCommandRun) => AgentSkillCommandResult;
}): AgentSkillSyncSummary {
  const actions = planAgentSkillRegistryActions({
    approved: input.approved,
    installed: input.store.list(),
  });
  let applied = 0;

  for (const action of actions) {
    if (action.action === "keep") continue;
    if (action.action === "quarantine") {
      if (action.spec !== undefined) {
        input.store.set(
          installedFromApprovedSkill(action.spec, input.now, action.previous, "quarantined"),
        );
      }
      applied++;
      continue;
    }
    if (input.applyCommand === undefined) {
      throw new Error(
        `loop skills applyCommand is required for ${action.action} "${action.skillId}"`,
      );
    }
    applyExternalCommand({
      action,
      applyCommand: input.applyCommand,
      runCommand: input.runCommand,
    });
    if (action.action === "remove") {
      input.store.delete(action.skillId);
    } else if (action.spec !== undefined) {
      input.store.set(installedFromApprovedSkill(action.spec, input.now, action.previous));
    }
    applied++;
  }

  return {
    phase: "skill-sync",
    actions,
    applied,
    installed: input.store.list(),
  };
}

export function listAgentSkills(store = new AgentSkillRegistryStore()): InstalledAgentSkill[] {
  return store.list();
}
