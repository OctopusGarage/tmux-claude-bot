/**
 * Identity + lifecycle hint strings for the managed service, per OS (launchd on
 * macOS, systemd --user on Linux). Single source of truth so the doctor, the
 * instance-lock error, and the setup wizard never print a hint for the wrong OS.
 */

export const LAUNCHD_LABEL = "com.octopusgarage.tmux-claude-bot";
export const SYSTEMD_UNIT = "tmux-claude-bot";

const onLinux = (): boolean => process.platform === "linux";

/** Human label for the managed service ("launchd agent …" / "systemd unit …"). */
export function managedServiceName(): string {
  return onLinux() ? `systemd unit ${SYSTEMD_UNIT}` : `launchd agent ${LAUNCHD_LABEL}`;
}

/** The command to restart the managed service on the current OS. */
export function managedRestartCommand(): string {
  return onLinux()
    ? `systemctl --user restart ${SYSTEMD_UNIT}`
    : `launchctl kickstart -k gui/$(id -u)/${LAUNCHD_LABEL}`;
}

/** Probe to check whether the managed service is loaded/registered: run it, exit
 * 0 means loaded. (`systemctl --user is-enabled` on Linux mirrors `launchctl
 * print` on macOS — both report "registered", not necessarily "running"; the
 * single-instance check covers "running".) */
export function managedServiceLoadedProbe(): { cmd: string; args: string[] } {
  return onLinux()
    ? { cmd: "systemctl", args: ["--user", "is-enabled", "--quiet", SYSTEMD_UNIT] }
    : { cmd: "launchctl", args: ["print", `gui/${process.getuid?.() ?? 0}/${LAUNCHD_LABEL}`] };
}

/** OS-appropriate hint for installing tmux. */
export function tmuxInstallHint(): string {
  return onLinux()
    ? "sudo apt install tmux (or your distro's package manager)"
    : "brew install tmux";
}
