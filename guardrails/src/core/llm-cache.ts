import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

/** Serialized subset of a `doGenerate` result: enough to replay the call. */
export interface CachedGeneration {
  content: unknown[];
  finishReason: unknown;
  usage: unknown;
  warnings: unknown[];
  providerMetadata?: unknown;
}

export const DEFAULT_LLM_CACHE_DIR = path.join("eval", ".cache", "llm");

/** Cache is dev/eval only: off unless `GUARDRAILS_LLM_CACHE=1` or an explicit option. */
export function llmCacheEnabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GUARDRAILS_LLM_CACHE === "1";
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, stable(v)]),
    );
  }
  return value;
}

/** hash(model + every call option that can change the answer: prompt, tools, tool choice, params). */
export function llmCacheKey(modelSpec: string, params: object): string {
  const { abortSignal: _a, headers: _h, ...rest } = params as Record<string, unknown>;
  return createHash("sha256")
    .update(JSON.stringify(stable({ model: modelSpec, params: rest })))
    .digest("hex");
}

export class LlmCache {
  readonly dir: string;
  constructor(dir?: string) {
    this.dir = path.resolve(dir ?? process.env.GUARDRAILS_LLM_CACHE_DIR ?? DEFAULT_LLM_CACHE_DIR);
  }

  private file(key: string): string {
    return path.join(this.dir, `${key}.json`);
  }

  async get(key: string): Promise<CachedGeneration | null> {
    try {
      return JSON.parse(await fs.readFile(this.file(key), "utf8")) as CachedGeneration;
    } catch {
      return null; // missing or corrupt entry: treat as a miss
    }
  }

  async set(key: string, entry: CachedGeneration): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.file(key), JSON.stringify(entry), "utf8");
  }
}
