import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import { expandTilde, tildeifyHome, tildeifyHomeDeep } from "../../src/shared/utils/path.js";

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

describe("tildeifyHome", () => {
  const h = homedir();

  it("collapses the home prefix to ~ inside arbitrary text", () => {
    expect(tildeifyHome(`created: ${h}/programming/x`)).toBe("created: ~/programming/x");
  });

  it("collapses every occurrence, including in quotes and a bare home", () => {
    expect(tildeifyHome(`${h} and ${h}/a "${h}/b"`)).toBe(`~ and ~/a "~/b"`);
  });

  it("does NOT shorten a different user's home with the same prefix", () => {
    expect(tildeifyHome(`${h}2/x`)).toBe(`${h}2/x`);
  });

  it("leaves text without the home path untouched", () => {
    expect(tildeifyHome("/etc/hosts and /tmp/x")).toBe("/etc/hosts and /tmp/x");
  });

  it("deep-shortens every string in an object/array (Lark cards), keeping non-strings", () => {
    expect(tildeifyHomeDeep({ a: `${h}/p`, b: [{ c: `${h}/q` }], n: 5, ok: true })).toEqual({
      a: "~/p",
      b: [{ c: "~/q" }],
      n: 5,
      ok: true,
    });
  });
});
