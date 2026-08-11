# Unified Operations Dashboard Design

## Goal

Deepen the existing Dashboard into the canonical, read-only Runtime Overview for
tmux-claude-bot. Preserve the current `DashboardSnapshot.sessions` and
`DashboardSnapshot.global` interface while adding bounded, redacted operational
health for Project Sessions, Automation Families, active Work, Guardians, Batch,
power, the Home Operator, skills, and managed MCP profiles.

The same neutral snapshot must serve CLI, Control, TUI, Telegram, Lark, Observer
MCP, Home MCP, and the Home Operator skill. Each surface chooses an appropriate
display density and capability class; surfaces do not duplicate health policy.

## Decisions

- Deepen `dashboard`; do not add a competing `overview` or `status` command.
- Preserve existing JSON fields and add new fields only.
- Default to health and attention first, followed by active Work. Healthy idle
  detail is summarized rather than enumerated.
- Keep the Dashboard read-only. It may recommend an existing command or read-only
  drill-down but must not pause, retry, repair, install, or mutate state.
- Keep durable truth in the existing domain modules. The Dashboard is a fresh
  projection, not a new state store.
- Treat partial reads as section-level degradation rather than failing the whole
  snapshot.
- Bound and sort every new collection. Preserve the complete existing `sessions`
  array for compatibility.

## Domain Language

**Runtime Overview** is the canonical read model that summarizes service health,
attention, active Work, Automation Families, Project Sessions, Operator and AI
Interfaces, and recent outcomes.

**Runtime Domain** is one authoritative operational area projected into the
Runtime Overview, such as Automation, Resource Guardian, or Operator and AI
Interfaces. It is not a generic software component.

**Attention Item** is a bounded, evidence-backed condition requiring operator
awareness. It has stable severity, source, summary, and a read-only or existing
operator next action.

**Active Work** is currently owned execution, including interactive Project
Session activity and non-terminal WorkOrders. A live session alone is not active
Work.

**Recent Outcome** is a bounded terminal result projected from durable evidence.
It is not an additional ledger or report record.

**AI Interface** is a role-scoped agent entry managed or consumed by the product:
the Home Operator Session, installed operator skills, managed MCP profiles, and
product MCP dependencies.

## Architecture

```text
authoritative modules
  Project Sessions / WorkOrder registry / task ledger / Automation config
  Batch / Runtime Guardian / Resource Guardian / service-power state
  Home Operator / AI-tool installation / MCP profile descriptors
                               |
                               v
                    Unified Dashboard module
              normalize -> redact -> classify -> bound -> sort
                               |
                               v
                    DashboardSnapshot (additive)
                               |
      CLI / Control / TUI / Telegram / Lark / Observer MCP / Home MCP
                               |
                               v
                         Home Operator skill
```

The Dashboard module has one external interface: build a snapshot from explicit
dependencies and bounded options. It may use internal collector seams so tests can
exercise domain failure and timeout behavior, but callers must not orchestrate
collectors themselves. Deleting this module would redistribute classification,
redaction, sorting, limits, and degradation behavior across every surface, so the
module earns depth.

## Snapshot Interface

The existing fields remain unchanged:

```ts
type DashboardSnapshot = {
  sessions: SessionRow[];
  global: ExistingGlobalSummary;
  generatedAt: number;
  // additive fields below
};
```

The additive overview is:

```ts
type RuntimeOverview = {
  health: {
    status: "healthy" | "attention" | "degraded";
    attentionCount: number;
    degradedDomainCount: number;
  };
  attention: BoundedSection<AttentionItem>;
  activeWork: BoundedSection<ActiveWorkItem>;
  automation: AutomationFamilyView[];
  runtimeDomains: RuntimeDomainView[];
  operator: OperatorInterfaceView;
  recentOutcomes: BoundedSection<RecentOutcome>;
};
```

Every bounded section carries `items`, `total`, `limit`, and `truncated`. Stable
identifiers and enums are machine-facing; concise labels are neutral presentation
data. Rendered prose remains outside the snapshot.

