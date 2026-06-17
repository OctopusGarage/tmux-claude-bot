import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  getPathBySession,
  isCdAllowed,
  sessionNameFromPath,
  setPathForSession,
} from "../src/core/projects/sessionPathMap.js";

// The session map resolves under TCB_STATE_DIR (set to a temp dir by tests/setup.ts),
// falling back to the project root — target the same location the functions use.
const MAP_FILE = path.join(
  process.env.TCB_STATE_DIR ?? path.resolve(path.dirname(new URL(import.meta.url).pathname), ".."),
  "session_path_map.json",
);

let originalContent: string | null = null;

describe("sessionNameFromPath", () => {
  it("converts absolute path to session name with single dash separator", () => {
    const result = sessionNameFromPath("/Users/test/project", "tmux_proj_");
    expect(result).toBe("tmux_proj_-Users-test-project");
  });

  it("converts relative path after resolving", () => {
    const result = sessionNameFromPath("./project", "tmux_proj_");
    // Resolved to absolute path, then slashes replaced with hyphens
    expect(result.startsWith("tmux_proj_-")).toBe(true);
  });

  it("handles paths with hyphens in directory names", () => {
    const result = sessionNameFromPath("/Users/test/tmux-claude-bot", "tmux_proj_");
    expect(result).toBe("tmux_proj_-Users-test-tmux-claude-bot");
  });

  it("handles paths with spaces", () => {
    const result = sessionNameFromPath("/Users/test/my project", "tmux_proj_");
    expect(result).toBe("tmux_proj_-Users-test-my project");
  });

  it("uses provided prefix", () => {
    const result = sessionNameFromPath("/home/user/app", "custom_");
    expect(result).toBe("custom_-home-user-app");
  });

  it("preserves underscores in directory names", () => {
    const result = sessionNameFromPath("/Users/test/social_media_posts", "tmux_proj_");
    expect(result).toBe("tmux_proj_-Users-test-social_media_posts");
  });

  it("preserves underscores and hyphens together", () => {
    const result = sessionNameFromPath("/Users/test/tmux-claude-bot", "tmux_proj_");
    expect(result).toBe("tmux_proj_-Users-test-tmux-claude-bot");
  });
});

describe("getPathBySession", () => {
  beforeAll(() => {
    if (fs.existsSync(MAP_FILE)) {
      originalContent = fs.readFileSync(MAP_FILE, "utf-8");
    }
  });

  afterAll(() => {
    if (originalContent !== null) {
      fs.writeFileSync(MAP_FILE, originalContent, "utf-8");
    } else if (fs.existsSync(MAP_FILE)) {
      fs.unlinkSync(MAP_FILE);
    }
  });

  beforeEach(() => {
    fs.writeFileSync(MAP_FILE, "{}", "utf-8");
  });

  it("returns mapped path when session exists in map", () => {
    const session = "tmux_proj_-Users-test-project";
    const projectPath = "/Users/test/project";
    setPathForSession(session, projectPath);
    const result = getPathBySession(session);
    expect(result).toBe(projectPath);
  });

  it("returns null when session is not in map", () => {
    const result = getPathBySession("tmux_proj_-Users-test-project");
    expect(result).toBeNull();
  });

  it("returns null for unknown session", () => {
    const result = getPathBySession("nonexistent_session");
    expect(result).toBeNull();
  });

  it("returns null for empty string", () => {
    const result = getPathBySession("");
    expect(result).toBeNull();
  });

  it("reads fresh from file on every call (no stale cache)", () => {
    const session = "tmux_proj_-Users-test-project";
    // First call: session not in map
    expect(getPathBySession(session)).toBeNull();
    // Write to file directly (simulating external update)
    fs.writeFileSync(MAP_FILE, JSON.stringify({ [session]: "/Users/test/project" }), "utf-8");
    // Second call: should see the new value without any cache
    expect(getPathBySession(session)).toBe("/Users/test/project");
  });
});

describe("setPathForSession", () => {
  beforeAll(() => {
    if (fs.existsSync(MAP_FILE)) {
      originalContent = fs.readFileSync(MAP_FILE, "utf-8");
    }
  });

  afterAll(() => {
    if (originalContent !== null) {
      fs.writeFileSync(MAP_FILE, originalContent, "utf-8");
    } else if (fs.existsSync(MAP_FILE)) {
      fs.unlinkSync(MAP_FILE);
    }
  });

  beforeEach(() => {
    fs.writeFileSync(MAP_FILE, "{}", "utf-8");
  });

  it("persists session-to-path mapping to file", () => {
    setPathForSession("tmux_proj_test", "/path/to/project");
    const raw = fs.readFileSync(MAP_FILE, "utf-8");
    const map = JSON.parse(raw) as Record<string, string>;
    expect(map.tmux_proj_test).toBe("/path/to/project");
  });

  it("overwrites existing entry", () => {
    setPathForSession("tmux_proj_test", "/old/path");
    setPathForSession("tmux_proj_test", "/new/path");
    const raw = fs.readFileSync(MAP_FILE, "utf-8");
    const map = JSON.parse(raw) as Record<string, string>;
    expect(map.tmux_proj_test).toBe("/new/path");
  });

  it("preserves other entries when adding new one", () => {
    setPathForSession("session_a", "/path/a");
    setPathForSession("session_b", "/path/b");
    const raw = fs.readFileSync(MAP_FILE, "utf-8");
    const map = JSON.parse(raw) as Record<string, string>;
    expect(map.session_a).toBe("/path/a");
    expect(map.session_b).toBe("/path/b");
  });
});

