# Resource Guardian Design

## Goal

Protect the operator's machine from sustained CPU pressure caused or amplified
by tmux-claude-bot automation. The system must detect pressure, explain its
cause, stop new background work, safely reduce bot-owned load, recover without
oscillation, and delegate at most one bounded repair after the machine is
stable.

The protection must preserve ordinary interactive chat, must never terminate
an external or ambiguously owned process, and must not create a repair worker
while the machine is still under pressure.

## Context

The repository already has several useful but separate capabilities:

- `gatherSystemLoad` and `renderSystemLoad` provide an operator-triggered
  diagnostic snapshot.
- Loop Engineering, Daily Task Audit, Runtime Guardian, Autopilot delegation,
  and the Batch Scheduler each have local scheduling or concurrency rules.
- `tcb automation pause` persists configuration changes for future process
  configuration.
- WorkOrders, supervisor sessions, worker leases, and repair admission provide
  durable ownership and recovery evidence.

These capabilities do not form a machine-wide control loop. In particular,
configuration-backed automation pause does not stop timers that a running bot
already created from its loaded configuration. There is no shared runtime
admission decision before all background work, no sustained-pressure state
machine, and no central place that relates a hot process to a tmux session,
WorkOrder, or worker lease.

The missing mechanism is therefore not another diagnostic command. It is a
deep Resource Guardian module with a small interface and a durable runtime
circuit consumed by every background automation path.

## Scope

The first implementation covers:

- host CPU pressure, load average, thermal pressure, and bot event-loop lag;
- lightweight continuous sampling and pressure-triggered deep inspection;
- runtime admission for bot-owned background automation;
- process ownership attribution using process, tmux, session, WorkOrder, and
  lease evidence;
- deterministic cleanup of terminal or stale bot-owned work;
- cooperative preemption of a proven bot-owned background WorkOrder during a
  sustained emergency;
- bounded incident evidence, deduplicated notifications, and operator status;
- delayed, deduplicated repair through the existing active-agent WorkOrder
  path.

The first implementation does not cover:

- terminating external or ambiguously owned processes;
- managing arbitrary applications such as browsers, Docker, or IDEs;
- memory, disk, network, battery, or cloud quota enforcement;
- replacing Runtime Guardian or the Repair Coordinator;
- introducing a model-provider client;
- introducing a second always-running operating-system watchdog.

Memory and disk pressure can be added later as new signals behind the same
interface if real incidents justify them.

## Architectural Decision

Add an in-process `Resource Guardian` module and a file-backed `Resource
Circuit`. Keep an optional external watchdog as a future adapter, not part of
the initial implementation.

Do not extend Runtime Guardian. Runtime Guardian owns bot runtime artifacts and
repair findings. Resource Guardian owns machine pressure, runtime admission,
and process-load attribution. Keeping these responsibilities separate prevents
a pressure detector from immediately creating more pressure through a repair
worker.

The Resource Guardian external interface is intentionally small:

```ts
type StopResourceGuardian = () => void;

function startResourceGuardian(deps: ResourceGuardianDeps): StopResourceGuardian;

function admitResourceWork(input: ResourceAdmissionInput): ResourceAdmission;

function readResourceGuardianView(): ResourceGuardianView;
```

Callers and tests use these interfaces. Sampling, state transitions, process
graphs, ownership proof, persistence, notifications, and actions remain behind
the module interface as internal seams.

Deleting this module would spread pressure policy and safety checks across at
least Loop Engineering, Daily Task Audit, Runtime Guardian repair, Autopilot,
and Batch scheduling. The module therefore earns its keep through leverage and
locality rather than acting as a pass-through.

## Domain Model

The design introduces the following canonical terms:

- **Resource Sample**: one time-stamped, normalized view of machine pressure.
- **Pressure State**: `healthy`, `elevated`, `critical`, `emergency`, or
  `recovering`.
- **Resource Circuit**: durable runtime admission state owned by Resource
  Guardian. It is separate from operator configuration.
- **Resource Admission**: an allow or deny decision for one attempt to start
  work, including the reason and incident id.
- **Ownership Evidence**: facts that connect a process instance to the bot and
  to durable automation state.
- **Resource Incident**: the bounded evidence and action timeline for one
  continuous pressure episode.
- **Resource Recovery**: the stable period after pressure falls but before
  background admission and repair are restored.

