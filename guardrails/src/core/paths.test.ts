import { describe, it, expect } from "vitest";
import { isIgnored, DEFAULT_IGNORES } from "./paths";

describe("isIgnored", () => {
  it("**/*.generated.ts matches root and nested files", () => {
    const pats = ["**/*.generated.ts"];
    expect(isIgnored("a.generated.ts", pats)).toBe(true);
    expect(isIgnored("x/y/a.generated.ts", pats)).toBe(true);
    expect(isIgnored("x/y/a.ts", pats)).toBe(false);
  });

  it("supports ? and {a,b}", () => {
    expect(isIgnored("src/a1.ts", ["src/a?.ts"])).toBe(true);
    expect(isIgnored("src/b.js", ["src/*.{ts,js}"])).toBe(true);
    expect(isIgnored("src/b.py", ["src/*.{ts,js}"])).toBe(false);
  });

  it("ignores lockfiles and build output by default", () => {
    expect(isIgnored("pnpm-lock.yaml")).toBe(true);
    expect(isIgnored("apps/web/pnpm-lock.yaml")).toBe(true);
    expect(isIgnored("dist/index.js")).toBe(true);
    expect(isIgnored("public/app.min.js")).toBe(true);
    expect(isIgnored("src/index.ts")).toBe(false);
    expect(DEFAULT_IGNORES.length).toBeGreaterThan(0);
  });

  it("empty patterns ignore nothing", () => {
    expect(isIgnored("pnpm-lock.yaml", [])).toBe(false);
  });
});
