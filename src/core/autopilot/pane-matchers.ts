import type { PaneSemantics } from "./types.js";

// Transient/retryable API errors (NOT the hard-stop class below).
const API_ERROR_RE =
  /\bAPI Error\b|\boverloaded_error\b|\b(rate.?limit|too many requests)\b|\bterminated\b/i;

// A SERVER-SIDE rate limit is transient and retryable — distinct from the usage-cap
// hard stop. Anthropic's notice literally reads "(not your usage limit) · Rate limited",
// so the bare `usage limit` substring in HARD_STOP_RE must NOT win: these phrases force
// the API-error (retry) classification even when "usage limit" appears in the text.
const RATE_LIMIT_RE =
  /\brate.?limit(ed)?\b|temporarily limiting|not your usage limit|too many requests/i;

// Server-side busy/overload — back off HARDER than a plain transient blip.
const SERVER_BUSY_RE =
  /\b(429|500|502|503|529)\b|\boverloaded\b|internal server error|service unavailable|temporarily (limiting|overloaded|unavailable)/i;

// Hard stops: no point auto-continuing; conservative persona pauses + notifies.
const HARD_STOP_RE =
  /\bout of credits\b|\busage limit\b|\bquota\b|\bcontext (window )?(low|exceeded|limit)\b|\brun \/compact\b/i;

// A waiting prompt: a y/n confirmation, or an input box with no "working" marker.
const CONFIRM_RE = /\(y\/n\)|\bproceed\?|\bcontinue\?|❯\s*\d?\.?\s*(yes|no)\b/i;
const INPUT_BOX_RE = /(^|\n)\s*[│|]?\s*>\s*$/;
// Markers that mean it is actively working — suppress "waiting".
const WORKING_RE = /esc to interrupt|\bThinking…|\b(Running|Loading|Building|Compiling)\b.*…/i;

export function paneSemantics(paneText: string): PaneSemantics {
  const text = paneText;
  const working = WORKING_RE.test(text);
  // A transient rate limit overrides the usage-cap hard stop (see RATE_LIMIT_RE).
  const rateLimited = RATE_LIMIT_RE.test(text);
  const hardStop = HARD_STOP_RE.test(text) && !rateLimited;
  // serverBusy is a subset of apiError — HTTP 4xx/5xx overloads and rate limits
  // get the slower backoff curve; other transient errors (socket closed, terminated)
  // use the faster curve.
  const serverBusy = (SERVER_BUSY_RE.test(text) || rateLimited) && !hardStop;
  return {
    apiError: (API_ERROR_RE.test(text) || serverBusy) && !hardStop,
    serverBusy,
    hardStop,
    inputPromptWaiting: !working && (CONFIRM_RE.test(text) || INPUT_BOX_RE.test(text)),
  };
}
