import { describe, expect, it } from "vitest";
import { profileFor } from "../src/core/agents/registry.js";

describe("agent registry", () => {
  it("returns the claude profile for kind 'claude'", () => {
    expect(profileFor("claude").kind).toBe("claude");
  });
  it("returns the codex profile for kind 'codex'", () => {
    expect(profileFor("codex").kind).toBe("codex");
  });
  it("exposes the right config-dir env var per agent", () => {
    expect(profileFor("claude").configDirEnv).toBe("CLAUDE_CONFIG_DIR");
    expect(profileFor("codex").configDirEnv).toBe("CODEX_HOME");
  });
});