No new field may contain a personal absolute path, secret, raw command, arbitrary
exception text, chat identifier, prompt text, or unbounded artifact payload.

## Source Ownership

| Runtime Domain | Authoritative Source | Dashboard Projection |
| --- | --- | --- |
| Project Sessions | existing Dashboard session collection and Agent Activity Snapshot | existing rows plus active/idle/stopped totals |
| Active Work | WorkOrder registry and busy Project Sessions | non-terminal WorkOrders and genuinely busy interactive sessions |
| Automation Families | automation configuration module | enabled, configured, cadence, dependency readiness, active count, last outcome |
| Recent Outcomes | WorkOrder/report catalog and scheduled-task ledger | newest bounded terminal outcomes with stable status |
| Batch | Batch coordinator/store | enabled state and current run summary |
| Daily Task Audit | audit store and task ledger | last run, bounded failure/repair summary |
| Runtime Guardian | finding discovery/repair state | unresolved count and latest bounded finding summary |
| Resource Guardian | read-only Guardian store/view | pressure, circuit, mode, profile, sampling health |
| Service and Power | service/runtime metadata and power status readers | uptime, adapters, power mode/source/schedule health |
| Operator and AI Interfaces | Operator Session, AI-tool status, MCP profile descriptors, prompt MCP configuration | readiness and role/capability summary |

Collectors read core interfaces directly. They never execute or parse the text output
of another CLI command.

## Capability-To-Surface Allocation

### CLI

`tcb dashboard` is the complete human-readable local view. It renders Overall
Health, Attention, Active Work, Automation, Operator and AI Interfaces, Recent
Outcomes, then the existing Project Session detail. Additive options may narrow the
view (`--problems`, `--project`, and `--limit`) without changing the default command
or existing `--json` fields.

The CLI remains the authoritative human/script administration surface for existing
mutations such as pause/resume, MCP/skill installation, Resource Guardian mode, and
power schedule installation. The Dashboard links to those commands but never invokes
them.

### Control And TUI

The Control `snapshot` operation transports the additive snapshot without adding a
parallel operation. The TUI header displays Overall Health, attention count, active
Work count, queue, and adapter state. Its session list remains the primary navigation
surface, ordered with busy and attention-relevant rows first while preserving stable
selection. A read-only detail view shows Runtime Domains and Recent Outcomes; existing
control actions stay in their current overlays.

### Telegram And Lark

`/dashboard` renders the same snapshot with channel-appropriate presentation:

- Overall Health and counts always appear.
- Show at most three Attention Items and five Active Work items.
- Summarize healthy Automation Families and idle Project Sessions by count.
- Use existing read-only project, queue, sysload, and refresh actions for drill-down.
- Do not add pause, repair, cleanup, installation, or force actions.
- Preserve functional parity; card layout and Telegram text/keyboards may differ.

All localized copy belongs in the message catalogs. Truncation is explicit as
`+N more` and must fit the channel limit.

### Observer MCP

`tcb.observer.status` returns the unified structured snapshot with evidence and a
concise `nextSuggestedAction`. Existing projects, sessions, queue, logs, Daily Task
Audit, Runtime Guardian, and Loop reports tools remain narrow drill-down interfaces.
Unbounded tools gain validated limits and relevant filters. Observer tools remain
read-only during all conflicts.

### Home MCP

The Home profile inherits Observer status and drill-down tools. It does not add a
duplicate `tcb.home.status`. Existing prompt delivery and Autopilot delegation keep
their explicit target and control-service gates. The Dashboard does not expand Home
mutation authority.

### Home Operator Skill

The skill maps natural-language discovery to `tcb.observer.status` first, then uses
narrow Observer tools for evidence. If MCP is unavailable, it falls back to
`tcb dashboard --json` and dedicated read-only CLI commands. It may recommend or,
after explicit owner intent, invoke existing CLI/Home controls. It must not read
state files directly, parse human CLI prose, or copy health rules.

### Other MCP Classes

- Managed product profiles (`observer`, `home`) appear in Operator and AI Interface
  health with role, exposure, descriptor freshness, and tool count.
