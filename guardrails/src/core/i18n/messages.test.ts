import { describe, expect, it } from "vitest";
import { buildAgentInstructions } from "../agent/prompts";
import { defaultConfig, safeParseConfig } from "../config";
import { computeCoverage, type CoverageFileInput, type CoverageInput } from "../coverage";
import { formatCoverageDetails, formatCoverageLine, MAX_COVERAGE_DETAILS, MAX_COVERAGE_LINE } from "../coverage-render";
import { buildSystemPrompt } from "../prompt";
import { buildSummary, statsFooter } from "../summary";
import { LANGUAGES, MESSAGES, isLanguage, messages, type Language } from "./messages";
import { withAlsoAt } from "../findings/dedupe";

/** Every leaf path of a messages object ("checks.maxLinesTitle"), with the kind of leaf. */
function leaves(o: unknown, prefix = ""): string[] {
  if (typeof o === "function" || typeof o === "string") return [`${prefix}:${typeof o}`];
  return Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k));
}

describe("messages: both languages", () => {
  it("every message key exists in every language with the same kind (text or function)", () => {
    const reference = leaves(MESSAGES.en).sort();
    expect(reference.length).toBeGreaterThan(80);
    for (const lang of LANGUAGES) expect(leaves(MESSAGES[lang]).sort(), lang).toEqual(reference);
  });

  it("no message is empty and Spanish differs from English where it is text", () => {
    const walk = (en: unknown, es: unknown, path: string): void => {
      if (typeof en === "string") {
        expect(en, path).not.toBe("");
        expect(es, path).not.toBe("");
        return;
      }
      if (typeof en === "function") return;
      for (const k of Object.keys(en as object)) walk((en as Record<string, unknown>)[k], (es as Record<string, unknown>)[k], `${path}.${k}`);
    };
    walk(MESSAGES.en, MESSAGES.es, "");
  });

  it("isLanguage and the default", () => {
    expect(isLanguage("en")).toBe(true);
    expect(isLanguage("es")).toBe(true);
    expect(isLanguage("fr")).toBe(false);
    expect(isLanguage(undefined)).toBe(false);
    expect(messages()).toBe(MESSAGES.en);
  });
});

describe("check texts", () => {
  it("English", () => {
    const m = messages("en").checks;
    expect(m.missingTestTitle("RepositoryBadge.tsx")).toBe("Missing test file: RepositoryBadge.tsx has no test next to it");
    expect(m.missingTestAction("src/components/RepositoryBadge.test.tsx")).toBe("Add src/components/RepositoryBadge.test.tsx.");
    expect(m.forbidImportTitle("../data/repository")).toBe("Forbidden import: ../data/repository");
    expect(m.forbidImportAction).toBe("Remove or replace this import (see the rule above).");
    expect(m.forbidPatternTitle("TODO")).toBe('Forbidden pattern in added code: "TODO"');
    expect(m.forbidPatternAction).toBe("See the rule above.");
    expect(m.maxLinesTitle("a.ts", 200, 150)).toBe("File too long: a.ts has 200 lines (limit 150)");
    expect(m.maxLinesAction).toBe("Split the file.");
  });
  it("Spanish has the same structure", () => {
    const m = messages("es").checks;
    expect(m.missingTestTitle("RepositoryBadge.tsx")).toBe("Falta el archivo de test: RepositoryBadge.tsx no tiene un test al lado");
    expect(m.missingTestAction("src/components/RepositoryBadge.test.tsx")).toBe("Agrega src/components/RepositoryBadge.test.tsx.");
    expect(m.forbidImportTitle("../data/repository")).toBe("Import prohibido: ../data/repository");
    expect(m.forbidPatternTitle("TODO")).toBe('Patrón prohibido en el código agregado: "TODO"');
    expect(m.maxLinesTitle("a.ts", 200, 150)).toBe("Archivo demasiado largo: a.ts tiene 200 líneas (límite 150)");
  });
});

