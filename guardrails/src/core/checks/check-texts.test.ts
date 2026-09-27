import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import type { Rule } from "../config";
import { defaultConfig } from "../config";
import { parseUnifiedDiff } from "../diff";
import { reviewDiff } from "../review";
import type { Language } from "../i18n";
import { addDiff, memWorkspace } from "./checks.test";
import { runChecks } from "./index";

const rule = (over: Partial<Rule> & { id: string }): Rule => ({ rule: `Rule ${over.id} text. More text.`, scope: ["**"], severity: "medium", status: "active", ...over });
const run = (rules: Rule[], files: Record<string, string>, lang?: Language) =>
  runChecks({ rules, files: parseUnifiedDiff(addDiff(files)), workspace: memWorkspace(files), ...(lang ? { lang } : {}) });
const logic = "export function f(a: number) {\n  return a + 1;\n}\n";

describe("colocated-test texts", () => {
  const r = rule({ id: "tests", check: "colocated-test" });
  it("English: names the file, ends with the derived test path (.tsx and .ts)", async () => {
    const tsx = (await run([r], { "src/components/RepositoryBadge.tsx": logic })).findings[0]!;
    expect(tsx.title).toBe("Missing test file: RepositoryBadge.tsx has no test next to it");
    expect(tsx.body).toBe("`src/components/RepositoryBadge.tsx` has no `RepositoryBadge.test.*` or `RepositoryBadge.spec.*` next to it. Rule `tests`: Rule tests text. More text. Add src/components/RepositoryBadge.test.tsx.");
    const ts = (await run([r], { "src/lib/util.ts": logic })).findings[0]!;
    expect(ts.body.endsWith("Add src/lib/util.test.ts.")).toBe(true);
    const root = (await run([r], { "a.ts": logic })).findings[0]!;
    expect(root.body.endsWith("Add a.test.ts.")).toBe(true);
  });
  it("Spanish", async () => {
    const f = (await run([r], { "src/components/RepositoryBadge.tsx": logic }, "es")).findings[0]!;
    expect(f.title).toBe("Falta el archivo de test: RepositoryBadge.tsx no tiene un test al lado");
    expect(f.body).toContain("no tiene un `RepositoryBadge.test.*` ni un `RepositoryBadge.spec.*` al lado.");
    expect(f.body).toContain("Regla `tests`: Rule tests text. More text.");
    expect(f.body.endsWith("Agrega src/components/RepositoryBadge.test.tsx.")).toBe(true);
  });
});

describe("forbid-import, forbid-pattern and max-lines texts", () => {
  it("forbid-import", async () => {
    const files = { "src/components/A.tsx": "import x from '../data/repository';\n" };
    const en = (await run([rule({ id: "layers", check: "forbid-import: **/data/**" })], files)).findings[0]!;
    expect(en.title).toBe("Forbidden import: ../data/repository");
    expect(en.body.endsWith("Remove or replace this import (see the rule above).")).toBe(true);
    expect(en.body).toContain("Rule `layers`: Rule layers text. More text.");
    const es = (await run([rule({ id: "layers", check: "forbid-import: **/data/**" })], files, "es")).findings[0]!;
    expect(es.title).toBe("Import prohibido: ../data/repository");
    expect(es.body.endsWith("Elimina o reemplaza este import (mira la regla de arriba).")).toBe(true);
  });
  it("forbid-pattern", async () => {
    const files = { "src/a.ts": "// TODO fix\n" };
    const en = (await run([rule({ id: "todo", check: "forbid-pattern: TODO" })], files)).findings[0]!;
    expect(en.title).toBe('Forbidden pattern in added code: "TODO"');
    expect(en.body.startsWith("Line 1 of `src/a.ts` matches the forbidden pattern `TODO`.")).toBe(true);
    expect(en.body.endsWith("See the rule above.")).toBe(true);
    const es = (await run([rule({ id: "todo", check: "forbid-pattern(comments): TODO" })], files, "es")).findings[0]!;
    expect(es.title).toBe('Patrón prohibido en el código agregado: "TODO"');
    expect(es.body.startsWith("La línea 1 de `src/a.ts` coincide con el patrón prohibido `TODO` (dentro de comentarios).")).toBe(true);
    expect(es.body.endsWith("Mira la regla de arriba.")).toBe(true);
  });
  it("max-lines", async () => {
    const files = { "src/big.ts": "1\n2\n3\n4\n5\n" };
    const en = (await run([rule({ id: "short", check: "max-lines: 3" })], files)).findings[0]!;
    expect(en.title).toBe("File too long: big.ts has 5 lines (limit 3)");
    expect(en.body.endsWith("Split the file.")).toBe(true);
    const es = (await run([rule({ id: "short", check: "max-lines: 3" })], files, "es")).findings[0]!;
    expect(es.title).toBe("Archivo demasiado largo: big.ts tiene 5 líneas (límite 3)");
    expect(es.body.endsWith("Divide el archivo.")).toBe(true);
  });
  it("a long pattern match is shortened in the title and the action stays at the end", async () => {
    const files = { "src/a.ts": `// ${"x".repeat(60)}\n` };
    const f = (await run([rule({ id: "p", check: "forbid-pattern: x+" })], files)).findings[0]!;
    expect(f.title).toBe(`Forbidden pattern in added code: "${"x".repeat(27)}..."`);
    expect(f.body.endsWith("See the rule above.")).toBe(true);
  });
});

