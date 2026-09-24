import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { extractJsonMiddleware, gateway, wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from "ai";
import type { CostTracker } from "./cost";
import { LlmCache, llmCacheEnabledByEnv, llmCacheKey, type CachedGeneration, type Env } from "./llm-cache";

export const DEFAULT_MODEL_SPEC = "anthropic/claude-sonnet-5";

/** Spec used when the caller gave none: `GUARDRAILS_MODEL` or the default Gateway model. */
export function defaultModelSpec(env: Env = process.env): string {
  return env.GUARDRAILS_MODEL?.trim() || DEFAULT_MODEL_SPEC;
}

interface ProviderDef {
  name: string;
  baseURL: string;
  keyVar: string;
}

/** `<prefix>:<model id>` providers. Anything else goes to the Vercel AI Gateway. */
const PROVIDERS: Record<string, ProviderDef> = {
  zai: { name: "zai", baseURL: "https://api.z.ai/api/paas/v4", keyVar: "ZAI_API_KEY" },
  // Docs list the OpenAI-format base URL without a /v1 suffix (verified 2026-09-24).
  deepseek: { name: "deepseek", baseURL: "https://api.deepseek.com", keyVar: "DEEPSEEK_API_KEY" },
};

/**
 * GLM-5.3 family: reasoning cannot be disabled ("always operates with reasoning enabled", docs.z.ai
 * guides/llm/glm-5.3, verified 2026-09-24); `thinking: disabled` would even fail. Its depth is set with
 * `reasoning_effort` (low | high | max, default max).
 */
export function zaiThinkingIsForced(modelId: string): boolean {
  return /^glm-5\.3/i.test(modelId);
}

/**
 * Adjusts the request body for Z.ai (never for other providers):
 *  - drops `response_format: {type: "json_object"}`. Measured 2026-09-24: in that mode Z.ai deletes the token
 *    "json" from the output ("seeds.config.json" -> "seeds.config."), which corrupted generated file names.
 *    JSON output is requested in the prompt instead (see `jsonOnlyInstruction`) and validated by the schema.
 *  - cuts reasoning cost unless `GUARDRAILS_THINKING=1`: `thinking: {type: "disabled"}` for models that allow it,
 *    `reasoning_effort: "low"` for the GLM-5.3 family (which cannot disable it).
 */
export function zaiRequestBody(body: Record<string, any>, modelId: string, env: Env): Record<string, any> {
  const out = { ...body };
  if (out.response_format?.type === "json_object") delete out.response_format;
  if (env.GUARDRAILS_THINKING?.trim() === "1") return out;
  if (zaiThinkingIsForced(modelId)) out.reasoning_effort ??= "low";
  else out.thinking ??= { type: "disabled" };
  return out;
}

export class MissingApiKeyError extends Error {
  constructor(
    readonly spec: string,
    readonly keyVar: string,
  ) {
    super(`Model "${spec}" needs ${keyVar}, which is not set. Add it to guardrails/.env.local (or the environment).`);
    this.name = "MissingApiKeyError";
  }
}

export interface ResolveModelOptions {
  /** Counts spend per call and enforces its cap. */
  tracker?: CostTracker;
  /** `true`/instance = replay identical calls from disk. Default: `GUARDRAILS_LLM_CACHE=1`. */
  cache?: boolean | LlmCache;
  env?: Env;
  /** Custom fetch for the zai/deepseek providers (tests). */
  fetch?: typeof fetch;
}

const specs = new WeakMap<object, string>();
const instrumented = new WeakSet<object>();

/** Spec string a model was resolved from (for pricing); best-effort for foreign instances. */
export function modelSpecOf(model: LanguageModel): string {
  if (typeof model === "string") return model;
  return specs.get(model) ?? `${model.provider}:${model.modelId}`;
}

type WrapGenerate = NonNullable<LanguageModelMiddleware["wrapGenerate"]>;

function callMiddleware(spec: string, tracker: CostTracker | undefined, cache: LlmCache | undefined): LanguageModelMiddleware {
  const wrapGenerate: WrapGenerate = async ({ doGenerate, params }) => {
    const key = cache ? llmCacheKey(spec, params) : undefined;
    if (cache && key) {
      const hit = await cache.get(key);
      if (hit) {
        tracker?.recordCached();
        return hit as unknown as Awaited<ReturnType<typeof doGenerate>>;
      }
    }
    tracker?.assertWithinBudget();
    const result = await doGenerate();
    if (cache && key) {
      const entry: CachedGeneration = {
        content: result.content,
        finishReason: result.finishReason,
        usage: result.usage,
        warnings: result.warnings,
        providerMetadata: result.providerMetadata,
      };
      await cache.set(key, entry);
    }
    if (tracker) {
      const u = result.usage;
      tracker.record(spec, {
        inputTokens: u.inputTokens.total ?? 0,
        cachedInputTokens: u.inputTokens.cacheRead ?? 0,
        cacheWriteTokens: u.inputTokens.cacheWrite ?? 0,
        outputTokens: u.outputTokens.total ?? 0,
      });
    }
    return result;
  };
  return { specificationVersion: "v4", wrapGenerate };
}

/**
 * Turns a model spec into an AI SDK model.
 *  - `zai:<id>`      -> Z.ai (OpenAI-compatible), needs ZAI_API_KEY
 *  - `deepseek:<id>` -> DeepSeek (OpenAI-compatible), needs DEEPSEEK_API_KEY
 *  - anything else   -> passed as-is to the AI Gateway (e.g. `anthropic/claude-sonnet-5`)
 * A `LanguageModel` instance is accepted too (tests). When a tracker or the LLM cache
 * is active the model is wrapped once; already-wrapped models are returned untouched.
 */
export function resolveModel(spec: LanguageModel, options: ResolveModelOptions = {}): LanguageModel {
  const env = options.env ?? process.env;
  let model: LanguageModel = spec;
  let specString = modelSpecOf(spec);

  if (typeof spec === "string") {
    const sep = spec.indexOf(":");
    const provider = sep > 0 ? PROVIDERS[spec.slice(0, sep)] : undefined;
    if (provider) {
      const id = spec.slice(sep + 1);
      if (!id) throw new Error(`Invalid model "${spec}": expected "${spec.slice(0, sep)}:<model id>".`);
      const apiKey = env[provider.keyVar]?.trim();
      if (!apiKey) throw new MissingApiKeyError(spec, provider.keyVar);
      const isZai = provider.name === "zai";
      model = createOpenAICompatible({
        name: provider.name,
        baseURL: provider.baseURL,
        apiKey,
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(isZai ? { transformRequestBody: (b: Record<string, any>) => zaiRequestBody(b, id, env) } : {}),
      })(id);
      // Without json mode the model may wrap JSON in markdown fences; strip them before schema parsing.
      if (isZai) model = wrapLanguageModel({ model, middleware: extractJsonMiddleware() });
      specs.set(model, spec);
    }
    // Plain strings (no known provider prefix) stay strings: the AI SDK routes them to the Gateway.
    specString = spec;
  }

  const cache =
    options.cache instanceof LlmCache ? options.cache : (options.cache ?? llmCacheEnabledByEnv(env)) ? new LlmCache() : undefined;
  if (!options.tracker && !cache) return model;

  if (typeof model !== "string") {
    if (instrumented.has(model)) return model;
    const wrapped = wrapLanguageModel({ model, middleware: callMiddleware(specString, options.tracker, cache) });
    specs.set(wrapped, specString);
    instrumented.add(wrapped);
    return wrapped;
  }
  // Gateway string: resolve to a real model object through the default provider so it can be wrapped.
  const wrapped = wrapLanguageModel({
    model: gateway(model),
    middleware: callMiddleware(specString, options.tracker, cache),
  });
  specs.set(wrapped, specString);
  instrumented.add(wrapped);
  return wrapped;
}

/**
 * Prompt text asking for a bare JSON object; used where the provider's own JSON mode is not trusted (zai).
 * Takes an EXAMPLE value, not a JSON schema: weaker models echo a schema back instead of filling it.
 */
export function jsonOnlyInstruction(example: unknown): string {
  return `Respond with ONLY one JSON object (no markdown fences, no other text), with this shape:
${JSON.stringify(example)}`;
}
