import { redactSecrets } from "../../shared/utils/logger.js";
import { tildeifyHome } from "../../shared/utils/path.js";

/** Keep Resource Guardian operator and diagnostic text safe across every surface. */
export function sanitizeResourceGuardianText(value: string): string {
  return tildeifyHome(
    redactSecrets(value)
      .replace(/\b(token|password|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=<redacted>")
      .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1<redacted>@"),
  ).slice(0, 2_000);
}
