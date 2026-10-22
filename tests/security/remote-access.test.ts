import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TOTP } from "otpauth";
import { afterEach, describe, expect, it } from "vitest";
import { RemoteAccessService } from "../../src/core/security/remote-access.js";

const secret = "JBSWY3DPEHPK3PXP";
const alice = { channel: "telegram" as const, userId: "alice", chatId: "group" };
const privateAlice = { ...alice, chatId: "private" };
const dirs: string[] = [];
function fixture() {
  const directory = join(mkdtempSync(join(tmpdir(), "remote-access-")), "security");
  dirs.push(directory);
  let now = 1_800_000_000_000;
  const service = new RemoteAccessService({ directory, now: () => now });
  const code = () => new TOTP({ secret, digits: 6, period: 30 }).generate({ timestamp: now });
  return {
    directory,
    service,
    code,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(join(dir, ".."), { recursive: true, force: true });
});

describe("remote access security", () => {
  it("defaults to a full day and expires new admissions exactly at the boundary", () => {
    const f = fixture();
    expect(f.service.status().grantTtlSeconds).toBe(86400);
    f.service.enroll(secret, f.code());
    f.advance(30_000);
    f.service.approve(privateAlice, f.service.request(alice).id, f.code());
    f.advance(86_399_999);
    expect(() => f.service.capture(alice)).not.toThrow();
    f.advance(1);
    expect(() => f.service.capture(alice)).toThrow();
  });
  it("persists configured hours without changing existing grants or enrollment", () => {
    const f = fixture();
    f.service.enroll(secret, f.code());
    f.advance(30_000);
    f.service.approve(privateAlice, f.service.request(alice).id, f.code());
    f.service.setGrantHours(48);
    const other = new RemoteAccessService({ directory: f.directory, now: f.now });
    expect(other.status()).toMatchObject({ grantTtlSeconds: 172800, enrolled: true });
    f.advance(86_400_000);
    expect(() => f.service.capture(alice)).toThrow();
    f.service.approve(privateAlice, f.service.request(alice).id, f.code());
    f.advance(172_799_999);
    expect(() => f.service.capture(alice)).not.toThrow();
    f.advance(1);
    expect(() => f.service.capture(alice)).toThrow();
  });
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])(
    "rejects invalid grant hours %s",
    (hours) => {
      const f = fixture();
      expect(() => f.service.setGrantHours(hours)).toThrow();
      expect(f.service.status().grantTtlSeconds).toBe(86400);
    },
  );
  it("migrates existing state without a configured duration to one day", () => {
    const f = fixture();
    f.service.enroll(secret, f.code());
    const path = join(f.directory, "remote-access.json");
    const state = JSON.parse(readFileSync(path, "utf8"));
    delete state.grantTtlSeconds;
    writeFileSync(path, JSON.stringify(state));
    expect(new RemoteAccessService({ directory: f.directory }).status()).toMatchObject({
      enrolled: true,
      grantTtlSeconds: 86400,
    });
  });
  it("preserves legacy access until enrollment and redacts status", () => {
    const f = fixture();
    expect(f.service.status()).toMatchObject({ enabled: false, enrolled: false, suspended: false });
    expect(f.service.capture(alice)).toBeUndefined();
    f.service.enroll(secret, f.code());
    expect(f.service.status()).toMatchObject({ enabled: true, enrolled: true });
    expect(JSON.stringify(f.service.status())).not.toContain(secret);
    expect(() => f.service.capture(alice)).toThrow();
  });
  it("binds access to the requesting identity/chat and expires new admissions", () => {
    const f = fixture();
    f.service.enroll(secret, f.code());
    f.advance(30_000);
    const req = f.service.request(alice);
    expect(() => f.service.approve({ ...privateAlice, userId: "bob" }, req.id, f.code())).toThrow();
    expect(f.service.approve(privateAlice, req.id, f.code()).principal).toEqual(alice);
    const auth = f.service.capture(alice);
    expect(auth).toBeDefined();
    expect(() => f.service.capture({ ...alice, channel: "lark" })).toThrow();
    expect(() => f.service.capture(privateAlice)).toThrow();
    f.advance(86_400_000);
    expect(() => f.service.capture(alice)).toThrow();
  });
  it("renews access without changing other chats", () => {
    const f = fixture();
    f.service.enroll(secret, f.code());
    f.advance(30_000);
    f.service.approve(privateAlice, f.service.request(alice).id, f.code());
    const original = f.service.capture(alice);
    f.advance(30_000);
    f.service.approve(privateAlice, f.service.request(privateAlice).id, f.code());
    const otherChat = f.service.capture(privateAlice);
    const otherPrincipal = { ...alice, channel: "lark" as const };
    f.advance(30_000);
    f.service.approve(
      { ...otherPrincipal, chatId: "private" },
      f.service.request(otherPrincipal).id,
      f.code(),
    );
    const otherChannel = f.service.capture(otherPrincipal);
    f.advance(180_000);
    f.service.approve(privateAlice, f.service.request(alice).id, f.code());
    const renewed = f.service.capture(alice);
    expect(renewed?.grantId).not.toBe(original?.grantId);
    expect(() => f.service.capture(alice)).not.toThrow();
    expect(() => f.service.capture(privateAlice)).not.toThrow();
    expect(() => f.service.capture(otherPrincipal)).not.toThrow();
    expect(f.service.capture(privateAlice)?.grantId).toBe(otherChat?.grantId);
    expect(f.service.capture(otherPrincipal)?.grantId).toBe(otherChannel?.grantId);
    f.advance(86_399_999);
    expect(() => f.service.capture(alice)).not.toThrow();
    f.advance(1);
    expect(() => f.service.capture(alice)).toThrow();
  });
  it("persists global replay detection and five-attempt lockout across instances", () => {
    const f = fixture();
    f.service.enroll(secret, f.code());
    for (let i = 0; i < 5; i++) {
      const req = f.service.request(alice);
      expect(() => f.service.approve(privateAlice, req.id, f.code())).toThrow();
    }
    const other = new RemoteAccessService({ directory: f.directory, now: f.now });
    expect(other.status().verificationLocked).toBe(true);
    f.advance(30_000);
    expect(() => other.approve(privateAlice, other.request(alice).id, f.code())).toThrow();
    f.advance(300_000);
    expect(() => other.approve(privateAlice, other.request(alice).id, f.code())).not.toThrow();
  });
  it("revokes across processes and never revives authorizations after resume/reset", () => {
    const f = fixture();
    f.service.enroll(secret, f.code());
    f.advance(30_000);
    f.service.approve(privateAlice, f.service.request(alice).id, f.code());
    const other = new RemoteAccessService({ directory: f.directory, now: f.now });
    other.revoke();
    expect(() => f.service.capture(alice)).toThrow();
    other.resume();
    expect(() => f.service.capture(alice)).toThrow();
    other.reset();
    expect(other.status()).toMatchObject({ enabled: true, suspended: true, enrolled: false });
    expect(() => other.resume()).toThrow();
    expect(() => other.capture(alice)).toThrow();
  });
  it("accepts a replacement key after reset and invalidates every prior grant", () => {
    const f = fixture();
    f.service.enroll(secret, f.code());
    f.advance(30_000);
    f.service.approve(privateAlice, f.service.request(alice).id, f.code());
    f.service.reset();
    const replacement = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    const code = new TOTP({ secret: replacement, digits: 6, period: 30 }).generate({
      timestamp: f.now(),
    });
    f.service.enroll(replacement, code);
    expect(f.service.status()).toMatchObject({ enabled: true, enrolled: true, suspended: false });
    expect(() => f.service.capture(alice)).toThrow();
    expect(() => f.service.capture(alice)).toThrow();
  });
  it("expires requests and locks all grants and requests for a user", () => {
    const f = fixture();
    f.service.enroll(secret, f.code());
    f.advance(30_000);
    const req = f.service.request(alice);
    f.advance(60_000);
    expect(() => f.service.approve(privateAlice, req.id, f.code())).toThrow();
    f.service.approve(privateAlice, f.service.request(alice).id, f.code());
    const pending = f.service.request(privateAlice);
    f.service.lock(alice);
    expect(() => f.service.capture(alice)).toThrow();
    expect(() => f.service.approve(privateAlice, pending.id, f.code())).toThrow();
  });
  it("serializes failed OTP updates from concurrent processes", async () => {
    const f = fixture();
    f.service.enroll(secret, f.code());
    const modulePath = fileURLToPath(
      new URL("../../src/core/security/remote-access.ts", import.meta.url),
    );
    const script = `import { RemoteAccessService } from ${JSON.stringify(modulePath)};
      const service = new RemoteAccessService({directory:process.argv[1],now:()=>Number(process.argv[2])});
      const p={channel:'telegram',userId:'alice',chatId:'private'};
      try { service.approve(p,service.request(p).id,'invalid'); } catch {}
      if(service.status().enrolled!==true) process.exit(2);`;
    const exitCodes = await Promise.all(
      Array.from(
        { length: 5 },
        () =>
          new Promise<number | null>((done, reject) => {
            const child = spawn(
              process.execPath,
              [
                "--import",
                "tsx",
                "--input-type=module",
                "-e",
                script,
                f.directory,
                String(f.now()),
              ],
              { stdio: "ignore" },
            );
            child.on("error", reject);
            child.on("exit", done);
          }),
      ),
    );
    expect(exitCodes).toEqual([0, 0, 0, 0, 0]);
    expect(f.service.status().verificationLocked).toBe(true);
  });
  it("fails closed for symlinked parent directories", () => {
    const f = fixture();
    const link = join(f.directory, "..", "linked-parent");
    symlinkSync(join(f.directory, ".."), link);
    const service = new RemoteAccessService({ directory: join(link, "security") });
    expect(() => service.status()).toThrow("Remote security state is unavailable");
  });
  it("repairs only stale process locks and leaves access suspended", () => {
    const f = fixture();
    f.service.enroll(secret, f.code());
    const lock = join(f.directory, ".remote-access.lock");
    mkdirSync(lock, { mode: 0o700 });
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid }), { mode: 0o600 });
    expect(() => f.service.repairLock()).toThrow("still running");
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: 2147483647 }));
    f.service.repairLock();
    expect(f.service.status()).toMatchObject({ enabled: true, enrolled: true, suspended: true });
    expect(() => f.service.capture(alice)).toThrow();
  });
  it("fails closed on corrupt or symlinked state without disclosing contents", () => {
    const f = fixture();
    f.service.enroll(secret, f.code());
    const path = join(f.directory, "remote-access.json");
    expect(readFileSync(path, "utf8")).toContain(secret);
    writeFileSync(path, "sensitive-corruption");
    expect(() => f.service.capture(alice)).toThrow("Remote security state is unavailable");
    rmSync(path);
    symlinkSync(join(f.directory, "missing"), path);
    expect(() => f.service.status()).toThrow("Remote security state is unavailable");
  });
});
