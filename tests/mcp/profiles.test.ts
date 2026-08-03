import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  installMcpProfiles,
  mcpProfileSpec,
  parseMcpProfile,
} from "../../src/core/mcp/profiles.js";

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "tcb-mcp-profiles-"));
  tempDirs.push(dir);
  return dir;
}

describe("MCP profile specs", () => {
  it("declares Observer as read-only and Home as controlled-operation", () => {
    expect(mcpProfileSpec("observer")).toMatchObject({
      profile: "observer",
      role: "observer",
      exposure: "read-only",
      server: { command: "tmux-claude-bot", args: ["mcp", "observer"] },
    });
    expect(mcpProfileSpec("observer").tools).toContain("tcb.observer.status");
    expect(mcpProfileSpec("observer").tools).not.toContain("tcb.home.send_prompt");

    expect(mcpProfileSpec("home")).toMatchObject({
      profile: "home",
      role: "home-operator",
      exposure: "controlled-operation",
      server: { command: "tmux-claude-bot", args: ["mcp", "home"] },
    });
    expect(mcpProfileSpec("home").tools).toContain("tcb.observer.status");
    expect(mcpProfileSpec("home").tools).toContain("tcb.home.delegate_autopilot");
  });

  it("parses only supported profiles", () => {
    expect(parseMcpProfile("observer")).toBe("observer");
    expect(parseMcpProfile("home")).toBe("home");
    expect(parseMcpProfile("worker")).toBeNull();
  });

  it("installs selected profile descriptors into the operator home", () => {
    const homeDir = tempHome();

    const result = installMcpProfiles({
      homeDir,
      profiles: ["home"],
      command: "/opt/tcb/bin/tmux-claude-bot",
    });

    expect(result).toEqual([
      {
        profile: "home",
        path: join(homeDir, "mcp/home.json"),
        command: "/opt/tcb/bin/tmux-claude-bot",
        args: ["mcp", "home"],
      },
    ]);
    const installed = JSON.parse(readFileSync(join(homeDir, "mcp/home.json"), "utf8"));
    expect(installed).toMatchObject({
      profile: "home",
      server: { command: "/opt/tcb/bin/tmux-claude-bot", args: ["mcp", "home"] },
    });
  });
});