describe("isCdAllowed", () => {
  it("allows any path when allowed list is empty", () => {
    expect(isCdAllowed("/any/path", [])).toBe(true);
  });

  it("allows path under allowed directory", () => {
    expect(isCdAllowed("/Users/test/projects/myapp", ["/Users/test/projects"])).toBe(true);
  });

  it("allows exact allowed directory", () => {
    expect(isCdAllowed("/Users/test/projects", ["/Users/test/projects"])).toBe(true);
  });

  it("rejects path outside allowed directory", () => {
    expect(isCdAllowed("/Users/other/projects", ["/Users/test/projects"])).toBe(false);
  });

  it("expands tilde to home directory", () => {
    const home = process.env.HOME ?? "/home";
    expect(isCdAllowed(`${home}/projects/app`, ["~/projects"])).toBe(true);
  });

  it("rejects sibling of allowed directory", () => {
    expect(isCdAllowed("/Users/test/other", ["/Users/test/projects"])).toBe(false);
  });

  it("requires trailing slash prefix match (not partial)", () => {
    // /Users/test/project should NOT match /Users/test/proj
    expect(isCdAllowed("/Users/test/projects", ["/Users/test/proj"])).toBe(false);
  });

  it("rejects a path that escapes the allowed dir via .. (must normalize before matching)", () => {
    // Raw prefix-matching would accept this (it textually starts with the allowed
    // dir) even though it resolves OUTSIDE it — a traversal bypass of the gate.
    expect(isCdAllowed("/Users/test/projects/../secret", ["/Users/test/projects"])).toBe(false);
    expect(isCdAllowed("/Users/test/projects/../projects/app", ["/Users/test/projects"])).toBe(
      true,
    );
  });

  it("rejects a symlink inside an allowed root that escapes it (realpath, not just lexical)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tcb-cd-"));
    try {
      const root = fs.realpathSync(fs.mkdtempSync(path.join(tmp, "root-")));
      const outside = fs.realpathSync(fs.mkdtempSync(path.join(tmp, "out-")));
      const okDir = path.join(root, "real-proj");
      fs.mkdirSync(okDir);
      const escapeLink = path.join(root, "escape");
      fs.symlinkSync(outside, escapeLink); // root/escape -> /…/out-XXXX (outside the root)

      expect(isCdAllowed(okDir, [root])).toBe(true); // a genuine subdir is fine
      expect(isCdAllowed(escapeLink, [root])).toBe(false); // the symlink resolves outside
      expect(isCdAllowed(path.join(escapeLink, "sub"), [root])).toBe(false); // and paths through it
      // a not-yet-created dir under a symlinked PARENT is caught via the ancestor realpath
      expect(isCdAllowed(path.join(escapeLink, "newproj"), [root])).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("isCdAllowed (property-based)", () => {
  // Reference oracle = the SECURITY SPEC stated independently: the allow check
  // must hold on the RESOLVED target (so `..` can't traverse out), prefix-matched
  // on a path-segment boundary. The property pins the gate to this spec and would
  // catch any regression that compares the raw (un-normalized) target.
  const reference = (target: string, allowed: readonly string[]): boolean => {
    if (allowed.length === 0) return true;
    const t = path.resolve(target);
    return allowed.some((d) => {
      const r = path.resolve(d);
      return t === r || t.startsWith(`${r}${path.sep}`);
    });
  };

  // Root under a deep, guaranteed-NONEXISTENT base so isCdAllowed's symlink
  // canonicalization stays lexical-equivalent here (nothing on these paths exists,
  // and the padding depth keeps the ≤6 `..` segments from climbing to `/` and into
  // a real symlinked system dir like /etc → /private/etc on macOS). This pins the
  // `..`-normalization + segment-boundary logic; the symlink behavior is covered
  // by the dedicated realpath test above.
  const PAD = "/__tcb_nonexistent__/p0/p1/p2/p3/p4/p5/p6/p7";
  const ROOTS = [`${PAD}/allow/root`, `${PAD}/srv/data`, `${PAD}/home/u/work`];
  // Segments deliberately include `..`/`.` and names that collide with the roots,
  // so generated targets both escape and re-enter the allowed dirs.
  const seg = fc.constantFrom("a", "b", "root", "work", "data", "..", ".", "secret", "x");

  it("matches the resolve-then-prefix spec for adversarial paths (incl. .. traversal)", () => {
    const targetArb = fc
      .tuple(fc.constantFrom(...ROOTS), fc.array(seg, { maxLength: 6 }))
      .map(([base, segs]) => (segs.length ? `${base}/${segs.join("/")}` : base));
    const allowedArb = fc.uniqueArray(fc.constantFrom(...ROOTS), { minLength: 0, maxLength: 3 });

    fc.assert(
      fc.property(targetArb, allowedArb, (target, allowed) => {
        expect(isCdAllowed(target, allowed)).toBe(reference(target, allowed));
      }),
      { numRuns: 300 },
    );
  });
});
