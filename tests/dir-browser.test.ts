import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  browseCwd,
  browseRoots,
  clearBrowse,
  createSubfolder,
  displayPath,
  isAwaitingFolderName,
  listSubdirs,
  requestNewFolder,
  resolveBrowseAction,
  startBrowse,
} from "../src/core/dir-browser.js";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tcb-browse-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("browseRoots", () => {
  it("falls back to $HOME when the allow-list is empty (never unrestricted)", () => {
    expect(browseRoots([])).toEqual([os.homedir()]);
  });
  it("resolves and expands the configured roots", () => {
    expect(browseRoots([root])).toEqual([path.resolve(root)]);
  });
});

describe("displayPath", () => {
  it("compresses a leading $HOME to ~", () => {
    expect(displayPath(os.homedir())).toBe("~");
    expect(displayPath(path.join(os.homedir(), "a", "b"))).toBe("~/a/b");
  });
  it("leaves non-home paths untouched", () => {
    expect(displayPath("/srv/data")).toBe("/srv/data");
  });
});

describe("listSubdirs", () => {
  it("lists real directories sorted, skipping files and hidden dirs", () => {
    fs.mkdirSync(path.join(root, "b"));
    fs.mkdirSync(path.join(root, "a"));
    fs.mkdirSync(path.join(root, ".hidden"));
    fs.writeFileSync(path.join(root, "file.txt"), "x");
    const { entries, error } = listSubdirs(root, [root]);
    expect(error).toBeUndefined();
    expect(entries.map((e) => e.name)).toEqual(["a", "b"]);
  });

  it("skips symlinks (prevents escape past a root and traversal cycles)", () => {
    fs.mkdirSync(path.join(root, "real"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "tcb-outside-"));
    fs.symlinkSync(outside, path.join(root, "link"));
    const { entries } = listSubdirs(root, [root]);
    expect(entries.map((e) => e.name)).toEqual(["real"]);
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it("returns escaped when the path is outside the roots", () => {
    const { error } = listSubdirs("/etc", [root]);
    expect(error).toBe("escaped");
  });

  it("flags directories that contain a .git as repos in the view", () => {
    fs.mkdirSync(path.join(root, "plain"));
    fs.mkdirSync(path.join(root, "repo"));
    fs.mkdirSync(path.join(root, "repo", ".git"));
    const view = startBrowse("repo-scope", [root]);
    const byName = Object.fromEntries(view.entries.map((e) => [e.label, e.isRepo]));
    expect(byName.repo).toBe(true);
    expect(byName.plain).toBe(false);
    clearBrowse("repo-scope");
  });

  it("returns unreadable for a nonexistent directory", () => {
    const { error } = listSubdirs(path.join(root, "nope"), [root]);
    expect(error).toBe("unreadable");
  });
});

describe("startBrowse", () => {
  it("drops straight into the only root", () => {
    const view = startBrowse("s1", [root]);
    expect(view.kind).toBe("dir");
    expect(view.cwd).toBe(path.resolve(root));
    clearBrowse("s1");
  });

  it("shows a roots-selection screen when there are several roots", () => {
    const root2 = fs.mkdtempSync(path.join(os.tmpdir(), "tcb-browse2-"));
    const view = startBrowse("s2", [root, root2]);
    expect(view.kind).toBe("roots");
    expect(view.cwd).toBeNull();
    expect(view.entries).toHaveLength(2);
    expect(view.canCreate).toBe(false);
    clearBrowse("s2");
    fs.rmSync(root2, { recursive: true, force: true });
  });
});

describe("resolveBrowseAction", () => {
  it("descends into a subdir on open, then back up", () => {
    fs.mkdirSync(path.join(root, "child"));
    startBrowse("s3", [root]);
    const down = resolveBrowseAction("s3", { kind: "open", index: 0 }, [root]);
    expect(down.cwd).toBe(path.join(root, "child"));
    expect(down.canGoUp).toBe(true);
    const up = resolveBrowseAction("s3", { kind: "up" }, [root]);
    expect(up.cwd).toBe(path.resolve(root));
    clearBrowse("s3");
  });

  it("up at a root boundary returns to the roots screen when several roots exist", () => {
    const root2 = fs.mkdtempSync(path.join(os.tmpdir(), "tcb-browse3-"));
    resolveBrowseAction("s4", { kind: "root", index: 0 }, [root, root2]); // enter first root
    const up = resolveBrowseAction("s4", { kind: "up" }, [root, root2]);
    expect(up.kind).toBe("roots");
    clearBrowse("s4");
    fs.rmSync(root2, { recursive: true, force: true });
  });

  it("paginates large directories and exposes absolute indices", () => {
    for (let i = 0; i < 10; i++) fs.mkdirSync(path.join(root, `d${String(i).padStart(2, "0")}`));
    startBrowse("s5", [root]);
    const p0 = resolveBrowseAction("s5", { kind: "page", page: 0 }, [root]);
    expect(p0.totalPages).toBe(2);
    expect(p0.entries).toHaveLength(8);
    expect(p0.entries[0]?.index).toBe(0);
    const p1 = resolveBrowseAction("s5", { kind: "page", page: 1 }, [root]);
    expect(p1.entries).toHaveLength(2);
    expect(p1.entries[0]?.index).toBe(8);
    // Opening by absolute index resolves to the right dir on page 2.
    const down = resolveBrowseAction("s5", { kind: "open", index: 8 }, [root]);
    expect(path.basename(down.cwd ?? "")).toBe("d08");
    clearBrowse("s5");
  });

  it("browseCwd reflects the current dir and clearBrowse forgets it", () => {
    startBrowse("s6", [root]);
    expect(browseCwd("s6")).toBe(path.resolve(root));
    clearBrowse("s6");
    expect(browseCwd("s6")).toBeNull();
  });
});

describe("new folder", () => {
  it("requestNewFolder arms the capture for the current dir", () => {
    startBrowse("nf1", [root]);
    expect(requestNewFolder("nf1")).toBe(path.resolve(root));
    expect(isAwaitingFolderName("nf1")).toBe(true);
    clearBrowse("nf1");
  });

  it("createSubfolder makes the dir, enters it, and clears the capture", () => {
    startBrowse("nf2", [root]);
    requestNewFolder("nf2");
    const res = createSubfolder("nf2", "newproj", [root]);
    expect(res.ok).toBe(true);
    expect(fs.existsSync(path.join(root, "newproj"))).toBe(true);
    if (res.ok) expect(res.view.cwd).toBe(path.join(root, "newproj")); // entered the new dir
    expect(isAwaitingFolderName("nf2")).toBe(false); // capture consumed
    clearBrowse("nf2");
  });

  it("rejects invalid names, traversal, and existing dirs", () => {
    fs.mkdirSync(path.join(root, "taken"));
    startBrowse("nf3", [root]);
    const bad = (name: string) => {
      requestNewFolder("nf3");
      return createSubfolder("nf3", name, [root]);
    };
    expect(bad("")).toMatchObject({ ok: false, reason: "invalid" });
    expect(bad("a/b")).toMatchObject({ ok: false, reason: "invalid" });
    expect(bad("..")).toMatchObject({ ok: false, reason: "invalid" });
    expect(bad("taken")).toMatchObject({ ok: false, reason: "exists" });
    clearBrowse("nf3");
  });

  it("createSubfolder without a pending capture is expired", () => {
    expect(createSubfolder("nf4", "x", [root])).toMatchObject({ ok: false, reason: "expired" });
  });

  it("navigating away abandons a pending new-folder prompt", () => {
    fs.mkdirSync(path.join(root, "sub"));
    startBrowse("nf5", [root]);
    requestNewFolder("nf5");
    resolveBrowseAction("nf5", { kind: "open", index: 0 }, [root]); // navigate into sub
    expect(isAwaitingFolderName("nf5")).toBe(false);
    clearBrowse("nf5");
  });
});
