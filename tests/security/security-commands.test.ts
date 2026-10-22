import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { URI } from "otpauth";
import { describe, expect, it, vi } from "vitest";
import { registerSecurityCommands } from "../../src/cli/security-commands.js";
import { RemoteAccessService } from "../../src/core/security/remote-access.js";

describe("local security commands", () => {
  it("refuses setup without local input and output TTYs before displaying secrets", async () => {
    const program = new Command();
    const output = vi.fn();
    const enroll = vi.fn();
    registerSecurityCommands(program, {
      isTTY: () => false,
      write: output,
      service: { enroll } as never,
    });
    await expect(program.parseAsync(["node", "tcb", "security", "setup"])).rejects.toThrow(
      "interactive local terminal",
    );
    expect(output).not.toHaveBeenCalled();
    expect(enroll).not.toHaveBeenCalled();
  });
  it("enrolls from the local QR URI and keeps reset suspended until setup", async () => {
    const directory = mkdtempSync(join(tmpdir(), "security-cli-"));
    try {
      const service = new RemoteAccessService({ directory });
      let uri = "";
      const options = {
        service,
        isTTY: () => true,
        write: (text: string) => {
          if (text.startsWith("otpauth://")) uri = text;
        },
        ask: async () => URI.parse(uri).generate(),
      };
      const program = new Command();
      registerSecurityCommands(program, options);
      await program.parseAsync(["node", "tcb", "security", "setup"]);
      expect(service.status()).toMatchObject({ enabled: true, enrolled: true });
      const reset = new Command();
      registerSecurityCommands(reset, { ...options, ask: async () => "RESET" });
      await reset.parseAsync(["node", "tcb", "security", "reset"]);
      expect(service.status()).toMatchObject({ enabled: true, enrolled: false, suspended: true });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("shows sanitized status and invokes explicit local state controls", async () => {
    const output = vi.fn();
    const revoke = vi.fn();
    const resume = vi.fn();
    const service = {
      status: () => ({ enabled: true, enrolled: true, suspended: false }),
      revoke,
      resume,
    };
    for (const command of ["status", "revoke", "resume"]) {
      const program = new Command();
      registerSecurityCommands(program, { service: service as never, write: output });
      await program.parseAsync(["node", "tcb", "security", command]);
    }
    expect(output.mock.calls[0]?.[0]).toContain('"enabled":true');
    expect(revoke).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledOnce();
  });
  it("repairs locks only after the local operator confirms service shutdown", async () => {
    const repairLock = vi.fn();
    const service = { repairLock } as never;
    for (const answer of ["no", "STOPPED"]) {
      const program = new Command();
      registerSecurityCommands(program, {
        service,
        isTTY: () => true,
        ask: async () => answer,
        write: vi.fn(),
      });
      const result = program.parseAsync(["node", "tcb", "security", "repair-lock"]);
      if (answer === "no") await expect(result).rejects.toThrow("cancelled");
      else await result;
    }
    expect(repairLock).toHaveBeenCalledOnce();
  });
  it("requires an interactive typed confirmation before reset", async () => {
    const reset = vi.fn();
    const program = new Command();
    registerSecurityCommands(program, {
      isTTY: () => true,
      ask: async () => "no",
      write: vi.fn(),
      service: { reset } as never,
    });
    await expect(program.parseAsync(["node", "tcb", "security", "reset"])).rejects.toThrow(
      "cancelled",
    );
    expect(reset).not.toHaveBeenCalled();
  });
});
