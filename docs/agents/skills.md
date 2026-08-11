# Agent skills and capability registry

Loop Engineering tasks drive the coding agent by asking it to run a **skill** — e.g.
*"use your code-review skill if one is available."* The skill lives in the
**agent's** environment (Claude Code / Codex running in the project session),
**not** in this repo, so it is not installed by `npm install` / the deploy.

The task-family capability dependency registry lives under
`src/core/capabilities`. It says which curated external skills/tools a task
family can use. The skill install/record registry lives under `src/core/skills`
and backs `tcb loop skills ...` commands.

The task prompts are written to **degrade gracefully**: *"use your X skill if one
is available"* — if the skill is missing, the agent follows the prose steps in
the prompt instead. Installing the skill makes the maintenance task materially
better; not installing it is not fatal.

## Registry

| Skill | Used by (goal / phase) | Source | Install / update |
|-------|------------------------|--------|------------------|
| `code-review` | PR review and architecture review discipline | [github.com/mattpocock/skills](https://github.com/mattpocock/skills) (`skills/engineering/code-review/`) | Not bundled — install through an explicit reviewed `skills.applyCommand`. |
| `simplify` | Optional simplification discipline when already available in the active agent | Agent-provided environment | No registry install; prompts must fall back to prose when absent. |
| `improve-codebase-architecture` | `improve-architecture` → audit | [github.com/mattpocock/skills](https://github.com/mattpocock/skills) (`skills/engineering/improve-codebase-architecture/`) | Not bundled — install per below. |
| `tdd` | `test-coverage` → execution | [github.com/mattpocock/skills](https://github.com/mattpocock/skills) (`skills/engineering/tdd/`) | Not bundled — install through an explicit reviewed `skills.applyCommand`. |

## Capability dependency commands

Use `tcb capabilities ...` to inspect the repo-maintained curated dependency
layer before running scheduled task families:

```bash
tcb capabilities list
tcb capabilities status --task architecture
tcb capabilities install --default
tcb capabilities update --default
```

`capabilities status` compares a task family's declared dependencies against the
local Loop skill registry. Recommended skills are not hard failures because
governed prompts must degrade gracefully. Required capabilities, if added later,
must block in doctor/status until installed.

`capabilities install --default` prints the approved skill metadata and next
commands. It does not silently clone or copy third-party code into Claude/Codex
directories. To apply the plan, write the approved entries into a Loop config,
set `skills.applyCommand` to a reviewed local installer, then run:

```bash
tcb loop skills sync /path/to/loop-engineering.yml
```

`capabilities update --default` prints the explicit refresh and sync path for
already curated dependencies; it also performs no installation by itself.

Restart affected Claude Code / Codex sessions after installing external skills;
agent skill discovery is session-environment dependent.

## Loop Engineering skill catalog

Loop Engineering configs can keep common remote skills in `skills.catalog`, and
the same approved entries describe capabilities Autopilot can reference from
goal skill intents. Catalog entries may track a floating Git ref such as `main`,
but project runs should use the pinned `skills.approved` entries produced by:

```bash
tcb loop skills refresh /path/to/loop-engineering.yml --write
tcb loop skills sync /path/to/loop-engineering.yml
```

`refresh` resolves each catalog entry to a concrete commit SHA and checksum, then
updates `skills.approved`. `sync` delegates the actual install/update/remove work
to `skills.applyCommand`; the bot does not copy or symlink agent skill files
itself.

Common catalog entries:

```yaml
skills:
  applyCommand: ./scripts/sync-agent-skill.sh
  catalog:
    - id: brooks-lint
      sourceUrl: https://github.com/hyhmrright/brooks-lint
      sourcePath: .
      trackingRef: main
      platforms: [claude, codex]
      tags: [architecture, audit]
      trustLevel: approved
      risk: medium
      updatePolicy: notify
    - id: improve-codebase-architecture
      sourceUrl: https://github.com/mattpocock/skills
      sourcePath: skills/engineering/improve-codebase-architecture
      trackingRef: main
      platforms: [claude, codex]
      tags: [architecture, refactor]
      trustLevel: approved
      risk: medium
      updatePolicy: notify
    - id: code-review
      sourceUrl: https://github.com/mattpocock/skills
      sourcePath: skills/engineering/code-review
      trackingRef: main
      platforms: [claude, codex]
      tags: [review, quality]
      trustLevel: approved
      risk: low
      updatePolicy: notify
    - id: production-code-audit
      sourceUrl: https://github.com/sickn33/agentic-awesome-skills
      sourcePath: skills/production-code-audit
      trackingRef: main
      platforms: [claude, codex]
      tags: [production, audit]
      trustLevel: approved
      risk: medium
      updatePolicy: notify
    - id: codebase-audit-pre-push
      sourceUrl: https://github.com/sickn33/agentic-awesome-skills
      sourcePath: skills/codebase-audit-pre-push
      trackingRef: main
      platforms: [claude, codex]
      tags: [pre-push, audit]
      trustLevel: approved
      risk: medium
      updatePolicy: notify
    - id: production-audit
      sourceUrl: https://github.com/affaan-m/everything-claude-code
      sourcePath: skills/production-audit
      trackingRef: production-audit
      platforms: [claude, codex]
      tags: [production, reliability]
      trustLevel: approved
      risk: medium
      updatePolicy: notify
```

See `docs/examples/loop-skills-catalog.example.yml` for a complete config
fragment with the six common skills and a runnable project skeleton.

## `improve-codebase-architecture` — install & update

Matt Pocock's open-source skill: scans a codebase for "deepening" opportunities
(consolidating tightly-coupled files into cohesive deep modules, improving
testability at architectural boundaries and navigability for agents), and
reports them. Recommended to run every few days.

Install into the agent's user-level skills dir (`~/.claude/skills/`):

```bash
git clone https://github.com/mattpocock/skills.git /tmp/mattpocock-skills
mkdir -p ~/.claude/skills
cp -R /tmp/mattpocock-skills/skills/engineering/improve-codebase-architecture ~/.claude/skills/
```

Update (re-pull and re-copy):

```bash
git -C /tmp/mattpocock-skills pull
cp -R /tmp/mattpocock-skills/skills/engineering/improve-codebase-architecture ~/.claude/skills/
```

Verify it is visible to Claude Code: the skill should appear in the agent's
skill list (it activates when a goal prompt mentions it, or via `/improve-codebase-architecture`
if exposed as a command).

## Adding a new skill-backed goal

When a new goal's prompt references a skill (`use your <name> skill if one is
available`), add a capability in `src/core/capabilities/catalog.ts`, add the
task-family dependency in `LOOP_TASK_FAMILY_GOVERNANCE`, add or update a row in
the Registry above, and keep the capability contract tests green in the same
change. Keep the "degrade gracefully" phrasing in the prompt so the goal still
works when the skill is absent.