describe("reviewDiff follows config.language", () => {
  const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
  const model = () =>
    new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "tool-call", toolCallId: "r", toolName: "report_findings", input: JSON.stringify({ findings: [] }) }],
        finishReason: { unified: "tool-calls", raw: undefined },
        usage,
        warnings: [],
      }),
    });
  const files = { "src/big.ts": "1\n2\n3\n4\n5\n" };
  const input = { diff: addDiff(files), context: {}, docs: {} };
  const cfg = (language: Language) => ({ ...defaultConfig, language, rules: [rule({ id: "short", check: "max-lines: 3" })] });

  it("es: check finding and the summary text of the review are Spanish; en is unchanged", async () => {
    const es = await reviewDiff(input, { config: cfg("es"), model: model(), mode: "agent", workspace: memWorkspace(files) });
    expect(es.findings[0]!.title).toBe("Archivo demasiado largo: big.ts tiene 5 líneas (límite 3)");
    expect(es.summary).toContain("1 hallazgo(s) vienen de checks mecánicos de reglas.");
    const en = await reviewDiff(input, { config: cfg("en"), model: model(), mode: "agent", workspace: memWorkspace(files) });
    expect(en.findings[0]!.title).toBe("File too long: big.ts has 5 lines (limit 3)");
    expect(en.summary).toContain("1 finding(s) come from mechanical rule checks.");
  });

  it("the model prompt carries the language instruction only for es", async () => {
    const m1 = model();
    await reviewDiff(input, { config: cfg("es"), model: m1, mode: "agent", workspace: memWorkspace(files) });
    expect(JSON.stringify(m1.doGenerateCalls[0]!.prompt)).toContain("in Spanish");
    const m2 = model();
    await reviewDiff(input, { config: cfg("en"), model: m2, mode: "agent", workspace: memWorkspace(files) });
    expect(JSON.stringify(m2.doGenerateCalls[0]!.prompt)).not.toContain("in Spanish");
  });

  it("the JSON shape and the hidden fields do not depend on the language", async () => {
    const strip = (r: Awaited<ReturnType<typeof reviewDiff>>) => ({ keys: Object.keys(r).sort(), f: r.findings.map((f) => ({ file: f.file, line: f.line, ruleId: f.ruleId, origin: f.origin, severity: f.severity, type: f.type })), checks: r.checks });
    const a = await reviewDiff(input, { config: cfg("es"), model: model(), mode: "agent", workspace: memWorkspace(files) });
    const b = await reviewDiff(input, { config: cfg("en"), model: model(), mode: "agent", workspace: memWorkspace(files) });
    expect(strip(a)).toEqual(strip(b));
  });
});
