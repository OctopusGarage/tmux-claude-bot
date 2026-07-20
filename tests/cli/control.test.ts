import { resolve as resolvePath } from "node:path";
import { describe, expect, it } from "vitest";
import { buildNotifyRequest, confirmCliDangerousControl, matchRef } from "../../src/cli/control.js";

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

describe("confirmCliDangerousControl", () => {
  it("does not prompt for safe actions", async () => {
    await expect(
      confirmCliDangerousControl("enter", "proj", {
        yes: false,
        isTty: false,
        ask: async () => "n",
      }),
    ).resolves.toBe(true);
  });

  it("requires --yes for dangerous actions in non-interactive use", async () => {
    await expect(
      confirmCliDangerousControl("exit", "proj", {
        yes: false,
        isTty: false,
        ask: async () => "y",
      }),
    ).rejects.toThrow(/--yes/);
  });

  it("accepts explicit --yes for dangerous actions", async () => {
    await expect(
      confirmCliDangerousControl("exit", "proj", { yes: true, isTty: false, ask: async () => "n" }),
    ).resolves.toBe(true);
  });

  it("prompts in a TTY and only accepts yes", async () => {
    await expect(
      confirmCliDangerousControl("clear", "proj", {
        yes: false,
        isTty: true,
        ask: async () => "yes",
      }),
    ).resolves.toBe(true);
    await expect(
      confirmCliDangerousControl("clear", "proj", {
        yes: false,
        isTty: true,
        ask: async () => "no",
      }),
    ).resolves.toBe(false);
  });
});

describe("buildNotifyRequest", () => {
  it("uses --title and --body when provided", async () => {
    await expect(
      buildNotifyRequest([], {
        title: "Deploy failed",
        body: "health check failed",
        channel: "telegram",
        level: "error",
        source: "deploy",
      }),
    ).resolves.toEqual({
      title: "Deploy failed",
      body: "health check failed",
      channel: "telegram",
      level: "error",
      source: "deploy",
    });
  });

  it("uses positional text as the title when --title is omitted", async () => {
    await expect(buildNotifyRequest(["Build", "done"], {})).resolves.toEqual({
      title: "Build done",
    });
  });

  it("reads stdin into body when --stdin is set", async () => {
    await expect(
      buildNotifyRequest([], { title: "Report", stdin: true }, async () => "line 1\nline 2\n"),
    ).resolves.toEqual({
      title: "Report",
      body: "line 1\nline 2",
    });
  });

  it("adds repeated --attach files as notification attachments", async () => {
    await expect(
      buildNotifyRequest([], {
        title: "Radar report",
        attach: ["report.md", "report.html"],
      }),
    ).resolves.toEqual({
      title: "Radar report",
      attachments: [
        { path: resolvePath(process.cwd(), "report.md") },
        { path: resolvePath(process.cwd(), "report.html") },
      ],
    });
  });

  it("rejects an empty title and invalid enum values", async () => {
    await expect(buildNotifyRequest([], {})).rejects.toThrow(/--title/);
    await expect(buildNotifyRequest(["x"], { channel: "email" })).rejects.toThrow(/channel/);
    await expect(buildNotifyRequest(["x"], { level: "fatal" })).rejects.toThrow(/level/);
  });
});
