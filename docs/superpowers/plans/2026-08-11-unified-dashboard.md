# Unified Operations Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deepen the existing Dashboard into one bounded, redacted Runtime Overview shared by human, chat, TUI, MCP, and Home Operator surfaces without changing existing command names or JSON fields.

**Architecture:** Add a pure Runtime Overview module behind the existing Dashboard interface and a production reader that projects existing authoritative modules. Extend `DashboardSnapshot` additively, then make every renderer consume the same neutral data. Keep CLI mutation commands and role-scoped MCP permissions unchanged.

**Tech Stack:** TypeScript, Vitest, Commander, Ink/React, Telegram/Lark adapters, Model Context Protocol SDK, existing Core stores and Control socket.

---

### Task 1: Pure Runtime Overview policy

**Files:**
- Create: `src/core/dashboard/runtime-overview.ts`
- Create: `tests/core/dashboard/runtime-overview.test.ts`

- [ ] **Step 1: Write the failing policy tests**

Cover healthy, attention, degraded, deterministic severity/time/id ordering,
bounded section metadata, optional integration absence, and secret/path-free data.

```ts
const overview = buildRuntimeOverview({
  attention: [{ id: "loop:failed", domain: "automation", severity: "error", observedAt: 20, summary: "Loop failed", nextAction: "tcb loop reports list" }],
  activeWork: [], automation: [], runtimeDomains: [], operator: readyOperator,
  recentOutcomes: [], degradedDomains: [],
}, { limit: 10 });
expect(overview.health.status).toBe("attention");
expect(overview.attention).toMatchObject({ total: 1, limit: 10, truncated: false });
```

- [ ] **Step 2: Run RED**

Run: `npx vitest run tests/core/dashboard/runtime-overview.test.ts`

Expected: FAIL because `runtime-overview.ts` does not exist.

- [ ] **Step 3: Implement the neutral interface and classification**

Define `RuntimeOverview`, `AttentionItem`, `ActiveWorkItem`,
`AutomationFamilyView`, `RuntimeDomainView`, `OperatorInterfaceView`,
`RecentOutcome`, and `BoundedSection<T>`. Implement one
`buildRuntimeOverview(input, options)` interface that sorts and bounds all inputs
and derives Overall Health.

- [ ] **Step 4: Run GREEN**

Run: `npx vitest run tests/core/dashboard/runtime-overview.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/dashboard/runtime-overview.ts tests/core/dashboard/runtime-overview.test.ts
git commit -m "feat(dashboard): define runtime overview policy"
```

### Task 2: Authoritative read adapters

**Files:**
- Create: `src/core/dashboard/runtime-overview-reader.ts`
- Modify: `src/core/config/automation-command.ts`
- Modify: `src/core/ai-tools/install-contract.ts`
- Modify: `src/cli/skill.ts`
- Test: `tests/core/dashboard/runtime-overview-reader.test.ts`
- Test: `tests/config-command.test.ts`
- Test: `tests/cli-ai-tools.test.ts`

- [ ] **Step 1: Write failing reader tests**

Inject readers for Automation, WorkOrders/reports, Batch, Daily Audit, Runtime
Guardian, Resource Guardian, power, and AI Interfaces. Assert that one reader
failure yields one sanitized degraded domain while other domains remain usable.
Assert that configured optional Prompt Library evidence is attention-worthy but
an absent optional project MCP is informational.

- [ ] **Step 2: Run RED**

Run: `npx vitest run tests/core/dashboard/runtime-overview-reader.test.ts tests/config-command.test.ts tests/cli-ai-tools.test.ts`

Expected: FAIL because the production read interface and reusable status readers
are missing.

- [ ] **Step 3: Expose read interfaces instead of parsing commands**

Export `readAutomationStatuses()` from the Automation module and reuse it inside
`runAutomationCommand`. Add a path-free `readAiToolStatus()` in Core that validates
the expected operator skill and managed MCP descriptors by type/role/tool set.
Keep installation writes in CLI modules.

