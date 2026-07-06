import type { AgentKind } from "../../shared/types.js";

/** Protocol-neutral summary for one project session. This is the single data
 * shape adapters should render from when they need project/session status. */
export interface ProjectSessionSummary {
  sessionName?: string;
  sid: string;
  label: string;
  alive: boolean;
  active: boolean;
  path?: string | null;
  isFree: boolean;
  freeSlot?: number | null;
  agentKind?: AgentKind | null;
  agentRunning?: boolean;
  agentBusy?: boolean;
  hasGroup?: boolean;
  groupLabel?: string | null;
  statusLine?: string;
  canCreateFreeGroup?: boolean;
}

/** Neutral data shape for a project list button. */
export interface ProjectButton extends ProjectSessionSummary {}

/** Neutral data shape for a recent-project list button. */
export interface RecentButton extends ProjectSessionSummary {}
