import { afterEach, describe, expect, it, vi } from "vitest";
import { MissingApiKeyError, defaultModelSpec, resolveModel } from "./models";

afterEach(() => vi.unstubAllGlobals());

/** Runs one doGenerate call against a stubbed fetch and returns the request that would have been sent. */
async function captureRequest(model: unknown) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    return new Response("{}", { status: 500 });
  });
  const m = model as { doGenerate: (o: unknown) => Promise<unknown> };
  await m.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }).catch(() => undefined);
  return calls[0]!;
}

describe("resolveModel", () => {
  it("zai:<id> -> Z.ai OpenAI-compatible endpoint with ZAI_API_KEY", async () => {
    const model = resolveModel("zai:glm-4.5-air", { env: { ZAI_API_KEY: "test-zai-key" } });
    expect(typeof model).toBe("object");
    expect((model as { modelId: string }).modelId).toBe("glm-4.5-air");
    const req = await captureRequest(model);
    expect(req.url).toBe("https://api.z.ai/api/paas/v4/chat/completions");
    expect(req.headers.authorization).toBe("Bearer test-zai-key");
  });

  it("deepseek:<id> -> DeepSeek endpoint with DEEPSEEK_API_KEY", async () => {
    const model = resolveModel("deepseek:deepseek-flash", { env: { DEEPSEEK_API_KEY: "test-ds-key" } });
    expect((model as { modelId: string }).modelId).toBe("deepseek-flash");
    const req = await captureRequest(model);
    expect(req.url).toBe("https://api.deepseek.com/chat/completions");
    expect(req.headers.authorization).toBe("Bearer test-ds-key");
  });

  it("any other string goes to the AI Gateway untouched", () => {
    expect(resolveModel("anthropic/claude-sonnet-5", { env: {} })).toBe("anthropic/claude-sonnet-5");
    expect(resolveModel("openai/gpt-5", { env: {} })).toBe("openai/gpt-5");
  });

  it("fails with an actionable error naming the variable, not its value", () => {
    expect(() => resolveModel("zai:glm-4.5-air", { env: {} })).toThrow(MissingApiKeyError);
    expect(() => resolveModel("zai:glm-4.5-air", { env: {} })).toThrow(/ZAI_API_KEY/);
    expect(() => resolveModel("deepseek:deepseek-flash", { env: { DEEPSEEK_API_KEY: "  " } })).toThrow(/DEEPSEEK_API_KEY/);
  });

  it("rejects an empty model id", () => {
    expect(() => resolveModel("zai:", { env: { ZAI_API_KEY: "k" } })).toThrow(/model id/);
  });

  it("defaultModelSpec reads GUARDRAILS_MODEL and falls back to the Gateway default", () => {
    expect(defaultModelSpec({ GUARDRAILS_MODEL: "zai:glm-4.5-air" })).toBe("zai:glm-4.5-air");
    expect(defaultModelSpec({})).toBe("anthropic/claude-sonnet-5");
  });
});

describe("zai request body (json mode + thinking)", () => {
  /** Sends one call with json response format and returns the JSON body that reached the wire. */
  async function bodyFor(spec: string, env: Record<string, string> = {}) {
    let body: Record<string, unknown> = {};
    const fetchStub = (async (_u: string | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response("{}", { status: 500 });
    }) as typeof fetch;
    const model = resolveModel(spec, { env: { ZAI_API_KEY: "k", DEEPSEEK_API_KEY: "k", ...env }, fetch: fetchStub }) as unknown as {
      doGenerate: (o: unknown) => Promise<unknown>;
    };
    await model
      .doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }], responseFormat: { type: "json" } })
      .catch(() => undefined);
    return body;
  }

  it("never sends response_format json_object to zai (it strips the word json from the output)", async () => {
    expect(await bodyFor("zai:glm-4.6")).not.toHaveProperty("response_format");
    expect(await bodyFor("zai:glm-5.3-flash")).not.toHaveProperty("response_format");
  });

  it("sends thinking disabled only to zai models that allow it", async () => {
    expect((await bodyFor("zai:glm-4.6")).thinking).toEqual({ type: "disabled" });
    expect((await bodyFor("zai:glm-4.5-air")).thinking).toEqual({ type: "disabled" });
    expect(await bodyFor("zai:glm-5.3")).not.toHaveProperty("thinking"); // forced thinking
    expect(await bodyFor("zai:glm-5.3-flash")).not.toHaveProperty("thinking");
  });

  it("GUARDRAILS_THINKING=1 keeps thinking on", async () => {
    expect(await bodyFor("zai:glm-4.6", { GUARDRAILS_THINKING: "1" })).not.toHaveProperty("thinking");
  });

  it("never sends thinking to other providers", async () => {
    expect(await bodyFor("deepseek:deepseek-flash")).not.toHaveProperty("thinking");
  });
});
