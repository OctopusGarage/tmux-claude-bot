import { describe, expect, it } from "vitest";
import { matchRef } from "../../src/cli/control.js";

type Item = { key: string; label: string };
const items: Item[] = [
  { key: "k1", label: "geo-backend" },
  { key: "k2", label: "mesh-talk" },
  { key: "k3", label: "geo-frontend" },
];
const resolve = (ref: string): Item =>
  matchRef(
    items,
    ref,
    (i) => i.key,
    (i) => i.label,
    "project",
    "tcb projects",
  );

describe("matchRef", () => {
  it("matches an exact key or exact label (case-insensitive)", () => {
    expect(resolve("k2").label).toBe("mesh-talk");
    expect(resolve("MESH-TALK").label).toBe("mesh-talk");
  });

  it("matches a UNIQUE label substring", () => {
    expect(resolve("mesh").label).toBe("mesh-talk");
    expect(resolve("frontend").label).toBe("geo-frontend");
  });

  it("throws on an ambiguous substring, listing the matches", () => {
    expect(() => resolve("geo")).toThrow(/ambiguous "geo".*geo-backend.*geo-frontend/);
  });

  it("throws a helpful message on no match", () => {
    expect(() => resolve("nope")).toThrow(/no project matches "nope".*tcb projects/);
  });

  it("prefers an exact match over a substring", () => {
    const both: Item[] = [
      { key: "a", label: "api" },
      { key: "b", label: "api-gateway" },
    ];
    expect(
      matchRef(
        both,
        "api",
        (i) => i.key,
        (i) => i.label,
        "project",
        "x",
      ).key,
    ).toBe("a");
  });
});
