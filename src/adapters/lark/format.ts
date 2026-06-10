/** Lark rejects an empty message; fall back to a placeholder. Output is
 * already length-capped upstream by OutputProcessor. */
export function textOrPlaceholder(output: string): string {
  return output.trim().length > 0 ? output : "(无输出)";
}