`Runtime Guardian` remains the term for runtime-artifact integrity and
self-healing. `Resource Guardian` must not be shortened to Guardian in
maintained documentation where the meaning would be ambiguous.

## Data Flow

```text
lightweight sample
        |
        v
pressure policy -----> bounded incident evidence -----> notification
        |
        v
resource circuit
        |
        v
shared admission seam
        +-- Loop Engineering
        +-- Daily Task Audit
        +-- Runtime Guardian repair
        +-- Autopilot delegation
        +-- Batch Scheduler
        |
        v
pressure-triggered ownership inspection
        +-- external or unknown: explain only
        +-- valid bot work: preserve or cooperatively preempt
        +-- terminal or stale bot work: deterministic cleanup
        |
        v
stable recovery window
        |
        v
deterministic repair, then at most one repair WorkOrder if still needed
```

The circuit must close before any new session, WorkOrder, queue lease, worker
lease, or child process is created. A denied admission is an expected deferred
outcome, not a task failure and not a retry attempt.

## Resource Sampling

### Lightweight sampling

The normal tick interval is 15 seconds. The lightweight sampler uses process-
local and operating-system counters that do not spawn `top` on every tick:

- host CPU busy percentage calculated from deltas between CPU time snapshots;
- normalized one-, five-, and fifteen-minute load averages;
- bot event-loop lag;
- thermal pressure when the platform exposes it.

Host CPU busy percentage is the primary CPU signal. `loadavg / cores` is only
supporting evidence because load average is delayed and can include runnable or
uninterruptible work that is not equivalent to CPU utilization.

### Deep inspection

Deep process inspection runs only when one of these conditions is true:

- two consecutive lightweight samples exceed the elevated threshold;
- thermal pressure is reported;
- the operator requests a detailed status view;
- Resource Guardian is reconciling an existing critical or emergency incident.

Deep inspection collects PID, parent PID, process-group id, start time, CPU,
resident memory, command, and working directory where the platform exposes
them. It also reads tmux pane PIDs, automation session records, WorkOrder state,
and worker leases. Deep inspection is rate-limited to at most once per 30
seconds during a continuous incident.

The existing manual system-load view should reuse the normalized snapshot and
rendering data rather than creating an independent pressure policy.

## Pressure State Machine

The initial balanced profile uses these defaults:

| State | Entry condition | Minimum duration | Admission effect |
| --- | --- | ---: | --- |
| `healthy` | Host CPU below 80% and no thermal pressure | — | Normal |
| `elevated` | Host CPU at least 80% | 60 seconds | Deny new heavy background work |
| `critical` | Host CPU at least 92% | 90 seconds | Deny all new background work |
| `emergency` | Host CPU at least 97%, or severe thermal pressure | 180 seconds for CPU; two samples for thermal | Keep background circuit closed and reduce proven bot-owned load |
| `recovering` | Host CPU below 65% after `critical` or `emergency` | 5 minutes | Keep background circuit closed |
| `healthy` | Recovery remains below 65% | 5 additional minutes | Reopen Guardian-owned circuit |

State transitions use elapsed time, not a fixed count alone, so delayed ticks
do not accidentally shorten the required observation window. A higher state
can be entered directly when its own sustained condition is met.

The policy is asymmetric: escalation is relatively fast and recovery is slow.
This hysteresis prevents repeated start-stop oscillation. A short test,
compiler, browser, or video-processing burst must not close the circuit.

Thermal pressure can escalate the state but cannot by itself establish process
ownership. It can stop new bot work; it cannot authorize process termination.

## Admission Classes

Callers identify the source and trigger of work. Resource Guardian maps them to
an internal admission class; callers do not provide CPU thresholds or policy.

| Class | Examples | Elevated | Critical | Emergency |
| --- | --- | --- | --- | --- |
| `interactive` | Ordinary owner chat and current interactive agent turn | Allow | Allow | Allow |
| `operator` | Explicit `tcb loop tick`, forced audit, manual delegated task | Allow with warning | Deny unless explicitly forced | Deny |
| `background-light` | Reconciliation and bounded read-only inspection | Allow | Allow when it cannot create work | Allow only for Guardian reconciliation |
| `background-heavy` | Loop WorkOrder, audit repair, Runtime Guardian repair, Autopilot worker, batch task | Deny | Deny | Deny |
| `resource-repair` | Delayed repair for a Resource Incident | Deny | Deny | Deny |

