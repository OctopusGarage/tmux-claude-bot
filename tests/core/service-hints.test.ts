import { afterEach, describe, expect, it } from "vitest";
import {
  managedRestartCommand,
  managedServiceLoadedProbe,
  managedServiceName,
  tmuxInstallHint,
} from "../../src/core/platform/service-hints.js";

const realPlatform = process.platform;
const setPlatform = (p: NodeJS.Platform) =>
  Object.defineProperty(process, "platform", { value: p, configurable: true });
afterEach(() => setPlatform(realPlatform));

describe("service-hints per platform", () => {
  it("Linux: systemd unit + systemctl --user restart + apt hint", () => {
    setPlatform("linux");
    expect(managedServiceName()).toBe("systemd unit tmux-claude-bot");
    expect(managedRestartCommand()).toBe("systemctl --user restart tmux-claude-bot");
    expect(tmuxInstallHint()).toContain("apt install tmux");
    expect(managedServiceLoadedProbe()).toEqual({
      cmd: "systemctl",
      args: ["--user", "is-enabled", "--quiet", "tmux-claude-bot"],
    });
  });

  it("macOS: launchd agent + launchctl kickstart + brew hint", () => {
    setPlatform("darwin");
    expect(managedServiceName()).toContain("launchd agent");
    expect(managedRestartCommand()).toContain("launchctl kickstart -k");
    expect(tmuxInstallHint()).toBe("brew install tmux");
    expect(managedServiceLoadedProbe().cmd).toBe("launchctl");
  });
});
