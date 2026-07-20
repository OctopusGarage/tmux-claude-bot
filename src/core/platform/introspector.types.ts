/**
 * Process-introspection contract types. Kept in a leaf module (no imports) so
 * the platform implementations (introspector.darwin.ts / introspector.linux.ts)
 * can depend on the types without forming a cycle with introspector.ts, which
 * imports those implementations for selectIntrospector().
 */

/** A row of the process table. */
export interface ProcRow {
  pid: number;
  ppid: number;
  command: string;
}

export interface ProcessIntrospector {
  /** Snapshot of the process table. */
  snapshot(): Promise<ProcRow[]>;
  /** Process environment, normalised to newline-separated KEY=VALUE tokens. */
  readProcEnv(pid: number): Promise<string>;
  /** Absolute paths of files the process currently has open. */
  listOpenFiles(pid: number): Promise<string[]>;
  /** Working directory of the process, or null if it can't be determined. */
  cwdOf(pid: number): Promise<string | null>;
  /** Controlling terminal of the process (e.g. /dev/ttys001 or /dev/pts/0), or
   * null when the process has no terminal. Used to reset TUI-forced keyboard
   * modes after an abrupt takeover kill. */
  ttyOf(pid: number): Promise<string | null>;
}
