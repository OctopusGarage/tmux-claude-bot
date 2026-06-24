import { JsonMapStore } from "../infra/json-map-store.js";
import type { Plan, PoolState, Run } from "./types.js";

const ACTIVE = "active";

/** Persists batch plans (id→Plan) and the single active run under the state dir
 * (restored on boot — losing the active run would orphan in-flight project tasks). */
export class SchedulerStore {
  private readonly plans = new JsonMapStore<Plan>("scheduler_plans.json");
  private readonly runs = new JsonMapStore<Run>("scheduler_run.json");
  private readonly fired = new JsonMapStore<number>("scheduler_lastfired.json");
  private readonly poolsStore = new JsonMapStore<PoolState>("scheduler_pools.json");

  savePlan(p: Plan): void {
    this.plans.set(p.id, p);
    // Bug #7 fix: clear lastFired so a freshly-loaded plan fires immediately on its
    // next due tick. A stale anchor from a previous run of the same id would make a
    // `kind:now` plan never fire (the undefined-check would fail).
    this.fired.delete(p.id);
  }
  getPlan(id: string): Plan | undefined {
    return this.plans.get(id);
  }
  listPlans(): Plan[] {
    return this.plans.sortedEntries().map(([, p]) => p);
  }
  setActiveRun(r: Run | null): void {
    if (r) this.runs.set(ACTIVE, r);
    else this.runs.delete(ACTIVE);
  }
  getActiveRun(): Run | undefined {
    return this.runs.get(ACTIVE);
  }
  getLastFired(): Record<string, number> {
    return Object.fromEntries(this.fired.sortedEntries());
  }
  setLastFired(map: Record<string, number>): void {
    for (const [id, ts] of Object.entries(map)) this.fired.set(id, ts);
  }
  getPools(): Record<string, PoolState> {
    return Object.fromEntries(this.poolsStore.sortedEntries());
  }
  setPools(p: Record<string, PoolState>): void {
    // Clear existing entries then write each agent's pool state.
    for (const [agent] of this.poolsStore.sortedEntries()) this.poolsStore.delete(agent);
    for (const [agent, state] of Object.entries(p)) this.poolsStore.set(agent, state);
  }
}
