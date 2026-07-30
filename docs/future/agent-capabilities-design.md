# Agent Capabilities Design

## Objective

tmux-claude-bot has two execution surfaces that can ask an agent to use a skill:

- **Autopilot**: an interactive, session-level goal runner controlled by chat
  buttons, `/autopilot`, or the TUI.
- **Loop Engineering**: a scheduled, project-level maintenance runner that can
  assess, execute, verify, commit, and report.

Both surfaces need the same capability metadata: which skills are approved, where
they come from, which agent platforms they support, whether they are installed,
and which pinned version was used. That shared concern belongs in
`src/core/skills`, not under Autopilot or Loop Engineering.

## Responsibilities

### `src/core/skills`

Owns the agent capability registry.

- Parse reusable skill schema such as catalog entries and pinned approved specs.
- Resolve catalog entries from Git refs to pinned commit refs and checksums.
- Plan install/update/remove/keep/quarantine actions against installed state.
- Persist installed skill state.
- Expose small interfaces that Autopilot and Loop Engineering can consume.
- Delegate actual installation to a configured command boundary; the bot does not
  copy, symlink, or mutate agent skill files directly.

### `src/core/autopilot`

Owns interactive session goals.

- Keep agents moving when they are idle.
- Run one or more goals by injecting prompts or skill intents.
- Watch sentinels, deterministic checks, usage limits, and human gates.
- Render chat/TUI controls for goal selection and confirmation.
- Consult `src/core/skills` for skill metadata and availability, but do not own
  skill installation or GitHub refresh logic.

### `src/core/loop`

Owns scheduled project maintenance.

- Parse Loop Engineering project policy and schedules.
- Run assessment, planning, execution, verification, commit, eval, report, and
  backlog flows.
- Consume `src/core/skills` for skill refresh/sync and per-run skill hints.
- Keep scheduled project execution separate from interactive Autopilot state.

## Data Flow

Skill lifecycle:

1. A config declares `skills.catalog` entries with GitHub URL, source path, and
   tracking ref.
2. `tcb loop skills refresh <file> --write` resolves each tracking ref to a
   concrete commit SHA and checksum.
3. The pinned specs are written to `skills.approved`.
4. `tcb loop skills sync <file>` reconciles approved specs with installed state
   through `skills.applyCommand`.
5. Autopilot and Loop Engineering use the installed/pinned metadata when they
   construct prompts or reports.

Autopilot goal flow:

1. User delegates clarified work through `/autopilot [requirement]` or the supervisor delegation button.
2. The selected goal phase declares either a prompt intent or skill intent.
3. Autopilot converts the intent into an agent-facing message.
4. When skill metadata is available, the UI can show installed/missing/unsupported
   status before the goal starts.

Loop Engineering flow:

1. Scheduler determines a project is due.
2. Optional skill refresh/sync runs before project execution.
3. Assessment selects focused work.
4. The runner queues work to the active Claude Code/Codex session.
5. Verification, commit, eval, report, and backlog follow project policy.

## Boundaries

- Autopilot and Loop Engineering must not directly call model-provider APIs.
- Skill refresh pins Git refs before use; project runs must not depend on floating
  refs such as `main`, `master`, `HEAD`, or `latest`.
- Skill installation stays behind `skills.applyCommand`.
- Autopilot and Loop Engineering are separate execution modules; they share skill
  capability metadata but not runtime state.
- A normal bot install must not start autonomous code changes unless the user
  enables a goal or Loop Engineering config explicitly.

## Current Implementation

- Shared skill schema lives in `src/core/skills/schema.ts`.
- Shared skill registry and refresh/sync logic lives in
  `src/core/skills/registry.ts`.
- Loop CLI commands still expose the user-facing surface as
  `tcb loop skills list|refresh|sync`.
- Autopilot skill intents reuse the shared skill id schema/type.

## Planned Improvements

1. Add a read-only skill availability query for Loop Engineering tasks.
2. Display skill status in Loop Engineering task reports.
3. Allow goal definitions to declare optional vs required skill dependencies.
4. Let Loop Engineering optionally refresh/sync skills before scheduled runs.
5. Include skill id/ref/checksum in Loop reports and Autopilot completion notes.