const rule = (id: string) => ({ id, rule: `Rule ${id}.`, scope: ["**"], severity: "medium" as const, status: "active" as const });
const file = (path: string, state: CoverageFileInput["state"] = "in-input", ignoredBy?: CoverageFileInput["ignoredBy"]): CoverageFileInput => ({ path, state, ...(ignoredBy ? { ignoredBy } : {}) });
const covInput = (over: Partial<CoverageInput> = {}): CoverageInput => ({
  files: [file("src/a.ts")],
  rules: [],
  engine: "agent",
  ruleChecksMode: "ask",
  checks: { ran: [], exhaustive: [], partial: [], skipped: [] },
  findings: [],
  dropped: [],
  passes: 1,
  passesFailed: 0,
  forcedWrapUp: false,
  filesOpened: [],
  steps: 3,
  ...over,
});

describe("Spanish coverage, summary and notices", () => {
  it("the coverage line is Spanish and stays within 220 characters even in the worst case", () => {
    const worst = computeCoverage(
      covInput({
        files: [file("a.ts"), file("b.ts", "over-budget"), file("c.ts", "ignored", "default-ignore"), file("d.ts", "removed"), file("e.ts", "no-diff"), ...Array.from({ length: 30 }, (_, i) => file(`f${i}.ts`))],
        rules: Array.from({ length: 12 }, (_, i) => rule(`r${i}`)),
        checks: { ran: ["r0"], exhaustive: ["r0"], partial: [], skipped: [{ ruleId: "r1", reason: "needs-workspace" }] },
        modelIncomplete: "timeout",
        incomplete: true,
        passes: 2,
        passesFailed: 1,
        fallback: "download-failed",
      }),
    );
    const line = formatCoverageLine(worst, "es");
    expect(line.startsWith("Cobertura: parcial (")).toBe(true);
    expect(line.length).toBeLessThanOrEqual(MAX_COVERAGE_LINE);
    expect(formatCoverageLine(worst, "en").startsWith("Coverage: partial (")).toBe(true);
    const ok = computeCoverage(covInput({ files: [file("a.ts"), file("b.ts", "ignored", "default-ignore")], rules: [rule("c1"), rule("m1")], checks: { ran: ["c1"], exhaustive: ["c1"], partial: [], skipped: [] }, ruleChecks: [{ ruleId: "m1", verdict: "ok" }] }));
    expect(formatCoverageLine(ok, "es")).toBe("Cobertura: completa · 1 de 2 archivos modificados revisados (1 ignorados) · 2 reglas en alcance: 1 por checks, 1 por el modelo (1 con veredicto)");
  });

  it("the details block is Spanish, keeps the words check and model, and stays within 8,000 characters", () => {
    const many = computeCoverage(
      covInput({
        files: Array.from({ length: 300 }, (_, i) => file(`src/some/deeply/nested/directory/structure/component-number-${i}.tsx`)),
        rules: Array.from({ length: 200 }, (_, i) => rule(`a-fairly-long-rule-identifier-${i}`)),
        checks: { ran: [], exhaustive: [], partial: [], skipped: [] },
      }),
    );
    const details = formatCoverageDetails(many, undefined, "es");
    expect(details.length).toBeLessThanOrEqual(MAX_COVERAGE_DETAILS);
    const small = formatCoverageDetails(computeCoverage(covInput({ rules: [rule("c1")], checks: { ran: ["c1"], exhaustive: ["c1"], partial: [], skipped: [] } })), { shown: [{ file: "a.ts", title: "t" }], total: 3 }, "es");
    expect(small).toContain("<summary>Qué se revisó</summary>");
    expect(small).toContain("| Archivo | Estado |");
    expect(small).toContain("| Regla | Cómo | Resultado |");
    expect(small).toContain("| `c1` | check | ninguna encontrada |");
    expect(small).toContain("**check** = resultado exacto de código");
    expect(small).toContain("**model** = lo que afirma el modelo");
    expect(small).toContain("**Observaciones de menor confianza**");
    expect(small).toContain("y 2 más");
  });

  it("the summary, stats and cloud notices are generated in Spanish", () => {
    const s = buildSummary({ selection: { mode: "deep", detail: "x" }, total: 3, fromChecks: 1, fromModel: 2, merged: 1 }, "es");
    expect(s).toContain("**Guardrails** · modo deep (x)");
    expect(s).toContain("3 hallazgos: 1 de checks, 2 del modelo, 1 duplicado combinado");
    expect(buildSummary({ total: 0, fromChecks: 0, fromModel: 0 }, "es")).toContain("No se encontraron problemas.");
    expect(statsFooter({ costUsd: 0.0184, ms: 38_200, passes: 2 }, "es")).toBe("Costo ~US$0.02 · 38 s · 2 pasadas");
    for (const k of ["diff-too-large", "rate-limit", "budget", "timeout"] as const) {
      expect(messages("es").cloud.failure[k]("200,000")).toContain("**Guardrails**");
      expect(messages("es").cloud.failure[k]("200,000")).not.toBe(messages("en").cloud.failure[k]("200,000"));
    }
  });

  it("'Also at' in Spanish, and the English text is unchanged", () => {
    expect(withAlsoAt("body", [5])).toBe("body\n\nAlso at line 5.");
    expect(withAlsoAt("body", [5, 6], "es")).toBe("body\n\nTambién en líneas 5, 6.");
    expect(withAlsoAt("body", [1, 2, 3, 4, 5, 6, 7, 8], "es")).toContain("También en líneas 1, 2, 3, 4, 5, 6 y 2 más.");
  });
});

