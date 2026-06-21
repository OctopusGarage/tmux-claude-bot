/**
 * JS double arithmetic leaves display noise: `14` comes out `14.000000000000002`,
 * `3` comes out `2.9999999999999996`. The fingerprint is a run of ≥10 identical 0s
 * or 9s in the fractional part — no real datum has that — so we can safely collapse
 * such a number to its clean value at the message send boundary (the same place
 * paths get tilde-ified). Call sites no longer have to remember to round.
 */
const FLOAT_NOISE = /-?\d+\.\d*?(?:0{10,}|9{10,})\d*/g;

/** Collapse floating-point display noise in a string to clean rounded values. */
export function tidyFloatNoise(text: string): string {
  return text.replace(FLOAT_NOISE, (m) => {
    const n = Number(m);
    return Number.isFinite(n) ? String(Number(n.toFixed(10))) : m;
  });
}

/** Deep variant: tidy every string in an object/array (for card payloads). */
export function tidyFloatNoiseDeep<T>(value: T): T {
  if (typeof value === "string") return tidyFloatNoise(value) as T;
  if (Array.isArray(value)) return value.map((v) => tidyFloatNoiseDeep(v)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = tidyFloatNoiseDeep(v);
    return out as T;
  }
  return value;
}