`resource-repair` is allowed only after ten minutes of stable recovery and is
limited to one active repair. Emergency pressure cannot be bypassed with a
normal `--force` option. An operator who intentionally wants to override an
emergency must first change Resource Guardian mode through the dedicated
operator command, making the action explicit and auditable.

Read-only reconciliation remains available where it is necessary to discover
that resources are already terminal or stale. It must not create a WorkOrder,
lease, session, or child process while the circuit is closed.

## Runtime Circuit

Resource Guardian must not implement emergency pause by writing automation
environment variables. Environment configuration expresses operator intent
and is normally loaded once at process startup. Resource pressure is transient
runtime state.

The Resource Circuit contains:

```ts
type ResourceCircuitState = {
  schemaVersion: 1;
  pressure: PressureState;
  incidentId: string | null;
  admission: "open" | "heavy-closed" | "background-closed";
  reason: string;
  changedAt: number;
  lastSampleAt: number;
  owner: "resource-guardian";
};
```

It is written atomically. Background admission reads it immediately before any
durable reservation or process creation. A small mtime-aware cache is allowed,
but its maximum staleness must be less than one lightweight tick.

The circuit never changes whether a task family is configured or operator-
enabled. Recovery reopens only the circuit owned by Resource Guardian; it does
not resume automation that the operator paused or disabled.

On restart, a recent closed circuit remains closed until new samples prove
recovery. If sampling repeatedly fails, a previously closed circuit remains
closed for a bounded 15-minute safety hold and produces a notification. After
that hold, the module moves to observe-only degraded mode instead of leaving
automation permanently locked without evidence. A previously healthy circuit
does not authorize process actions when fresh sampling is unavailable.

## Process Ownership

Process names, command substrings, and working-directory paths are insufficient
ownership proof. A process is strongly bot-owned only when the process instance
identity and at least one durable automation relationship agree.

Process instance identity consists of PID plus operating-system process start
time. Every action must revalidate both immediately before signaling the
process to prevent PID-reuse errors.

Strong ownership evidence is one of:

1. the process is a descendant of the current bot process and the child launch
   is recorded as bot-managed work;
2. the process is a descendant of a tmux pane PID for a reserved automation
   session, and that session matches a live WorkOrder or active worker lease;
3. the process is a descendant of a recorded worker session whose WorkOrder is
   terminal, stale, or cancelled with a structured `resource-pressure` reason.

Working directory, command, project id, WorkOrder id, session name, and lease
id remain corroborating evidence. They do not independently authorize a
signal.

Processes are classified as:

- `external`: evidence identifies another application or unmanaged process;
- `unknown`: evidence is incomplete or contradictory;
- `bot-active`: ownership is strong and durable work is still valid;
- `bot-terminal`: ownership is strong and durable work is terminal;
- `bot-stale`: ownership is strong but its session, lease, heartbeat, or
  WorkOrder has exceeded its lifecycle policy.

External and unknown processes are never automatically signaled.

## Action Policy

Actions escalate in this order:

1. close the appropriate admission circuit;
2. record evidence and notify once for the state transition;
3. run existing deterministic reconciliation for terminal or stale resources;
4. clean `bot-terminal` and `bot-stale` sessions, leases, and records through
   their owning lifecycle modules;
5. if emergency pressure remains after cleanup, cooperatively cancel the
   lowest-priority `bot-active` background WorkOrder that materially contributes
   to CPU pressure;
6. wait a configurable grace period and re-sample;
7. send `SIGTERM` only when the same strongly owned process instance remains
   alive after cooperative cancellation;
8. reserve `SIGKILL` for a terminal or stale strongly owned process instance
   that survives reconciliation and `SIGTERM`.

Cooperative cancellation uses the existing WorkOrder cancellation path with a
structured `resource-pressure` reason. It must leave durable finalization
evidence and release or retain resources according to the existing WorkOrder
policy. Recovery admission must observe the Resource Circuit so cancellation
cannot immediately launch a replacement worker.

No action may mutate a target repository as part of pressure relief.

## Incident Evidence

Runtime evidence lives under `state/resource-guardian/` and is excluded from
the state backup repository. It contains no source checkout or media copy.

Each incident records:

