import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export const CACHE_DIR = path.join(__dirname, "..", ".cache");

type Entry<T> = { fetchedAt: number; data: T };

/**
 * JSON file cache under eval/.cache (git-ignored). `ttlMs = null` means the value is
 * immutable (e.g. commit -> PR lookups, merged PR details) and never expires.
 */
export function createCache(dir = path.join(CACHE_DIR, "github")) {
  const stats = { hits: 0, misses: 0 };
  return {
    stats,
    async get<T>(key: string, ttlMs: number | null, fetcher: () => Promise<T>): Promise<T> {
      const file = path.join(dir, createHash("sha1").update(key).digest("hex") + ".json");
      try {
        const entry = JSON.parse(await fs.readFile(file, "utf8")) as Entry<T>;
        if (ttlMs === null || Date.now() - entry.fetchedAt < ttlMs) {
          stats.hits++;
          return entry.data;
        }
      } catch {
        // miss
      }
      stats.misses++;
      const data = await fetcher();
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(file, JSON.stringify({ fetchedAt: Date.now(), data } satisfies Entry<T>));
      return data;
    },
  };
}