- [ ] **Step 4: Implement the production Runtime Overview reader**

Implement `readRuntimeOverview(input)` with explicit reader dependencies and safe
defaults over existing Core modules. Map only bounded identifiers, labels, enums,
timestamps, counts, and existing operator commands. Never expose raw paths,
commands, exception messages, or artifact bodies.

- [ ] **Step 5: Run GREEN and dependency checks**

Run: `npx vitest run tests/core/dashboard/runtime-overview-reader.test.ts tests/config-command.test.ts tests/cli-ai-tools.test.ts`

Run: `npm run depcruise`

Expected: PASS and zero dependency violations.

- [ ] **Step 6: Commit**

```bash
git add src/core/dashboard/runtime-overview-reader.ts src/core/config/automation-command.ts src/core/ai-tools/install-contract.ts src/cli/skill.ts tests/core/dashboard/runtime-overview-reader.test.ts tests/config-command.test.ts tests/cli-ai-tools.test.ts
git commit -m "feat(dashboard): read authoritative runtime health"
```

### Task 3: Additive Dashboard Snapshot and CLI rendering

**Files:**
- Modify: `src/core/dashboard/dashboard.ts`
- Modify: `src/core/dashboard/dashboard-view.ts`
- Modify: `src/cli.ts`
- Test: `tests/dashboard.test.ts`
- Test: `tests/dashboard-view.test.ts`
- Test: `tests/cli-dashboard.test.ts`

- [ ] **Step 1: Write failing compatibility and rendering tests**

Assert that `sessions`, `global`, and `generatedAt` retain their existing shapes;
the additive `overview` is present; text starts with Overall Health and Attention;
Active Work precedes Automation and Project Sessions; all new lists render explicit
truncation; `--problems`, `--project`, and `--limit` validate inputs.

- [ ] **Step 2: Run RED**

Run: `npx vitest run tests/dashboard.test.ts tests/dashboard-view.test.ts tests/cli-dashboard.test.ts`

Expected: FAIL on the missing additive overview and options.

- [ ] **Step 3: Integrate the deep module**

Call the Runtime Overview reader once from `buildDashboard` after session rows are
available. Accept an internal injected reader in Dashboard options for deterministic
tests. Add `overview` without altering current fields.

- [ ] **Step 4: Implement health-first text**

Add pure section renderers for Overall, Attention, Active Work, Automation,
Operator and AI Interfaces, Recent Outcomes, and Project Sessions. Apply filters to
the neutral snapshot, not to stores. Tildeify existing session paths before display.

- [ ] **Step 5: Run GREEN**

Run: `npx vitest run tests/dashboard.test.ts tests/dashboard-view.test.ts tests/cli-dashboard.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/dashboard/dashboard.ts src/core/dashboard/dashboard-view.ts src/cli.ts tests/dashboard.test.ts tests/dashboard-view.test.ts tests/cli-dashboard.test.ts
git commit -m "feat(dashboard): render unified operations status"
```

### Task 4: Bounded Loop and task drill-downs

**Files:**
- Modify: `src/core/loop/report-catalog.ts`
- Modify: `src/core/loop/report.ts`
- Modify: `src/core/loop/backlog.ts`
- Modify: `src/cli.ts`
- Modify: `src/mcp/observer.ts`
- Test: `tests/loop/report-catalog.test.ts`
- Test: `tests/loop/report-backlog.test.ts`
- Test: `tests/mcp/observer.test.ts`

- [ ] **Step 1: Write failing bound/filter tests**

Require Loop report reads to accept `limit`, `projectId`, and terminal status;
require backlog reads to accept `limit`, `projectId`, and open/all status. Verify
default 20, maximum 100, deterministic newest ordering, truncation metadata, and
tildeified structured paths.

- [ ] **Step 2: Run RED**

Run: `npx vitest run tests/loop/report-catalog.test.ts tests/loop/report-backlog.test.ts tests/mcp/observer.test.ts`

Expected: FAIL because list interfaces are currently unbounded.

- [ ] **Step 3: Deepen catalog interfaces**

