import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  type Stats,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { TOTP } from "otpauth";
import { z } from "zod";

export type RemotePrincipal = { channel: "telegram" | "lark"; userId: string; chatId: string };
export type RemoteAuthorization = {
  principal: RemotePrincipal;
  grantId: string;
  generation: string;
};
const stateSchema = z
  .object({
    version: z.literal(1),
    enabled: z.boolean(),
    suspended: z.boolean(),
    generation: z.string().uuid(),
    secret: z
      .string()
      .regex(/^[A-Z2-7]{16,}$/)
      .nullable(),
    lastCounter: z.number().int().min(-1),
    failures: z.number().int().min(0).max(4),
    lockedUntil: z.number().nonnegative(),
    grantTtlSeconds: z.number().int().positive().safe().default(86_400),
  })
  .strict();
type State = z.infer<typeof stateSchema>;
type Request = { principal: RemotePrincipal; expiresAt: number; generation: string };
type Grant = Request & { id: string };
export class RemoteAccessError extends Error {
  constructor(message = "Remote access is locked. Request approval in a private chat.") {
    super(message);
    this.name = "RemoteAccessError";
  }
}
const unavailable = () =>
  new RemoteAccessError("Remote security state is unavailable. Use local security commands.");
const sameUser = (a: RemotePrincipal, b: RemotePrincipal) =>
  a.channel === b.channel && a.userId === b.userId;
const samePrincipal = (a: RemotePrincipal, b: RemotePrincipal) =>
  sameUser(a, b) && a.chatId === b.chatId;
const totp = (secret: string) => new TOTP({ secret, algorithm: "SHA1", digits: 6, period: 30 });

/** Local durable policy and OTP replay protection; remote grants remain process-local. */
export class RemoteAccessService {
  private readonly directory: string;
  private readonly now: () => number;
  private readonly requests = new Map<string, Request>();
  private readonly grants = new Map<string, Grant>();
  constructor(options: { directory: string; now?: () => number }) {
    this.directory = resolve(options.directory);
    this.now = options.now ?? Date.now;
  }

