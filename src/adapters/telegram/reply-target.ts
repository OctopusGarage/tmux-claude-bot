import * as fs from "node:fs";
import * as nodePath from "node:path";
import { logger } from "../../shared/utils/logger.js";

export interface ReplyTargetMap {
  record(telegramMessageId: number, sessionName: string): void;
  resolveReplyTarget(telegramMessageId: number): string | null;
  removeSession(sessionName: string): void;
  clear(): void;
}

interface MapEntry {
  [telegramMessageId: number]: string;
}

const DATA_DIR = ".queue";
const FILE_NAME = "reply_target_map.json";
const MAX_ENTRIES = 100;
const EVICT_COUNT = 20;

function getFilePath(customDir?: string): string {
  const dir = customDir ?? DATA_DIR;
  return nodePath.join(dir, FILE_NAME);
}

function load(customDir?: string): MapEntry {
  const filePath = getFilePath(customDir);
  if (!fs.existsSync(filePath)) {
    return {};
  }
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as MapEntry;
  } catch (err) {
    logger.error(
      `[reply-target] failed to load/parse ${filePath}, resetting: ${err instanceof Error ? err.message : err}`,
    );
    return {};
  }
}

function save(map: MapEntry, customDir?: string): void {
  const filePath = getFilePath(customDir);
  try {
    const dir = nodePath.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(map, null, 2), "utf-8");
  } catch (err) {
    logger.error(
      `[reply-target] failed to write ${filePath}: ${err instanceof Error ? err.message : err}`,
    );
  }
}

export function createReplyTargetMap(customDir?: string): ReplyTargetMap {
  const evict = (map: MapEntry): MapEntry => {
    if (Object.keys(map).length >= MAX_ENTRIES) {
      const sorted = Object.keys(map)
        .map(Number)
        .sort((a, b) => a - b);
      const toRemove = sorted.slice(0, EVICT_COUNT);
      for (const id of toRemove) {
        delete map[id];
      }
      logger.info(
        `[reply-target] evicted ${EVICT_COUNT} oldest entries, remaining=${Object.keys(map).length}`,
      );
    }
    return map;
  };

  return {
    record(telegramMessageId, sessionName) {
      const map = load(customDir);
      map[telegramMessageId] = sessionName;
      evict(map);
      save(map, customDir);
      logger.info(
        `[reply-target] recorded msgId=${telegramMessageId} → session=${sessionName} total=${Object.keys(map).length}`,
      );
    },

    resolveReplyTarget(telegramMessageId) {
      const map = load(customDir);
      const session = map[telegramMessageId] ?? null;
      if (session) {
        logger.info(`[reply-target] resolved msgId=${telegramMessageId} → session=${session}`);
      }
      return session;
    },

    removeSession(sessionName) {
      const map = load(customDir);
      let removed = 0;
      for (const [msgId, session] of Object.entries(map)) {
        if (session === sessionName) {
          delete map[parseInt(msgId, 10)];
          removed++;
        }
      }
      save(map, customDir);
      logger.info(`[reply-target] removed session=${sessionName} entries=${removed}`);
    },

    clear() {
      save({}, customDir);
      logger.info(`[reply-target] cleared all entries`);
    },
  };
}