Move filtering, sorting, limiting, totals, truncation, and structured path
sanitization behind the report/backlog read modules. Keep legacy no-argument calls
compatible where existing internal callers require complete reconciliation data;
user-facing callers must pass explicit bounded options.

- [ ] **Step 4: Update CLI and Observer MCP schemas**

Add validated `--limit`, `--project`, and `--status` CLI options. Add equivalent Zod
inputs to `tcb.observer.loop_reports_list`. Return a bounded envelope rather than a
raw unbounded array.

- [ ] **Step 5: Run GREEN**

Run: `npx vitest run tests/loop/report-catalog.test.ts tests/loop/report-backlog.test.ts tests/mcp/observer.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/loop/report-catalog.ts src/core/loop/report.ts src/core/loop/backlog.ts src/cli.ts src/mcp/observer.ts tests/loop/report-catalog.test.ts tests/loop/report-backlog.test.ts tests/mcp/observer.test.ts
git commit -m "fix(observation): bound automation drilldowns"
```

### Task 5: Observer/Home MCP and Home Operator skill

**Files:**
- Modify: `src/mcp/observer.ts`
- Modify: `src/mcp/home.ts`
- Modify: `src/core/mcp/profiles.ts`
- Modify: `skills/tcb-home-operator/SKILL.md`
- Test: `tests/mcp/observer.test.ts`
- Test: `tests/mcp/home.test.ts`
- Test: `tests/mcp/profiles.test.ts`
- Test: `tests/docs-contract.test.ts`

- [ ] **Step 1: Write failing structured status tests**

Assert `tcb.observer.status` returns the full additive overview, evidence,
`nextSuggestedAction`, and read-only role. Assert Home inherits the same tool and
server identity while adding no duplicate status tool. Assert the skill selects MCP
first and documented CLI fallback second.

- [ ] **Step 2: Run RED**

Run: `npx vitest run tests/mcp/observer.test.ts tests/mcp/home.test.ts tests/mcp/profiles.test.ts tests/docs-contract.test.ts`

Expected: FAIL because Observer currently strips the snapshot to `global`.

- [ ] **Step 3: Return the canonical read model**

Remove the lossy `statusData` projection. Return the complete bounded Dashboard
snapshot through Observer. Add stable `scope`, `errorKind`, and
`nextSuggestedAction` fields to tool responses while preserving current fields.

- [ ] **Step 4: Align the Home Operator skill**

Document the read sequence: `tcb.observer.status`, narrow Observer evidence tools,
then `tcb dashboard --json` fallback. Explicitly prohibit direct state-file reads,
human-text parsing, generic MCP shell wrappers, and mutation without explicit owner
intent and target identity.

- [ ] **Step 5: Run GREEN**

Run: `npx vitest run tests/mcp/observer.test.ts tests/mcp/home.test.ts tests/mcp/profiles.test.ts tests/docs-contract.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/observer.ts src/mcp/home.ts src/core/mcp/profiles.ts skills/tcb-home-operator/SKILL.md tests/mcp/observer.test.ts tests/mcp/home.test.ts tests/mcp/profiles.test.ts tests/docs-contract.test.ts
git commit -m "feat(mcp): expose unified observer status"
```

### Task 6: TUI and chat presentation parity

**Files:**
- Modify: `src/tui/app.tsx`
- Modify: `src/core/dashboard/dashboard-view.ts`
- Modify: `src/adapters/telegram/handlers.ts`
- Modify: `src/adapters/lark/views.ts`
- Modify: `src/core/i18n/catalog/en.ts`
- Modify: `src/core/i18n/catalog/zh.ts`
- Modify other maintained locale catalogs with the same keys
- Test: `tests/dashboard-view.test.ts`
- Test: `tests/tui-interaction.test.ts`
- Test: `tests/adapters/telegram/dashboard.test.ts`
- Test: `tests/adapters/lark/dashboard.test.ts`
- Test: `tests/core/i18n.test.ts`

- [ ] **Step 1: Write failing presentation tests**