- Prompt Library MCP is a product dependency. Show disabled/configured/degraded from
  existing configuration or last-known evidence; do not spawn a server during every
  Dashboard refresh.
- Project-declared optional MCPs, such as Context7, may appear as an informational
  count/detail in AI-tool diagnostics. They do not affect bot runtime health.
- Client-private global MCP registrations, such as CodeGraph or EnglishPilot, are not
  scanned. They are not tcb-owned truth and their private configuration may contain
  secrets. The Home Operator may use tools already exposed by its current client.
- Future `tcb.supervisor.*`, `tcb.worker.*`, `tcb.guardian.*`, and `tcb.audit.*`
  namespaces remain future role-scoped work. The Dashboard must not pretend they are
  installed. Future role profiles may consume a scope-filtered read model but may not
  acquire global Home authority.

## Health Classification

Overall status is deterministic:

- `degraded` when one or more required Runtime Domains could not be read or when
  required service/interface evidence is internally inconsistent.
- `attention` when all required domains were read but at least one actionable warning,
  failure, block, closed admission circuit, or required dependency problem exists.
- `healthy` otherwise.

Optional integrations never degrade overall health merely because they are absent.
An optional integration configured but invalid may become an Attention Item if its
product feature is expected to work.

Each Attention Item includes one stable next action. Actions point to existing
read-only diagnostics or dedicated operator commands; they are not executable
Dashboard controls.

## Limits And Ordering

Defaults:

- Attention: 10 in CLI/JSON, 3 in chat.
- Active Work: 10 in CLI/JSON, 5 in chat.
- Recent Outcomes: 10 in CLI/JSON, 3 in chat.
- MCP Loop reports: default 20, maximum 100.
- MCP audit records: preserve the existing maximum of 50 and expose truncation.

Ordering is deterministic:

1. severity (`degraded`, `error`, `warning`, informational);
2. active before terminal;
3. newest evidence first;
4. stable domain/id lexical tie-break.

## Failure And Performance Behavior

- Session collection keeps its current best-effort row behavior.
- Each added Runtime Domain is independently contained and reports a stable error kind.
- No raw stack, token, command, prompt, or absolute path reaches the snapshot.
- Slow optional collectors use a bounded timeout and become degraded/informational
  according to whether the domain is required.
- Dashboard collection does not start MCP servers, run audits, dispatch repair, refresh
  schedules, or perform network access.
- Independent local reads run concurrently where their stores do not share a mutable
  transaction.
- A Control snapshot remains suitable for frequent TUI refresh; expensive history is
  read with fixed bounds and may be cached briefly only as an in-memory projection.

## Documentation And Alignment

The implementation slice updates:

- `CONTEXT.md` with Runtime Overview language;
- `docs/manual.md`, `docs/cli-reference.md`, `docs/tui.md`, and
  `docs/commands.md` for human surfaces;
- `docs/agents/usage-guide.md` and `skills/tcb-home-operator/SKILL.md` for Home
  operation;
- `docs/mcp.md` and `docs/ai-tool-surface-governance.md` for MCP allocation;
- `docs/automation-capability-matrix.md` and `docs/automation-alignment.md` for parity
  and drift enforcement.

## Verification

Tests exercise the same Dashboard interface used by callers:

- additive JSON compatibility;
- deterministic health classification and ordering;
- per-domain read failure containment;
- bounded and explicitly truncated collections;
- no personal absolute paths or secrets in structured or rendered output;
- CLI health-first rendering and filters;
- TUI header/detail rendering without selection drift;
- Telegram/Lark parity, localization, and channel limits;
- Observer/Home MCP structured status and bounded drill-down schemas;
- Home Operator skill and docs contract alignment;
- optional MCP absence versus configured dependency failure;
- complete local verification with `npm run verify:local`.

## Non-Goals

- No new durable Dashboard store.
- No generic MCP manager or scan of private global client configuration.
- No new mutation buttons, force options, repair dispatch, or automatic installation.
- No implementation of future Supervisor, Worker, Guardian, or Audit MCP namespaces.
- No removal or rename of existing commands or JSON fields.
- No direct model-provider calls.
