import { basename } from "node:path";
import { sessionShortId } from "../shared/utils/hash.js";

/**
 * A short, friendly name for a project session — used in the `📂 <name>` line
 * of every message, replacing the long `tmux_proj_-Users-…` session tag.
 * Prefers the basename of the mapped project path; falls back to a stable
 * short id when no path mapping exists.
 */
export function projectLabel(session: string, path: string | undefined): string {
  if (path) {
    const name = basename(path.replace(/\/+$/, ""));
    if (name) return name;
  }
  return `#${sessionShortId(session)}`;
}
