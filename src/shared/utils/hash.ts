import { createHash } from "node:crypto";

const BASE62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

export function sessionShortId(sessionName: string): string {
  const hash = createHash("sha256").update(sessionName).digest();

  let num = 0;
  for (let i = 0; i < 4; i++) {
    const byte = hash[i];
    if (byte === undefined) {
      throw new Error("SHA-256 digest is unexpectedly short");
    }
    num = num * 256 + byte;
  }

  let result = "";
  while (num > 0) {
    const digit = BASE62[num % 62];
    if (digit === undefined) {
      throw new Error("base62 digit index is out of range");
    }
    result = digit + result;
    num = Math.floor(num / 62);
  }

  return result.padStart(6, "0").slice(0, 6);
}