- schema version, id, start time, current state, and end time;
- pressure-state transition timeline;
- normalized resource samples;
- deep process snapshot and parent chains;
- ownership classification and evidence for each candidate process;
- related session, WorkOrder, lease, task-family, and project identifiers;
- actions attempted, actions refused, and the reason for each decision;
- recovery outcome and optional repair WorkOrder id.

The current state is one atomic JSON file. Incident records are individually
atomic JSON files, capped at the newest 50 incidents and 10 MiB total. Sample
arrays are downsampled when necessary. Resource Guardian enforces retention
without scanning ignored worktrees or source repositories.

Notifications are emitted only on pressure-state transitions, automatic
process actions, degraded sampling, recovery, and repair completion. Repeated
samples within the same state do not generate repeated notifications.

## Operator Interface

The initial operator surface is deliberately small:

```text
tcb resource status [--json]
tcb resource incidents [--limit N] [--json]
tcb resource mode observe|protect
tcb resource profile balanced|conservative
```

`status` explains the current pressure, circuit state, latest sample, dominant
process ownership, and last action. `incidents` exposes bounded historical
evidence without personal absolute paths. Paths under the operator home are
rendered with `~/...`.

The existing system-load command and control diagnostic include the current
Resource Guardian state and circuit reason. Telegram and Feishu/Lark receive
the same notification semantics. The initial implementation does not require a
new chat button or TUI interaction mode.

Configuration is limited to enablement, mode, profile, and tick interval. A
profile owns coherent thresholds so routine operation does not require tuning
six independent numbers. Dedicated commands write non-secret allowlisted
configuration. `observe` records and explains incidents but never closes the
circuit or signals a process. `protect` enables the full action policy.

Existing installations begin disabled to avoid surprising process actions.
The target installation is explicitly enabled in `observe` mode after the
implementation passes local verification, then promoted to `protect` after a
real observation window shows acceptable attribution and false-positive
behavior.

## Repair Policy

Repair is deliberately separated from pressure relief.

First, Resource Guardian invokes deterministic lifecycle repairs that already
have authoritative state: terminal session cleanup, expired lease settlement,
duplicate reservation reconciliation, and stale worker-record cleanup. These
actions do not require an agent.

An agent-backed repair is eligible only when all of these are true:

- the incident is attributable to bot-owned behavior rather than external load;
- host CPU remains below the recovery threshold for ten minutes;
- the Resource Circuit permits `resource-repair`;
- no repair is active for the same incident fingerprint;
- the fingerprint has not exhausted its cooldown or retry limit;
- deterministic reconciliation did not fully close the incident;
- the target repository and WorkOrder isolation checks pass.

Eligible repair uses the existing active-agent, Repair Coordinator, and
WorkOrder path. The prompt receives the bounded incident evidence and must
follow Explore, Plan, Code, Verify, Review, and Record. It must not call a model
provider directly. External pressure produces an explanatory notification and
never a repair WorkOrder.

At most one Resource Guardian repair may be active globally. A repair that
causes renewed pressure is cooperatively cancelled, recorded against the same
incident, and not immediately retried.

## Failure Handling

- One sampling failure preserves the previous state and records the probe
  error.
- Consecutive sampling failures notify once and disable process actions.
- A corrupt state file is atomically quarantined and the module starts in
  degraded observe mode.
- A corrupt incident record does not prevent current pressure protection.
- Notification failure does not reopen the circuit or block deterministic
  cleanup.
- Cleanup failure remains evidence for the next reconciliation tick; it does
  not authorize a stronger signal without ownership revalidation.
- A Resource Guardian tick never overlaps another tick. A skipped overlapping
  tick is recorded as event-loop-lag evidence.
- Resource Guardian failure must not stop ordinary chat, diagnostics, or manual
  service shutdown.

## Security and Safety Invariants

- External and unknown processes receive no automatic signal.
- PID plus process start time is revalidated before every signal.
- Resource pressure cannot bypass WorkOrder project-path or git-toplevel
  validation.
- Resource Guardian never edits a target repository during pressure relief.
- Resource Guardian never resumes operator-disabled automation.
- Emergency override is explicit and auditable.
- User-facing output tildeifies home paths.
- Runtime evidence is bounded and excluded from state backup.
- Agent-backed repair uses active sessions, never a direct model-provider
  client.

## Testing Strategy

The Resource Guardian interface is the test surface. Tests use a fake clock,
fake lightweight sampler, fake deep-inspection adapter, fake process actor, and
temporary state directory. Internal parser tests are retained only where
platform output parsing cannot be exercised through the module interface.