  private checkDirectory(): void {
    try {
      // macOS system aliases are root-owned; application-controlled symlinks fail closed.
      let ancestor = this.directory;
      for (;;) {
        try {
          const info = lstatSync(ancestor);
          const systemAlias =
            process.platform === "darwin" &&
            info.uid === 0 &&
            ["/var", "/tmp", "/etc"].includes(ancestor);
          if (info.isSymbolicLink() && !systemAlias) throw unavailable();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw unavailable();
        }
        const parent = dirname(ancestor);
        if (parent === ancestor) break;
        ancestor = parent;
      }
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const info = lstatSync(this.directory);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        info.uid !== process.getuid?.() ||
        (info.mode & 0o077) !== 0
      )
        throw unavailable();
    } catch {
      throw unavailable();
    }
  }
  private read(): State {
    const path = join(this.directory, "remote-access.json");
    let fd: number;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // A dangling symlink also reports ENOENT; never interpret it as legacy policy.
        try {
          lstatSync(path);
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code === "ENOENT")
            return {
              version: 1,
              enabled: false,
              suspended: false,
              generation: randomUUID(),
              secret: null,
              lastCounter: -1,
              failures: 0,
              lockedUntil: 0,
              grantTtlSeconds: 86_400,
            };
        }
      }
      throw unavailable();
    }
    try {
      const info = fstatSync(fd);
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.uid !== process.getuid?.() ||
        (info.mode & 0o077) !== 0 ||
        info.size > 4096
      )
        throw unavailable();
      const state = stateSchema.parse(JSON.parse(readFileSync(fd, "utf8")));
      if (
        (!state.enabled && (state.secret !== null || state.suspended)) ||
        (state.enabled && !state.secret && !state.suspended)
      )
        throw unavailable();
      return state;
    } catch {
      throw unavailable();
    } finally {
      closeSync(fd);
    }
  }
  private save(state: State): void {
    const temp = join(this.directory, `.remote-access-${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      fd = openSync(
        temp,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      writeFileSync(fd, JSON.stringify(state));
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temp, join(this.directory, "remote-access.json"));
      const dir = openSync(this.directory, constants.O_RDONLY);
      try {
        fsyncSync(dir);
      } finally {
        closeSync(dir);
      }
    } catch {
      throw unavailable();
    } finally {
      if (fd !== undefined) closeSync(fd);
      rmSync(temp, { force: true });
    }
  }
  private transaction<T>(action: (state: State) => T): T {
    this.checkDirectory();
    const lock = join(this.directory, ".remote-access.lock");
    const deadline = Date.now() + 2_000;
    for (;;) {
      try {
        mkdirSync(lock, { mode: 0o700 });
        try {
          writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid }), {
            mode: 0o600,
            flag: "wx",
          });
        } catch {
          rmSync(lock, { recursive: true, force: true });
          throw unavailable();
        }
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline)
          throw unavailable();
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    try {
      return action(this.read());
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  }
  status() {
    return this.transaction((state) => ({
      enabled: state.enabled,
      enrolled: state.secret !== null,
      suspended: state.suspended,
      grantTtlSeconds: state.grantTtlSeconds,
      verificationLocked: state.lockedUntil > this.now(),
      verificationLockedUntil: state.lockedUntil > this.now() ? state.lockedUntil : null,
    }));
  }
  /** Configure future approvals without interrupting access already granted. */
  setGrantHours(hours: number): void {
    const milliseconds = hours * 3_600_000;
    if (
      !Number.isSafeInteger(hours) ||
      hours <= 0 ||
      !Number.isSafeInteger(milliseconds + this.now())
    )
      throw new RemoteAccessError(
        "Grant hours must be a positive whole number within the supported timestamp range.",
      );
    this.transaction((state) => {
      state.grantTtlSeconds = hours * 3600;
      this.save(state);
    });
  }
  private ensureActive(state: State): void {
    if (!state.enabled || state.suspended || !state.secret) throw new RemoteAccessError();
  }
  private verify(state: State, secret: string, code: string): boolean {
    if (state.lockedUntil > this.now())
      throw new RemoteAccessError("Verification is temporarily locked. Try again later.");
    const delta = /^\d{6}$/.test(code)
      ? totp(secret).validate({ token: code, timestamp: this.now(), window: 1 })
      : null;
    const counter = Math.floor(this.now() / 30_000) + (delta ?? 0);
    if (delta === null || counter <= state.lastCounter) {
      state.failures += 1;
      if (state.failures >= 5) {
        state.failures = 0;
        state.lockedUntil = this.now() + 300_000;
      }
      this.save(state);
      return false;
    }
    state.lastCounter = counter;
    state.failures = 0;
    state.lockedUntil = 0;
    return true;
  }
  enroll(secret: string, code: string): void {
    this.transaction((state) => {
      if (state.secret !== null)
        throw new RemoteAccessError("Security is already enrolled. Reset locally before setup.");
      if (!/^[A-Z2-7]{16,}$/.test(secret))
        throw new RemoteAccessError("Invalid enrollment secret.");
      if (!this.verify(state, secret, code)) throw new RemoteAccessError("Verification failed.");
      state.secret = secret;
      state.enabled = true;
      state.suspended = false;
      state.generation = randomUUID();
      this.save(state);
      this.requests.clear();
      this.grants.clear();
    });
  }
  request(principal: RemotePrincipal): { id: string; expiresAt: number } {
    return this.transaction((state) => {
      this.ensureActive(state);
      this.prune();
      // One outstanding request per remote identity/chat limits untrusted memory growth.
      for (const [id, req] of this.requests)
        if (samePrincipal(principal, req.principal)) this.requests.delete(id);
      if (this.requests.size >= 1000)
        throw new RemoteAccessError("Too many pending approvals. Try again later.");
      const id = randomUUID();
      const expiresAt = this.now() + 60_000;
      this.requests.set(id, {
        principal: { ...principal },
        expiresAt,
        generation: state.generation,
      });
      return { id, expiresAt };
    });
  }
  approve(
    principal: RemotePrincipal,
    requestId: string,
    code: string,
  ): { principal: RemotePrincipal; expiresAt: number } {
    return this.transaction((state) => {
      this.ensureActive(state);
      this.prune();
      const req = this.requests.get(requestId);
      if (!req || req.generation !== state.generation || !sameUser(req.principal, principal))
        throw new RemoteAccessError("Approval request is invalid or expired.");
      if (!this.verify(state, state.secret as string, code))
        throw new RemoteAccessError("Verification failed.");
      this.save(state);
      this.requests.delete(requestId);
      const id = randomUUID();
      const expiresAt = this.now() + state.grantTtlSeconds * 1000;
      for (const [grantId, grant] of this.grants) {
        if (samePrincipal(grant.principal, req.principal)) this.grants.delete(grantId);
      }
      this.grants.set(id, {
        id,
        principal: { ...req.principal },
        expiresAt,
        generation: state.generation,
      });
      return { principal: { ...req.principal }, expiresAt };
    });
  }
  capture(principal: RemotePrincipal): RemoteAuthorization | undefined {
    return this.transaction((state) => {
      if (!state.enabled && !state.suspended) return undefined;
      this.ensureActive(state);
      this.prune();
      const grant = [...this.grants.values()].find(
        (g) => g.generation === state.generation && samePrincipal(g.principal, principal),
      );
      if (!grant) throw new RemoteAccessError();
      return { principal: { ...principal }, grantId: grant.id, generation: grant.generation };
    });
  }
  lock(principal: RemotePrincipal): void {
    this.transaction(() => {
      for (const [id, request] of this.requests)
        if (sameUser(request.principal, principal)) this.requests.delete(id);
      for (const [id, grant] of this.grants)
        if (sameUser(grant.principal, principal)) this.grants.delete(id);
    });
  }
  private prune(): void {
    for (const [id, request] of this.requests)
      if (request.expiresAt <= this.now()) this.requests.delete(id);
    for (const [id, grant] of this.grants)
      if (grant.expiresAt <= this.now()) this.grants.delete(id);
  }
  private change(action: "revoke" | "resume" | "reset"): void {
    this.transaction((state) => {
      if (action === "resume" && !state.secret)
        throw new RemoteAccessError("Enroll locally before resuming remote access.");
      state.enabled = true;
      state.suspended = action !== "resume";
      state.generation = randomUUID();
      if (action === "reset") {
        state.secret = null;
        state.lastCounter = -1;
      }
      this.save(state);
      this.requests.clear();
      this.grants.clear();
    });
  }
  /** Interactive local recovery only. The operator must stop the service first. */
  repairLock(): void {
    this.checkDirectory();
    const lock = join(this.directory, ".remote-access.lock");
    let info: Stats | undefined;
    try {
      info = lstatSync(lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw unavailable();
    }
    if (info) {
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        info.uid !== process.getuid?.() ||
        (info.mode & 0o077) !== 0
      )
        throw unavailable();
      const ownerPath = join(lock, "owner.json");
      let owner: { pid: number } | undefined;
      let fd: number | undefined;
      try {
        fd = openSync(ownerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        const stat = fstatSync(fd);
        if (
          !stat.isFile() ||
          stat.nlink !== 1 ||
          stat.uid !== process.getuid() ||
          (stat.mode & 0o077) !== 0 ||
          stat.size > 128
        )
          throw unavailable();
        owner = z
          .object({ pid: z.number().int().positive() })
          .strict()
          .parse(JSON.parse(readFileSync(fd, "utf8")));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw unavailable();
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
      if (owner) {
        try {
          process.kill(owner.pid, 0);
          throw new RemoteAccessError(
            "The security lock owner is still running. Stop the service before repair.",
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      } else if (Date.now() - info.mtimeMs < 30_000) {
        throw new RemoteAccessError(
          "The security lock is recent. Stop the service and wait 30 seconds before repair.",
        );
      }
      // Claim this stale directory exclusively so concurrent repair commands cannot remove a new lock.
      const claim = join(lock, ".repair-claim");
      let claimFd: number;
      try {
        claimFd = openSync(
          claim,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
      } catch {
        throw new RemoteAccessError("Security lock repair is already in progress.");
      }
      closeSync(claimFd);
      try {
        const current = lstatSync(lock);
        if (current.ino !== info.ino || current.dev !== info.dev) throw unavailable();
        const state = this.read();
        state.enabled = true;
        state.suspended = true;
        state.generation = randomUUID();
        this.save(state);
        this.requests.clear();
        this.grants.clear();
        rmSync(lock, { recursive: true });
        return;
      } catch {
        rmSync(claim, { force: true });
        throw unavailable();
      }
    }
    this.revoke();
  }
  revoke(): void {
    this.change("revoke");
  }
  resume(): void {
    this.change("resume");
  }
  reset(): void {
    this.change("reset");
  }
}
