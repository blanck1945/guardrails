import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

export const DEFAULT_MODEL_SPEC = "anthropic/claude-sonnet-5";

/** Spec used when the caller gave none: `GUARDRAILS_MODEL` or the default Gateway model. */
export function defaultModelSpec(env: NodeJS.ProcessEnv = process.env): string {
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
  env?: NodeJS.ProcessEnv;
}

const specs = new WeakMap<object, string>();

/** Spec string a model was resolved from (for pricing); best-effort for foreign instances. */
export function modelSpecOf(model: LanguageModel): string {
  if (typeof model === "string") return model;
  return specs.get(model) ?? `${model.provider}:${model.modelId}`;
}

/**
 * Turns a model spec into an AI SDK model.
 *  - `zai:<id>`      -> Z.ai (OpenAI-compatible), needs ZAI_API_KEY
 *  - `deepseek:<id>` -> DeepSeek (OpenAI-compatible), needs DEEPSEEK_API_KEY
 *  - anything else   -> passed as-is to the AI Gateway (e.g. `anthropic/claude-sonnet-5`)
 * A `LanguageModel` instance is accepted too (tests) and returned untouched.
 */
export function resolveModel(spec: LanguageModel, options: ResolveModelOptions = {}): LanguageModel {
  const env = options.env ?? process.env;
  let model: LanguageModel = spec;

  if (typeof spec === "string") {
    const sep = spec.indexOf(":");
    const provider = sep > 0 ? PROVIDERS[spec.slice(0, sep)] : undefined;
    if (provider) {
      const id = spec.slice(sep + 1);
      if (!id) throw new Error(`Invalid model "${spec}": expected "${spec.slice(0, sep)}:<model id>".`);
      const apiKey = env[provider.keyVar]?.trim();
      if (!apiKey) throw new MissingApiKeyError(spec, provider.keyVar);
      model = createOpenAICompatible({ name: provider.name, baseURL: provider.baseURL, apiKey })(id);
      specs.set(model, spec);
    }
    // Plain strings (no known provider prefix) stay strings: the AI SDK routes them to the Gateway.
  }

  return model;
}
