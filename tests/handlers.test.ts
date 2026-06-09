import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

function readRecentProjectLines(filePath: string): string[] {
  try {
    return fs.readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function sessionNameFromPath(projectPath: string, prefix: string = "tmux_proj_"): string {
  const absPath = path.resolve(projectPath);
  return prefix + absPath.replace(/\//g, "-");
}

function getRecentProjectPath(index: number, lines: string[]): string | null {
  if (index < 0 || index >= lines.length) {
    return null;
  }
  return lines[index] ?? null;
}

describe("sessionNameFromPath", () => {
  it("uses default prefix tmux_proj_", () => {
    const result = sessionNameFromPath("/Users/test/project");
    expect(result).toBe("tmux_proj_-Users-test-project");
  });

  it("uses custom prefix when provided", () => {
    const result = sessionNameFromPath("/Users/test/project", "myproj_");
    expect(result).toBe("myproj_-Users-test-project");
  });

  it("handles root path", () => {
    const result = sessionNameFromPath("/");
    expect(result).toBe("tmux_proj_-");
  });

  it("handles path with multiple consecutive slashes", () => {
    const result = sessionNameFromPath("///Users///test");
    expect(result).toBe("tmux_proj_-Users-test");
  });

  it("generates consistent names for same path", () => {
    const p = "/Users/test/project";
    expect(sessionNameFromPath(p)).toBe(sessionNameFromPath(p));
  });

  it("detects path collision: social/radar vs social-radar", () => {
    const a = sessionNameFromPath("/Users/test/social/radar");
    const b = sessionNameFromPath("/Users/test/social-radar");
    expect(a).toBe(b);
  });

  it("detects path collision: a/b/c vs a-b-c", () => {
    const a = sessionNameFromPath("/Users/test/a/b/c");
    const b = sessionNameFromPath("/Users/test/a-b-c");
    expect(a).toBe(b);
  });
});

describe("getRecentProjectPath", () => {
  const lines = ["/project/a", "/project/b", "/project/c"];

  it("returns path for valid index", () => {
    expect(getRecentProjectPath(0, lines)).toBe("/project/a");
    expect(getRecentProjectPath(1, lines)).toBe("/project/b");
    expect(getRecentProjectPath(2, lines)).toBe("/project/c");
  });

  it("returns null for negative index", () => {
    expect(getRecentProjectPath(-1, lines)).toBeNull();
  });

  it("returns null for index beyond length", () => {
    expect(getRecentProjectPath(3, lines)).toBeNull();
  });

  it("returns null for empty array", () => {
    expect(getRecentProjectPath(0, [])).toBeNull();
  });
});

describe("readRecentProjectLines", () => {
  let tempDir: string;
  let tempFile: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "handlers-test-"));
    tempFile = path.join(tempDir, "recent_projects.txt");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns empty array for non-existent file", () => {
    const result = readRecentProjectLines("/nonexistent/file.txt");
    expect(result).toEqual([]);
  });

  it("reads and parses existing file", () => {
    fs.writeFileSync(tempFile, "/project/a\n/project/b\n/project/c\n", "utf-8");
    const result = readRecentProjectLines(tempFile);
    expect(result).toEqual(["/project/a", "/project/b", "/project/c"]);
  });

  it("filters out empty lines", () => {
    fs.writeFileSync(tempFile, "/project/a\n\n/project/b\n\n\n", "utf-8");
    const result = readRecentProjectLines(tempFile);
    expect(result).toEqual(["/project/a", "/project/b"]);
  });

  it("handles file with only empty lines", () => {
    fs.writeFileSync(tempFile, "\n\n\n", "utf-8");
    const result = readRecentProjectLines(tempFile);
    expect(result).toEqual([]);
  });

  it("handles trailing newline", () => {
    fs.writeFileSync(tempFile, "/project/a\n/project/b\n", "utf-8");
    const result = readRecentProjectLines(tempFile);
    expect(result).toEqual(["/project/a", "/project/b"]);
  });

  it("handles Windows line endings", () => {
    fs.writeFileSync(tempFile, "/project/a\r\n/project/b\r\n", "utf-8");
    const result = readRecentProjectLines(tempFile);
    // Node splits on \n only, so \r remains
    expect(result).toEqual(["/project/a\r", "/project/b\r"]);
  });
});

