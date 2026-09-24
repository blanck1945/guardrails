import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REQUIRED_PERMISSIONS, SUBSCRIBED_EVENTS } from "./app-permissions";

const root = path.resolve(__dirname, "../..");
const manifest = JSON.parse(readFileSync(path.join(root, "github-app/manifest.json"), "utf8"));

/** Permission that each octokit REST namespace needs for the calls this app makes (read or write level). */
const NAMESPACE_PERMISSION: Record<string, keyof typeof REQUIRED_PERMISSIONS> = {
  pulls: "pull_requests",
  repos: "contents",
};

function cloudSources(): string[] {
  const dir = path.join(root, "src/cloud");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => readFileSync(path.join(dir, f), "utf8"));
}

describe("github-app/manifest.json", () => {
  it("declares exactly the permissions and events the code requires (no more)", () => {
    expect(manifest.default_permissions).toEqual(REQUIRED_PERMISSIONS);
    expect([...manifest.default_events].sort()).toEqual([...SUBSCRIBED_EVENTS].sort());
  });

  it("matches PLAN-DETAILED section 8 minimum: no checks, issues, actions, workflows, administration or contents:write", () => {
    const perms = manifest.default_permissions as Record<string, string>;
    expect(perms.contents).toBe("read");
    expect(perms.pull_requests).toBe("write");
    expect(perms.metadata).toBe("read");
    expect(Object.keys(perms).sort()).toEqual(["contents", "metadata", "pull_requests"]);
  });

  it("only uses GitHub API namespaces covered by the declared permissions (checks and issues are not called)", () => {
    const used = new Set<string>();
    for (const src of cloudSources()) for (const m of src.matchAll(/\.rest\.(\w+)\./g)) used.add(m[1]!);
    for (const ns of used) {
      expect(NAMESPACE_PERMISSION[ns], `namespace "${ns}" is not mapped to a declared permission`).toBeDefined();
    }
    const needed = new Set([...used].map((ns) => NAMESPACE_PERMISSION[ns]));
    // Every non-metadata permission must be justified by a call.
    for (const p of Object.keys(REQUIRED_PERMISSIONS)) {
      if (p !== "metadata") expect(needed.has(p as keyof typeof REQUIRED_PERMISSIONS), `permission "${p}" is declared but unused`).toBe(true);
    }
  });

  it("has documented placeholders for the URLs and a private, valid shape", () => {
    expect(manifest.hook_attributes.url).toContain("REPLACE-WITH-YOUR-DOMAIN");
    expect(manifest.hook_attributes.url.endsWith("/api/webhooks/github")).toBe(true);
    expect(manifest.redirect_url).toContain("REPLACE-WITH-YOUR-DOMAIN");
    expect(manifest.public).toBe(false);
    expect(JSON.stringify(manifest)).not.toMatch(/secret|private_key|BEGIN/i);
  });
});
