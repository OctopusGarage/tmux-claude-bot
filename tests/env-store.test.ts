import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { persistEnvVar } from "../src/core/infra/env-store.js";

// Real-fs behaviour tests: persistEnvVar writes the actual .env under TCB_STATE_DIR.
let dir: string;
let orig: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tcb-envstore-"));
  orig = process.env.TCB_STATE_DIR;
  process.env.TCB_STATE_DIR = dir;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  if (orig === undefined) delete process.env.TCB_STATE_DIR;
  else process.env.TCB_STATE_DIR = orig;
});

const envFile = (): string => path.join(dir, ".env");

describe("persistEnvVar", () => {
  it("is a no-op when .env does not exist (next boot has nothing to write into)", () => {
    persistEnvVar("MY_KEY", "value");
    expect(fs.existsSync(envFile())).toBe(false);
  });

  it("updates an existing key and leaves other lines untouched", () => {
    fs.writeFileSync(envFile(), "EXISTING=1\nOTHER=2\n");
    persistEnvVar("OTHER", "changed");
    const out = fs.readFileSync(envFile(), "utf8");
    expect(out).toContain("EXISTING=1");
    expect(out).toMatch(/OTHER=changed/);
  });

  it("appends a new key when it is absent", () => {
    fs.writeFileSync(envFile(), "EXISTING=1\n");
    persistEnvVar("NEW_KEY", "hello");
    expect(fs.readFileSync(envFile(), "utf8")).toMatch(/NEW_KEY=hello/);
  });

  it("writes the file 0600 so the bot token stays private", () => {
    fs.writeFileSync(envFile(), "EXISTING=1\n");
    persistEnvVar("K", "v");
    expect(fs.statSync(envFile()).mode & 0o777).toBe(0o600);
  });

  it("leaves no temp file behind", () => {
    fs.writeFileSync(envFile(), "EXISTING=1\n");
    persistEnvVar("K", "v");
    expect(fs.readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);
  });
});
