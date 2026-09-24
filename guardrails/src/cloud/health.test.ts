import { describe, expect, it } from "vitest";
import { GET } from "../../app/api/health/route";

describe("GET /api/health", () => {
  it("returns 200 without exposing configuration", async () => {
    process.env.GITHUB_APP_PRIVATE_KEY = "PRIVATE-KEY-VALUE";
    process.env.ZAI_API_KEY = "ZAI-KEY-VALUE";
    const res = GET();
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ status: "ok" });
    expect(text).not.toContain("KEY-VALUE");
  });
});
