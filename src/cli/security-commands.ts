import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import { Secret, TOTP } from "otpauth";
import qrcode from "qrcode-terminal";
import { RemoteAccessError, RemoteAccessService } from "../core/security/remote-access.js";
import { appStateFile } from "../shared/state-dir.js";

type SecurityCommandOptions = {
  service?: RemoteAccessService;
  isTTY?: () => boolean;
  ask?: (question: string) => Promise<string>;
  write?: (text: string) => void;
};

/** Secrets are displayed only by the explicitly interactive local enrollment command. */
export function registerSecurityCommands(
  program: Command,
  options: SecurityCommandOptions = {},
): void {
  const getService = () =>
    options.service ?? new RemoteAccessService({ directory: appStateFile("security") });
  const write = options.write ?? console.log;
  const isTTY = options.isTTY ?? (() => Boolean(process.stdin.isTTY && process.stdout.isTTY));
  const ask =
    options.ask ??
    (async (question: string) => {
      const input = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await input.question(question);
      } finally {
        input.close();
      }
    });
  const requireTTY = () => {
    if (!isTTY())
      throw new RemoteAccessError("This command requires an interactive local terminal.");
  };
  const security = program
    .command("security")
    .description("manage local remote-access approval security");
  security
    .command("status")
    .description("show redacted remote security status")
    .option("--json", "output JSON")
    .action(() => {
      write(JSON.stringify(getService().status()));
    });
  security
    .command("grant-hours <hours>")
    .description("set the lifetime of future chat approvals in whole hours (default: 24)")
    .action((hours: string) => {
      if (!/^\d+$/.test(hours))
        throw new RemoteAccessError("Grant hours must be a positive whole number.");
      const service = getService();
      service.setGrantHours(Number(hours));
      write(JSON.stringify(service.status()));
    });
  security
    .command("setup")
    .description("enroll an authenticator using this local terminal")
    .action(async () => {
      requireTTY();
      const service = getService();
      if (service.status().enrolled)
        throw new RemoteAccessError("Security is already enrolled. Reset locally before setup.");
      const secret = new Secret({ size: 20 });
      const otp = new TOTP({
        issuer: "tmux-claude-bot",
        label: "Remote access",
        algorithm: "SHA1",
        digits: 6,
        period: 30,
        secret,
      });
      write("Scan this QR code in your authenticator. Keep the enrollment URI private.");
      write(
        await new Promise<string>((done) => qrcode.generate(otp.toString(), { small: true }, done)),
      );
      write(otp.toString());
      const code = (await ask("Enter the six-digit authenticator code: ")).trim();
      service.enroll(secret.base32, code);
      write("Remote access security is enabled. Remote chats now require approval.");
    });
  security
    .command("revoke")
    .description("suspend remote access and invalidate all approvals")
    .action(() => {
      getService().revoke();
      write("Remote access is suspended. All approvals are invalidated.");
    });
  security
    .command("resume")
    .description("resume remote access with fresh approvals required")
    .action(() => {
      getService().resume();
      write("Remote access resumed. Fresh approvals are required.");
    });
  security
    .command("repair-lock")
    .description("recover a stale security lock after stopping the service")
    .action(async () => {
      requireTTY();
      if (
        (await ask(
          "Stop the TCB service first. Type STOPPED to repair the stale lock and suspend remote access: ",
        )) !== "STOPPED"
      )
        throw new RemoteAccessError("Security lock repair cancelled.");
      getService().repairLock();
      write("Security lock repaired. Remote access is suspended. Resume locally when ready.");
    });
  security
    .command("reset")
    .description("remove enrollment while keeping remote access suspended")
    .action(async () => {
      requireTTY();
      if ((await ask("Type RESET to remove enrollment and suspend remote access: ")) !== "RESET")
        throw new RemoteAccessError("Security reset cancelled.");
      getService().reset();
      write("Enrollment removed. Remote access remains suspended. Run security setup locally.");
    });
}