describe("appendRecentProject behavior", () => {
  let tempDir: string;
  let tempFile: string;
  let _cache: string[] | null = null;

  function appendRecentProject(newPath: string, maxItems: number = 15): void {
    const lines = readRecentProjectLines(tempFile);
    const filtered = lines.filter((l) => l !== newPath);
    filtered.unshift(newPath);
    if (filtered.length > maxItems) {
      filtered.length = maxItems;
    }
    fs.writeFileSync(tempFile, `${filtered.join("\n")}\n`, "utf-8");
    _cache = filtered;
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "handlers-test-"));
    tempFile = path.join(tempDir, "recent_projects.txt");
    _cache = null;
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("prepends new project", () => {
    appendRecentProject("/project/a");
    const result = readRecentProjectLines(tempFile);
    expect(result).toEqual(["/project/a"]);
  });

  it("moves existing project to top", () => {
    fs.writeFileSync(tempFile, "/project/a\n/project/b\n", "utf-8");
    appendRecentProject("/project/b");
    const result = readRecentProjectLines(tempFile);
    expect(result).toEqual(["/project/b", "/project/a"]);
  });

  it("deduplicates - does not create duplicates when re-adding", () => {
    fs.writeFileSync(tempFile, "/project/a\n/project/b\n", "utf-8");
    appendRecentProject("/project/a");
    const result = readRecentProjectLines(tempFile);
    expect(result).toEqual(["/project/a", "/project/b"]);
  });

  it("respects max items limit", () => {
    // Create file with 15 items: /project/0 through /project/14
    const items = Array.from({ length: 15 }, (_, i) => `/project/${i}`);
    fs.writeFileSync(tempFile, `${items.join("\n")}\n`, "utf-8");
    appendRecentProject("/project/new");
    const result = readRecentProjectLines(tempFile);
    expect(result.length).toBe(15);
    expect(result[0]).toBe("/project/new");
    // /project/14 (oldest) should be evicted
    expect(result).not.toContain("/project/14");
    // /project/0 is still present (now second newest)
    expect(result).toContain("/project/0");
  });

  it("handles empty file", () => {
    appendRecentProject("/project/a");
    const result = readRecentProjectLines(tempFile);
    expect(result).toEqual(["/project/a"]);
  });
});

describe("cache invalidation", () => {
  let tempDir: string;
  let tempFile: string;
  let cache: string[] | null = null;

  function readCached(): string[] {
    if (cache !== null) return cache;
    try {
      cache = fs.readFileSync(tempFile, "utf-8").split("\n").filter(Boolean);
      return cache;
    } catch {
      cache = [];
      return cache;
    }
  }

  function appendAndInvalidate(newPath: string): void {
    const lines = readCached();
    const filtered = lines.filter((l) => l !== newPath);
    filtered.unshift(newPath);
    if (filtered.length > 15) filtered.length = 15;
    fs.writeFileSync(tempFile, `${filtered.join("\n")}\n`, "utf-8");
    cache = filtered;
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "handlers-test-"));
    tempFile = path.join(tempDir, "recent_projects.txt");
    cache = null;
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns cached value on subsequent reads", () => {
    fs.writeFileSync(tempFile, "/project/a\n/project/b\n", "utf-8");
    const first = readCached();
    const second = readCached();
    expect(first).toBe(second); // Same reference
  });

  it("cache is invalidated after write", () => {
    fs.writeFileSync(tempFile, "/project/a\n", "utf-8");
    readCached(); // populate cache
    appendAndInvalidate("/project/b");
    const result = readCached();
    expect(result).toEqual(["/project/b", "/project/a"]);
  });
});

