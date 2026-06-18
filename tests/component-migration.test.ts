import * as fs from "node:fs";
import { describe, expect, it } from "vitest";

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist") continue;
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith(".ts")) acc.push(p);
  }
  return acc;
}

describe("no [prefix] left in logger message strings", () => {
  it("logger/log calls do not start with a [bracket] prefix", () => {
    const offenders: string[] = [];
    for (const f of walk("src")) {
      const src = fs.readFileSync(f, "utf8");
      if (/\b(?:logger|log)\.(?:info|warn|error|debug)\(\s*[`"']\[[a-z-]+\]/.test(src))
        offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});