Require the TUI header to show health/attention/active counts without breaking
selection; require chat to show at most three Attention and five Active Work items;
require explicit `+N more`, localized headings, and Telegram/Lark semantic parity.

- [ ] **Step 2: Run RED**

Run: `npx vitest run tests/dashboard-view.test.ts tests/tui-interaction.test.ts tests/adapters/telegram/dashboard.test.ts tests/adapters/lark/dashboard.test.ts tests/core/i18n.test.ts`

Expected: FAIL on missing overview presentation and catalog keys.

- [ ] **Step 3: Implement surface-specific renderers**

Keep rendering pure. CLI gets the detailed format; chat gets a bounded format; TUI
gets compact header/section rows. Adapters may choose text versus card layout but
must not classify health or query additional stores.

- [ ] **Step 4: Run GREEN**

Run the command from Step 2.

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tui/app.tsx src/core/dashboard/dashboard-view.ts src/adapters/telegram/handlers.ts src/adapters/lark/views.ts src/core/i18n tests/dashboard-view.test.ts tests/tui-interaction.test.ts tests/adapters/telegram/dashboard.test.ts tests/adapters/lark/dashboard.test.ts tests/core/i18n.test.ts
git commit -m "feat(ui): align runtime overview surfaces"
```

### Task 7: Documentation and drift contracts

**Files:**
- Modify: `docs/manual.md`
- Modify: `docs/cli-reference.md`
- Modify: `docs/tui.md`
- Modify: `docs/commands.md`
- Modify: `docs/agents/usage-guide.md`
- Modify: `docs/mcp.md`
- Modify: `docs/ai-tool-surface-governance.md`
- Modify: `docs/automation-capability-matrix.md`
- Modify: `docs/automation-alignment.md`
- Modify: `llms.txt`
- Test: `tests/docs-contract.test.ts`
- Test: `tests/automation-alignment.test.ts`

- [ ] **Step 1: Write failing drift assertions**

Assert that maintained docs name Dashboard as the Runtime Overview, preserve
capability allocation, document Observer-first Home behavior, list bounds/filters,
and state that client-private MCP registrations are not scanned.

- [ ] **Step 2: Run RED**

Run: `npx vitest run tests/docs-contract.test.ts tests/automation-alignment.test.ts`

Expected: FAIL until all surfaces are documented.

- [ ] **Step 3: Update maintained documentation**

Keep business terminology in `CONTEXT.md` and intelligent automation docs, human
usage in manual/command/TUI docs, role allocation in MCP governance, and parity in
the capability/alignment matrices. Do not copy live project names, paths, schedules,
or personal MCP registrations into maintained docs.

- [ ] **Step 4: Run GREEN**

Run the command from Step 2.

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add docs llms.txt tests/docs-contract.test.ts tests/automation-alignment.test.ts
git commit -m "docs: align runtime overview entry points"
```

### Task 8: Full verification and final integration

**Files:**
- Modify only files required by failing checks from this feature.

- [ ] **Step 1: Run focused aggregate tests**

Run all Dashboard, CLI Dashboard, MCP, TUI, Telegram/Lark Dashboard, docs, and
alignment suites touched above.

- [ ] **Step 2: Run static gates**

```bash
npm run lint:types
npm run lint:types:tests
npm run depcruise
npx biome check <touched-files>
git diff --check
```

Expected: all pass.

- [ ] **Step 3: Run the complete local gate**

Run: `npm run verify:local`

Expected: exit 0 and `verify-local ok`.

- [ ] **Step 4: Exercise real read-only surfaces**

```bash
tcb dashboard
tcb dashboard --json
tcb automation status
tcb loop reports list --limit 5
tcb resource status --json
tcb ai-tools status --json
```

Expected: bounded, path-safe, internally consistent output from the running dev
profile. No command mutates state.

- [ ] **Step 5: Review and consolidate commits**

Review the complete diff against the design, remove debug artifacts, keep the
worktree clean, and combine only commits that represent the same coherent feature
slice.