describe("appendRecentProject with session dedup", () => {
  let tempDir: string;
  let tempFile: string;

  function readRecentProjectLinesForDedup(filePath: string): string[] {
    try {
      return fs.readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }

  async function appendRecentProjectWithDedup(
    newPath: string,
    prefix: string,
    filePath: string,
    maxItems: number = 15,
  ): Promise<void> {
    const newSession = sessionNameFromPath(newPath, prefix);
    const lines = readRecentProjectLinesForDedup(filePath);
    const filtered = lines.filter((l) => {
      if (l === newPath) return false;
      return sessionNameFromPath(l, prefix) !== newSession;
    });
    filtered.unshift(newPath);
    if (filtered.length > maxItems) {
      filtered.length = maxItems;
    }
    fs.writeFileSync(filePath, `${filtered.join("\n")}\n`, "utf-8");
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "handlers-dedup-test-"));
    tempFile = path.join(tempDir, "recent_projects.txt");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("deduplicates by session name when paths look different", () => {
    fs.writeFileSync(tempFile, "/Users/test/social/radar\n", "utf-8");
    appendRecentProjectWithDedup("/Users/test/social-radar", "tmux_proj_", tempFile);
    const result = readRecentProjectLinesForDedup(tempFile);
    // social/radar was removed because it maps to the same session name
    expect(result).toEqual(["/Users/test/social-radar"]);
  });

  it("keeps other projects when deduplicating", () => {
    fs.writeFileSync(tempFile, "/Users/test/social/radar\n/Users/test/other\n", "utf-8");
    appendRecentProjectWithDedup("/Users/test/social-radar", "tmux_proj_", tempFile);
    const result = readRecentProjectLinesForDedup(tempFile);
    expect(result).toEqual(["/Users/test/social-radar", "/Users/test/other"]);
  });

  it("still deduplicates exact string match", () => {
    fs.writeFileSync(tempFile, "/project/a\n/project/b\n", "utf-8");
    appendRecentProjectWithDedup("/project/a", "tmux_proj_", tempFile);
    const result = readRecentProjectLinesForDedup(tempFile);
    expect(result).toEqual(["/project/a", "/project/b"]);
  });

  it("does not remove projects with different session names", () => {
    fs.writeFileSync(tempFile, "/Users/test/social/radar\n/Users/test/social-radar2\n", "utf-8");
    appendRecentProjectWithDedup("/Users/test/social-radar", "tmux_proj_", tempFile);
    const result = readRecentProjectLinesForDedup(tempFile);
    // social-radar2 maps to a different session name, should be kept
    expect(result).toEqual(["/Users/test/social-radar", "/Users/test/social-radar2"]);
  });
});

describe("filter valid projects by directory existence", () => {
  let tempDir: string;
  let existingDir: string;
  let missingDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "handlers-filter-test-"));
    existingDir = path.join(tempDir, "exists");
    missingDir = path.join(tempDir, "missing");
    fs.mkdirSync(existingDir);
    // missingDir is NOT created
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("filters out recent projects with non-existent directories", () => {
    const lines = [existingDir, missingDir, "/totally/fake/path"];
    const validLines = lines.filter((projectPath) => fs.existsSync(projectPath));
    expect(validLines).toEqual([existingDir]);
  });

  it("returns empty array when all recent project directories are missing", () => {
    const lines = [missingDir, "/another/fake/path"];
    const validLines = lines.filter((projectPath) => fs.existsSync(projectPath));
    expect(validLines).toEqual([]);
  });

  it("keeps all recent projects when all directories exist", () => {
    const anotherDir = path.join(tempDir, "another");
    fs.mkdirSync(anotherDir);
    const lines = [existingDir, anotherDir];
    const validLines = lines.filter((projectPath) => fs.existsSync(projectPath));
    expect(validLines).toEqual([existingDir, anotherDir]);
  });

  it("filters alive sessions by mapped directory existence", () => {
    // Simulates the filtering logic in /list_alive_projects
    const sessionPathMap: Record<string, string> = {
      "tmux_proj_-Users-test-exists": existingDir,
      "tmux_proj_-Users-test-missing": missingDir,
      "tmux_proj_-Users-test-fake": "/totally/fake/path",
    };

    const sessions = Object.keys(sessionPathMap);
    const validSessions = sessions.filter((session) => {
      const projectPath = sessionPathMap[session];
      return projectPath && fs.existsSync(projectPath);
    });

    expect(validSessions).toEqual(["tmux_proj_-Users-test-exists"]);
  });

  it("excludes alive session when path map has no entry", () => {
    const sessionPathMap: Record<string, string> = {
      "tmux_proj_-Users-test-exists": existingDir,
    };
    const sessions = ["tmux_proj_-Users-test-exists", "tmux_proj_-Users-test-unknown"];
    const validSessions = sessions.filter((session) => {
      const projectPath = sessionPathMap[session];
      return projectPath && fs.existsSync(projectPath);
    });
    expect(validSessions).toEqual(["tmux_proj_-Users-test-exists"]);
  });
});
