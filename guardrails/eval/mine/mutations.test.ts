import { describe, expect, it } from "vitest";
import { MUTATIONS, type Mutation } from "./mutations";

const byId = (id: string): Mutation => MUTATIONS.find((m) => m.id === id)!;
const apply = (id: string, line: string, lang: "ts" | "py" = "ts", lines: string[] = [line], index = 0) =>
  byId(id).apply(line, lang, { lines, index, file: "x" });

describe("mutation catalog", () => {
  it("has 10 mutations, 4 of them cross-file", () => {
    expect(MUTATIONS).toHaveLength(10);
    expect(MUTATIONS.filter((m) => m.crossFile)).toHaveLength(4);
  });

  it("local mutations are deterministic single-line edits", () => {
    expect(apply("off-by-one", "for (let i = 0; i < items.length; i++) {")?.line).toBe("for (let i = 0; i <= items.length; i++) {");
    expect(apply("inverted-condition", "  if (a === b) {")?.line).toBe("  if (a !== b) {");
    expect(apply("null-check-removed", "const n = user?.name")?.line).toBe("const n = user.name");
    expect(apply("missing-await", "const r = await load(x)")?.line).toBe("const r = load(x)");
    expect(apply("args-swapped", "copy(src, dst)")?.line).toBe("copy(dst, src)");
    expect(apply("logical-operator-swap", "if a and b:", "py")?.line).toBe("if a or b:");
  });

  it("does not touch string literals or comments-only matches", () => {
    expect(apply("inverted-condition", `  if (msg === "a === b") {`)?.line).toBe(`  if (msg !== "a === b") {`);
    expect(apply("missing-await", `log("await x")`)).toBeNull();
  });

  it("cross-file mutations report the affected symbol", () => {
    const sig = apply("signature-params-swapped", "export function load(id: string, opts: Opts) {");
    expect(sig?.symbol).toBe("load");
    expect(sig?.line).toBe("export function load(opts: Opts, id: string) {");
    expect(apply("declaration-renamed", "def build(a, b):", "py")?.line).toBe("def buildV2(a, b):");
    const lines = ["export function ok(x: number) {", "  if (x > 1) {", "    return true;", "  }", "}"];
    const flipped = apply("return-boolean-flipped", lines[2]!, "ts", lines, 2);
    expect(flipped).toMatchObject({ symbol: "ok", line: "    return false;" });
  });

  it("does not attribute a return inside a callback to the outer function", () => {
    const lines = ["export function outer() {", "  items.map((i) => {", "    return i.value;", "  })", "}"];
    expect(apply("return-value-dropped", lines[2]!, "ts", lines, 2)).toBeNull();
  });
});
