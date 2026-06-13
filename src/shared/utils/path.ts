import { homedir } from "node:os";

/**
 * Expand a leading `~` (or `~/…`) to the home directory — and ONLY a leading one.
 * A bare `replaceAll("~", homedir())` corrupts legitimate paths that contain a
 * tilde mid-string (e.g. `/srv/~backup`). `~user` (other-user home) is not
 * supported and is returned unchanged.
 */
export function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return homedir() + p.slice(1);
  return p;
}
