import { describe, expect, it } from "vitest";
import {
  classifyKind,
  MAX_ATTACHMENT_BYTES,
  validateAttachment,
} from "../../../src/core/attachments/classify.js";

describe("classifyKind", () => {
  it("treats common image extensions as image (case-insensitive)", () => {
    for (const p of ["a.png", "b.JPG", "c.jpeg", "d.gif", "e.webp", "f.bmp"]) {
      expect(classifyKind(p)).toBe("image");
    }
  });
  it("treats everything else as file", () => {
    for (const p of ["report.pdf", "log.txt", "archive.zip", "noext", "a.mp4"]) {
      expect(classifyKind(p)).toBe("file");
    }
  });
});

describe("validateAttachment", () => {
  it("fails when the file is missing", () => {
    const r = validateAttachment("/nope.png", () => null);
    expect(r).toEqual({ ok: false, error: expect.stringContaining("not found") });
  });
  it("fails when over the size limit", () => {
    const r = validateAttachment("/big.zip", () => MAX_ATTACHMENT_BYTES + 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("too large");
  });
  it("passes a valid image and reports its kind", () => {
    expect(validateAttachment("/ok.png", () => 1234)).toEqual({ ok: true, kind: "image" });
  });
  it("passes a valid document", () => {
    expect(validateAttachment("/ok.pdf", () => 1234)).toEqual({ ok: true, kind: "file" });
  });
});
