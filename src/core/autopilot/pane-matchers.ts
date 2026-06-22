import type { PaneSemantics } from "./types.js";

// Transient/retryable API errors (NOT the hard-stop class below).
const API_ERROR_RE =
  /\bAPI Error\b|\boverloaded_error\b|\b(rate.?limit|too many requests)\b|\bterminated\b/i;

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
  return {
    apiError: API_ERROR_RE.test(text) && !HARD_STOP_RE.test(text),
    hardStop: HARD_STOP_RE.test(text),
    inputPromptWaiting: !working && (CONFIRM_RE.test(text) || INPUT_BOX_RE.test(text)),
  };
}
