import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { appStateFile } from "../../shared/state-dir.js";
import type { ScheduledMessageRecord } from "./types.js";

const nonempty = z.string().min(1);
const schema = z
  .object({
    version: z.literal(1),
    records: z.array(
      z
        .object({
          id: nonempty,
          owner: z
            .object({
              channel: z.enum(["telegram", "lark", "control"]),
              chatId: nonempty,
              userId: nonempty,
            })
            .strict(),
          target: z
            .object({
              sessionName: nonempty,
              label: nonempty,
              workspacePath: z.string().nullable(),
              incarnation: nonempty,
            })
            .strict(),
          text: nonempty,
          dueAt: z.number().int().nonnegative(),
          timezone: nonempty,
          createdAt: z.number().int().nonnegative(),
          updatedAt: z.number().int().nonnegative(),
          status: z.enum([
            "scheduled",
            "queued",
            "sending",
            "sent",
            "blocked",
            "failed",
            "cancelled",
            "uncertain",
          ]),
          requestId: nonempty,
          sentAt: z.number().int().nonnegative().optional(),
          error: z.string().optional(),
          result: z.string().optional(),
          retryAt: z.number().optional(),
          attempts: z.number().int().nonnegative().optional(),
          prepared: z
            .object({
              text: nonempty,
              origin: z.literal("user"),
              promptSource: z.enum(["telegram", "lark", "control"]),
              sourceText: z.string().optional(),
              transform: z
                .object({
                  kind: z.literal("translation"),
                  provider: nonempty,
                  from: nonempty,
                  to: nonempty,
                  sourceText: z.string(),
                  deliveredText: z.string(),
                })
                .strict()
                .optional(),
            })
            .strict()
            .optional(),
        })
        .strict(),
    ),
  })
  .strict();
export class ScheduledMessageStore {
  private existed = false;
  constructor(readonly path = appStateFile("scheduled-messages.json")) {}
  read(): ScheduledMessageRecord[] {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && !this.existed) return [];
      throw error;
    }
    this.existed = true;
    const records = schema.parse(JSON.parse(raw)).records;
    if (new Set(records.map((r) => r.id)).size !== records.length)
      throw new Error("Duplicate schedule IDs");
    return records;
  }
  transaction<T>(fn: (records: ScheduledMessageRecord[]) => T): T {
    const records = this.read();
    const result = fn(records);
    const data = JSON.stringify(schema.parse({ version: 1, records }));
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeFileSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, this.path);
    this.existed = true;
    const dir = openSync(dirname(this.path), "r");
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
    return structuredClone(result);
  }
}
