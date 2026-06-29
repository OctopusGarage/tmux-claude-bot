import { basename, extname } from "node:path";

export type AttachmentKind = "image" | "file";

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

export function classifyKind(filePath: string): AttachmentKind {
  return IMAGE_EXTS.has(extname(filePath).toLowerCase()) ? "image" : "file";
}

export function validateAttachment(
  filePath: string,
  statSize: (p: string) => number | null,
): { ok: true; kind: AttachmentKind } | { ok: false; error: string } {
  const size = statSize(filePath);
  if (size === null) return { ok: false, error: `file not found: ${basename(filePath)}` };
  if (size > MAX_ATTACHMENT_BYTES) {
    return { ok: false, error: `file too large (${size} bytes; max ${MAX_ATTACHMENT_BYTES})` };
  }
  return { ok: true, kind: classifyKind(filePath) };
}
