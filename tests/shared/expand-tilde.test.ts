import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import { expandTilde } from "../../src/shared/utils/path.js";

describe("expandTilde", () => {
  it("expands a bare leading tilde to the home directory", () => {
    expect(expandTilde("~")).toBe(homedir());
  });

  it("expands a leading ~/ prefix", () => {
    expect(expandTilde("~/projects/app")).toBe(`${homedir()}/projects/app`);
  });

  it("does NOT expand a tilde that is not at the start (regression for replaceAll)", () => {
    // The old `replaceAll("~", homedir())` mangled these: a legitimate directory
    // like /srv/~backup became /srv//Users/me/backup.
    expect(expandTilde("/srv/~backup")).toBe("/srv/~backup");
    expect(expandTilde("proj~1")).toBe("proj~1");
  });

  it("does NOT expand ~user (other-user home is unsupported)", () => {
    expect(expandTilde("~backup")).toBe("~backup");
  });

  it("leaves an ordinary absolute path unchanged", () => {
    expect(expandTilde("/home/user/work")).toBe("/home/user/work");
  });
});