Required scenarios include:

1. a CPU burst shorter than 30 seconds leaves the circuit open;
2. sustained elevated pressure denies only heavy background admission;
3. sustained critical pressure denies every new background WorkOrder before
   session or lease creation;
4. external CPU pressure closes background admission but signals no process;
5. an unknown PID is never signaled;
6. PID reuse between inspection and action cancels the action;
7. a terminal WorkOrder worker is cleaned through the owning lifecycle module;
8. an active WorkOrder receives cooperative cancellation before any signal;
9. renewed pressure during recovery keeps the circuit closed;
10. Resource Guardian recovery does not resume operator-disabled automation;
11. repeated samples deduplicate notifications;
12. state corruption enters degraded observe mode;
13. bot restart preserves a recent critical circuit;
14. repair is blocked until ten minutes of stable recovery;
15. one incident fingerprint creates at most one active repair;
16. incident retention enforces both count and byte limits;
17. user-facing paths under the home directory are tildeified;
18. normal sampling does not spawn the deep process probe.

Each automation integration also needs a contract test proving that denied
admission creates no WorkOrder, queue lease, worker lease, session, or child
process.

## Rollout Slices

### Slice 1: Pressure model and observe-only sampling

Implement the pure pressure policy, lightweight sampler, bounded incident
store, status view, and observe-only startup integration. No admission or
process action is changed.

### Slice 2: Resource Circuit and shared admission

Implement atomic circuit state and integrate admission at Loop, Daily Task
Audit, Runtime Guardian repair, Autopilot delegation, and Batch scheduling.
This slice proves runtime pause without changing operator automation settings.

### Slice 3: Ownership and deterministic cleanup

Build process ancestry and tmux/WorkOrder/lease correlation. Enable cleanup only
for strongly owned terminal and stale work through existing lifecycle modules.

### Slice 4: Cooperative emergency preemption

Add lowest-priority active WorkOrder selection, cooperative cancellation,
grace-period resampling, and tightly gated signal escalation.

### Slice 5: Stable recovery and repair

Add circuit recovery, incident fingerprint cooldown, deterministic repair
closure, and at-most-one active-agent repair WorkOrder.

### Slice 6: Operator surfaces and protected rollout

Complete CLI, system-load/control diagnostics, notification parity,
configuration commands, installation docs, capability matrix, alignment
contracts, and the observe-to-protect rollout procedure.

Each slice is independently tested, verified, and committed. A slice that does
not pass its interface tests and local verification is reverted or completed
before the next slice begins.

## Success Criteria

- A CPU burst shorter than 30 seconds triggers no automatic action.
- Sustained critical pressure closes new background admission within two
  minutes.
- A closed circuit prevents creation of new background WorkOrders, sessions,
  leases, and child processes.
- Ordinary interactive chat remains available.
- No external or unknown process is automatically terminated.
- Every automatic signal has revalidated process-instance, process-tree,
  session, and WorkOrder or lease evidence.
- Resource repair starts only after ten stable minutes and at most once per
  incident fingerprint.
- Normal Resource Guardian overhead averages less than 0.5% of one CPU core on
  the target machine.
- One status command explains the current consumer, ownership evidence, action,
  refusal reason, and recovery state.
- Incident evidence remains below the configured count and byte caps and never
  enters the state backup repository.
- `npm run verify:local` passes before protected mode is enabled.

## Alternatives Rejected

### Extend Runtime Guardian

This would reduce the number of top-level names but combine machine pressure
with runtime-artifact integrity. It also makes repair dispatch part of the same
path that must prevent repair during pressure. The resulting interface would
be shallower and harder to reason about.

### Use automation environment variables as the circuit

Environment-backed pause preserves operator configuration but cannot reliably
change timers and loaded configuration in the running bot. Automatically
restoring prior values could also enable automation that the operator intended
to keep disabled.

### Kill by process name, CPU percentage, or worktree path

These are useful diagnostic hints but unsafe ownership evidence. They cannot
distinguish an operator-run test from an automation worker and are vulnerable
to PID reuse and path overlap.

### Start with an external watchdog

An external watchdog is more resilient to total bot failure but introduces a
second deployment lifecycle, communication protocol, and source of truth.
The initial in-process interface leaves room for that adapter if observed
event-loop starvation later proves it necessary.
