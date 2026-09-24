/**
 * Structured logs (one JSON line each). Never log code, diffs, prompts, comment bodies or secrets:
 * PLAN-DETAILED section 8 retention rules. Fields on the deny list are dropped, strings are truncated.
 */
const DENIED = new Set(["content", "diff", "patch", "prompt", "body", "suggestion", "token", "key", "secret", "privateKey", "authorization", "signature"]);
const MAX_STRING = 200;

export type LogFields = Record<string, unknown>;

export function sanitizeLogFields(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (DENIED.has(k)) continue;
    if (typeof v === "string") out[k] = v.length > MAX_STRING ? `${v.slice(0, MAX_STRING)}...` : v;
    else if (typeof v === "number" || typeof v === "boolean" || v === null || v === undefined) out[k] = v;
    else if (Array.isArray(v)) out[k] = v.filter((x) => typeof x === "string" || typeof x === "number").slice(0, 20);
    // objects (e.g. raw errors, payloads) are not logged
  }
  return out;
}

export function log(event: string, fields: LogFields = {}): void {
  console.log(JSON.stringify({ app: "guardrails", event, ...sanitizeLogFields(fields) }));
}