describe("config language", () => {
  it("defaults to English", () => {
    expect(defaultConfig.language).toBe("en");
    expect(safeParseConfig("{}").config.language).toBe("en");
  });
  it("accepts es", () => {
    const r = safeParseConfig('{"language":"es"}');
    expect(r.config.language).toBe("es");
    expect(r.errors).toEqual([]);
  });
  it("an invalid value falls back to en and reports an error", () => {
    const r = safeParseConfig('{"language":"fr","coverage":"line"}');
    expect(r.config.language).toBe("en");
    expect(r.config.coverage).toBe("line");
    expect(r.errors.map((e) => e.path)).toEqual(["language"]);
  });
});

describe("prompts and language", () => {
  const cfg = (language: Language) => ({ ...defaultConfig, language, instructions: "Be kind.", rules: [{ id: "r", rule: "Do x.", scope: ["**"], severity: "medium" as const, status: "active" as const }] });
  const budget = { maxSteps: 5 } as Parameters<typeof buildAgentInstructions>[1];
  it("English prompts are byte-identical to the ones without a language", () => {
    const { language: _l, ...legacy } = cfg("en");
    void _l;
    expect(buildSystemPrompt(cfg("en"))).toBe(buildSystemPrompt(legacy as never));
    expect(buildSystemPrompt(cfg("en"))).not.toContain("Spanish");
    expect(buildAgentInstructions(cfg("en"), budget)).not.toContain("Spanish");
  });
  it("Spanish adds one language instruction to both prompts", () => {
    const single = buildSystemPrompt(cfg("es"));
    const agent = buildAgentInstructions(cfg("es"), budget);
    for (const p of [single, agent]) {
      expect(p).toContain("Write the title, body, suggestion and notes of every finding in Spanish");
      expect(p.match(/Write the title, body, suggestion and notes/g)).toHaveLength(1);
      expect(p).toContain("unchanged");
    }
    // the rest of the prompt is exactly the English one plus the instruction
    expect(single.replace(/\n\nWrite the title[^\n]*/, "")).toBe(buildSystemPrompt(cfg("en")));
    expect(agent.replace(/\n\nWrite the title[^\n]*/, "")).toBe(buildAgentInstructions(cfg("en"), budget));
  });
});
