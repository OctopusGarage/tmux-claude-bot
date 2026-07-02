import { basename, extname } from "node:path";

export type AttachmentKind = "image" | "file";

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

export function classifyKind(filePath: string): AttachmentKind {
  return IMAGE_EXTS.has(extname(filePath).toLowerCase()) ? "image" : "file";
}

export function validateAttachment(
  filePath: string,
  statInfo: (p: string) => { size: number; isFile: boolean } | null,
): { ok: true; kind: AttachmentKind } | { ok: false; error: string } {
  const info = statInfo(filePath);
  if (info === null) return { ok: false, error: `file not found: ${basename(filePath)}` };
  if (!info.isFile) return { ok: false, error: `${basename(filePath)} is not a regular file` };
  if (info.size > MAX_ATTACHMENT_BYTES) {
    return {
      ok: false,
      error: `file too large (${info.size} bytes; max ${MAX_ATTACHMENT_BYTES})`,
    };
  }
  return { ok: true, kind: classifyKind(filePath) };
}
