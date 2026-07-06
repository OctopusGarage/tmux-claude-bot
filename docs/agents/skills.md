# Agent skills the autopilot goals rely on

Some built-in autopilot goals (`src/core/autopilot/goals/catalog.ts`) drive the
coding agent by asking it to run a **skill** — e.g. *"use your code-review skill
if one is available."* The skill lives in the **agent's** environment (Claude
Code / Codex running in the project session), **not** in this repo, so it is not
installed by `npm install` / the deploy. This file is the registry of those
skills and where to get them, so they can be installed and kept up to date.

The goal prompts are written to **degrade gracefully**: *"use your X skill if one
is available"* — if the skill is missing, the agent follows the prose steps in
the prompt instead. Installing the skill makes the goal materially better; not
installing it is not fatal.

## Registry

| Skill | Used by (goal / phase) | Source | Install / update |
|-------|------------------------|--------|------------------|
| `code-review` | `code-review` → review; `improve-architecture` (review discipline) | Bundled with Claude Code | Built in — no install. Codex has no equivalent and falls back to the goal prompt's prose. |
| `simplify` | `code-review` → simplify | Bundled with Claude Code | Built in — no install. Codex falls back to prose. |
| `improve-codebase-architecture` | `improve-architecture` → audit | [github.com/mattpocock/skills](https://github.com/mattpocock/skills) (`skills/engineering/improve-codebase-architecture/`) | Not bundled — install per below. |

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
available`), add a row to the Registry above with its source and install/update
steps in the same change — same discipline as the docs-contract. Keep the
"degrade gracefully" phrasing in the prompt so the goal still works when the
skill is absent.
