/**
 * Every user-facing text that CODE generates (checks, summary, coverage, "Also at", cloud notices, CLI output), in each
 * supported language. The `Messages` interface forces both languages to define every message: a missing one fails the
 * type check. Text written by the model or by the user (rules) is never translated here.
 *
 * Never translated: identifiers, rule ids, file paths, code, JSON keys and the words `check` / `model` used as labels
 * (the legend explains them in the chosen language, the two words stay so the tables stay searchable).
 */

export const LANGUAGES = ["en", "es"] as const;
export type Language = (typeof LANGUAGES)[number];
export const DEFAULT_LANGUAGE: Language = "en";

export function isLanguage(v: unknown): v is Language {
  return typeof v === "string" && (LANGUAGES as readonly string[]).includes(v);
}

export type ModelFailure = "budget" | "timeout" | "error";
export type FailureKindKey = "diff-too-large" | "rate-limit" | "budget" | "timeout";

/** "1 rule" / "3 rules". */
export const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** English name of a language, used inside the (English) prompts. */
export const LANGUAGE_NAMES: Record<Language, string> = { en: "English", es: "Spanish" };

/**
 * One instruction added to the review prompts when the language is not English (`undefined` for English, so the English
 * prompts stay byte for byte the same). The model writes its own texts in that language; code and quotes stay as they are.
 */
export function languageInstruction(lang: Language | undefined): string | undefined {
  if (!lang || lang === DEFAULT_LANGUAGE) return undefined;
  return `Write the title, body, suggestion and notes of every finding in ${LANGUAGE_NAMES[lang]}. Keep code, identifiers, file paths, rule ids and text quoted from the repository unchanged.`;
}

export interface Messages {
  checks: {
    /** `file` is the file name (without directories). */
    maxLinesTitle(file: string, n: number, max: number): string;
    maxLinesDetail(path: string, n: number, max: number): string;
    maxLinesAction: string;
    missingTestTitle(file: string): string;
    missingTestDetail(path: string, name: string): string;
    missingTestAction(expectedPath: string): string;
    forbidImportTitle(specifier: string): string;
    forbidImportDetail(path: string, specifier: string, pattern: string): string;
    forbidImportAction: string;
    forbidPatternTitle(match: string): string;
    forbidPatternDetail(line: number, path: string, source: string, only?: string): string;
    forbidPatternAction: string;
    /** "Rule `id`: first sentence of the rule" */
    ruleLine(id: string, text: string): string;
  };
  /** "Rule `id` (source)" line under a finding that cites a rule. */
  citation(id: string, source?: string): string;
  /** "Also at lines 2, 3 and 4 more." `shown` are the listed lines, `more` the ones summarised. */
  alsoAt(shown: readonly number[], more: number): string;
  summary: {
    header(mode: string, detail: string): string;
    findings(total: number, fromChecks: number, fromModel: number, merged: number): string;
    couldNotComplete: string;
    noIssues: string;
    omitted(n: number): string;
    passesFailed(failed: number, passes: number): string;
    modelFailed(reason: ModelFailure): string;
    checkFindingsNote(n: number): string;
    describeMode(mode: string, detail: string): string;
    stats(costUsd: number | null, seconds: number, passes: number): string;
  };
  coverage: {
    prefix: string;
    complete: string;
    partial(reasons: string, more: number): string;
    reasonModelTimeout: string;
    reasonModelBudget: string;
    reasonModelError: string;
    reasonNoValidReport: string;
    reasonPassFailed(failed: number, passes: number): string;
    reasonStepBudget: string;
    reasonMissingVerdicts(n: number): string;
    reasonDiffOverBudget(n: number): string;
    reasonSingleFallback(repoTooLarge: boolean): string;
    reasonChecksSkipped(n: number): string;
    noChangedFiles: string;
    filesLine(reviewed: number, total: number, byModel: boolean, others: string): string;
    ignored(n: number): string;
    removed(n: number): string;
    noDiff(n: number): string;
    overBudget(n: number): string;
    noRulesInScope: string;
    rulesInScope(n: number, parts: string): string;
    byChecks(n: number): string;
    byModel(n: number, withVerdict: number): string;
    notReviewed(n: number): string;
    hiddenPath: string;
    detailsSummary: string;
    fileHeader: string;
    ruleHeader: string;
    moreFiles(n: number): string;
    moreRules(n: number): string;
    legend: string;
    fileRemoved: string;
    fileIgnored(byConfig: boolean): string;
    fileNoDiff: string;
    fileOverBudget: string;
    fileChecksOnly(opened: boolean): string;
    fileReviewed(opened: boolean): string;
    modelReported(n: number): string;
    modelViolatedNotPublished(filtered?: string): string;
    modelOk: string;
    modelNotApplicable: string;
    modelNotAsked: string;
    modelNoVerdict: string;
    modelNotRun: string;
    checkViolations(n: number): string;
    checkNoneFound(patternOnly: boolean): string;
    checkNotRun: string;
    howCheckModel: string;
    howModelCheckFailed: string;
    dropDuplicate: string;
    dropLowConfidence: string;
    dropCommentTypeDisabled: string;
    dropContradicted: string;
    dropOverCap: string;
    filtered(list: string): string;
    agentTail(steps: number, opened: number): string;
    singleTail: string;
    outOfScope(n: number): string;
    observationsTitle: string;
    observationsMore(n: number): string;
    observationsSummary: string;
  };
  cloud: {
    rulesChangeNote(touched: string): string;
    failure: Record<FailureKindKey, (maxDiffChars: string) => string>;
  };
  cli: {
    header(range: string, files: number, mode: string, model: string): string;
    rulesApplied(ids: string): string;
    noFindings: string;
    findingMeta(severity: string, type: string, confidence: number, isCheck: boolean): string;
    suggestion: string;
    dropped(n: number): string;
    droppedRow(reason: string, file: string, line: number, title: string, confidence: number, type: string): string;
    notes(text: string): string;
    mechanical(findings: number, ran: string): string;
    modelIncomplete(reason: string): string;
    cost(costUsd: number | null, steps: number, input: number, output: number): string;
    threshold(failOn: string): string;
  };
}

const en: Messages = {
  checks: {
    maxLinesTitle: (file, n, max) => `File too long: ${file} has ${n} lines (limit ${max})`,
    maxLinesDetail: (path, n, max) => `\`${path}\` has ${n} lines; the limit is ${max}.`,
    maxLinesAction: "Split the file.",
    missingTestTitle: (file) => `Missing test file: ${file} has no test next to it`,
    missingTestDetail: (path, name) => `\`${path}\` has no \`${name}.test.*\` or \`${name}.spec.*\` next to it.`,
    missingTestAction: (p) => `Add ${p}.`,
    forbidImportTitle: (s) => `Forbidden import: ${s}`,
    forbidImportDetail: (path, s, pattern) => `\`${path}\` imports "${s}", which matches the forbidden pattern \`${pattern}\`.`,
    forbidImportAction: "Remove or replace this import (see the rule above).",
    forbidPatternTitle: (m) => `Forbidden pattern in added code: "${m}"`,
    forbidPatternDetail: (line, path, source, only) => `Line ${line} of \`${path}\` matches the forbidden pattern \`${source}\`${only ? ` (inside ${only})` : ""}.`,
    forbidPatternAction: "See the rule above.",
    ruleLine: (id, text) => `Rule \`${id}\`: ${text}`,
  },
  citation: (id, source) => `Rule \`${id}\`${source ? ` (${source})` : ""}`,
  alsoAt: (shown, more) => `Also at line${shown.length + more > 1 ? "s" : ""} ${more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", ")}.`,
  summary: {
    header: (mode, detail) => `**Guardrails** · mode ${mode} (${detail})`,
    findings: (total, fromChecks, fromModel, merged) =>
      `${count(total, "finding", "findings")}: ${fromChecks} from checks, ${fromModel} from the model` + (merged ? `, ${count(merged, "merged duplicate", "merged duplicates")}` : ""),
    couldNotComplete: "The analysis of this change could not be completed. Push a new commit to try again.",
    noIssues: "No issues found.",
    omitted: (n) => `${n} lower-priority finding(s) omitted: over the review cap.`,
    passesFailed: (failed, passes) => `${failed} of ${passes} review passes did not complete (time or budget); results come from the other pass and the mechanical checks.`,
    modelFailed: (r) =>
      `The model-based review did not complete (${{ budget: "it reached its spend limit", timeout: "it ran out of time", error: "it failed" }[r]}); only the mechanical check results are shown.`,
    checkFindingsNote: (n) => `${n} finding(s) come from mechanical rule checks.`,
    describeMode: (mode, detail) => `Review mode: ${mode} (${detail}).`,
    stats: (cost, s, passes) => [cost === null ? "Cost n/a" : `Cost ~US$${cost.toFixed(2)}`, `${s} s`, count(passes, "pass", "passes")].join(" · "),
  },
  coverage: {
    prefix: "Coverage",
    complete: "complete",
    partial: (reasons, more) => `partial (${reasons}${more > 0 ? `; +${more} more` : ""})`,
    reasonModelTimeout: "model ran out of time: checks only",
    reasonModelBudget: "model reached its spend limit: checks only",
    reasonModelError: "model failed: checks only",
    reasonNoValidReport: "model gave no valid report: checks only",
    reasonPassFailed: (failed, passes) => `${failed} of ${passes} passes failed`,
    reasonStepBudget: "agent hit its step limit",
    reasonMissingVerdicts: (n) => (n ? `no verdict for ${count(n, "rule", "rules")}` : "some rule verdicts missing"),
    reasonDiffOverBudget: (n) => `${count(n, "file", "files")} over the diff budget`,
    reasonSingleFallback: (big) => `${big ? "repo too large" : "repo download failed"}: single-call review`,
    reasonChecksSkipped: (n) => `${count(n, "check", "checks")} not run`,
    noChangedFiles: "no changed files",
    filesLine: (reviewed, total, byModel, others) =>
      `${reviewed} of ${count(total, "changed file", "changed files")} reviewed${byModel ? " by the model" : ""}${others ? ` (${others})` : ""}`,
    ignored: (n) => `${n} ignored`,
    removed: (n) => `${n} removed`,
    noDiff: (n) => `${n} without diff`,
    overBudget: (n) => `${n} over budget`,
    noRulesInScope: "no rules in scope",
    rulesInScope: (n, parts) => `${count(n, "rule", "rules")} in scope: ${parts}`,
    byChecks: (n) => `${n} by checks`,
    byModel: (n, v) => `${n} by the model (${v} with a verdict)`,
    notReviewed: (n) => `${n} not reviewed`,
    hiddenPath: "(hidden: looks like a secret)",
    detailsSummary: "What was reviewed",
    fileHeader: "| File | Status |",
    ruleHeader: "| Rule | How | Result |",
    moreFiles: (n) => `and ${count(n, "more file", "more files")}.`,
    moreRules: (n) => `and ${count(n, "more rule", "more rules")}.`,
    legend: "**check** = exact result of code for what the check tests. **model** = the model's claim; it can be wrong. Coverage says what was looked at, not that it was looked at correctly.",
    fileRemoved: "removed",
    fileIgnored: (cfg) => `ignored (${cfg ? "config" : "default"})`,
    fileNoDiff: "no diff (binary or too large)",
    fileOverBudget: "over the diff budget · checks ran",
    fileChecksOnly: (o) => `checks only${o ? " · opened by the agent" : ""}`,
    fileReviewed: (o) => `reviewed${o ? " · opened by the agent" : ""}`,
    modelReported: (n) => `${n} reported`,
    modelViolatedNotPublished: (f) => `violated, not published${f ? ` (filtered: ${f})` : ""}`,
    modelOk: "ok",
    modelNotApplicable: "not applicable",
    modelNotAsked: "not asked",
    modelNoVerdict: "no verdict",
    modelNotRun: "not run",
    checkViolations: (n) => count(n, "violation", "violations"),
    checkNoneFound: (p) => (p ? "none found (pattern only)" : "none found"),
    checkNotRun: "not run",
    howCheckModel: "check + model",
    howModelCheckFailed: "model (check could not run)",
    dropDuplicate: "duplicates (of a check finding or of a finding on the same line)",
    dropLowConfidence: "below the confidence threshold",
    dropCommentTypeDisabled: "of a disabled comment type",
    dropContradicted: "contradicted by the repository",
    dropOverCap: "over the review cap",
    filtered: (list) => `Filtered before publishing: ${list}.`,
    agentTail: (steps, opened) => `Agent: ${count(steps, "step", "steps")}, ${count(opened, "file", "files")} opened outside the diff.`,
    singleTail: "Single call: no tools.",
    outOfScope: (n) => `${count(n, "other active rule", "other active rules")} out of scope.`,
    observationsTitle: "**Lower-confidence observations** (not posted as comments):",
    observationsMore: (n) => `and ${n} more`,
    observationsSummary: "Lower-confidence observations",
  },
  cloud: {
    rulesChangeNote: (touched) =>
      `ℹ️ This PR changes the Guardrails rules (${touched}). This review used the rules from the base branch; the changes apply to PRs after merge.`,
    failure: {
      "diff-too-large": (max) =>
        `**Guardrails** skipped this pull request: the change is too large for one review (limit: ${max} characters of diff). Split it into smaller pull requests, or add \`skip-guardrails\` to opt out.`,
      "rate-limit": () => "**Guardrails** could not review this pull request: a rate limit was hit. Push a new commit to try again.",
      budget: () => "**Guardrails** stopped this review because it reached its spend limit. Push a new commit to try again.",
      timeout: () => "**Guardrails** stopped this review because it ran out of time. Push a new commit to try again.",
    },
  },
  cli: {
    header: (range, files, mode, model) => `Guardrails review: ${range} (${files} file(s)), mode ${mode}, model ${model}`,
    rulesApplied: (ids) => `Rules applied: ${ids}`,
    noFindings: "No findings.",
    findingMeta: (sev, type, conf, isCheck) => `[${sev}/${type}, confidence ${conf}${isCheck ? ", check" : ""}]`,
    suggestion: "Suggestion:",
    dropped: (n) => `Dropped (${n}):`,
    droppedRow: (reason, file, line, title, conf, type) => `  - ${reason}: ${file}:${line} ${title} (confidence ${conf}, ${type})`,
    notes: (t) => `Notes: ${t}`,
    mechanical: (n, ran) => `Mechanical checks: ${n} finding(s); rules checked: ${ran || "none"}`,
    modelIncomplete: (r) => `The model part did not complete (${r}); only mechanical check findings are shown.`,
    cost: (usd, steps, i, o) => `Cost: ${usd === null ? "unknown (no known price)" : `$${usd.toFixed(5)}`}; ${steps} step(s), ${i} input / ${o} output tokens`,
    threshold: (f) => (f === "none" ? "Threshold: none (never fails)." : `Threshold: fail on ${f} or higher.`),
  },
};

const es: Messages = {
  checks: {
    maxLinesTitle: (file, n, max) => `Archivo demasiado largo: ${file} tiene ${n} líneas (límite ${max})`,
    maxLinesDetail: (path, n, max) => `\`${path}\` tiene ${n} líneas; el límite es ${max}.`,
    maxLinesAction: "Divide el archivo.",
    missingTestTitle: (file) => `Falta el archivo de test: ${file} no tiene un test al lado`,
    missingTestDetail: (path, name) => `\`${path}\` no tiene un \`${name}.test.*\` ni un \`${name}.spec.*\` al lado.`,
    missingTestAction: (p) => `Agrega ${p}.`,
    forbidImportTitle: (s) => `Import prohibido: ${s}`,
    forbidImportDetail: (path, s, pattern) => `\`${path}\` importa "${s}", que coincide con el patrón prohibido \`${pattern}\`.`,
    forbidImportAction: "Elimina o reemplaza este import (mira la regla de arriba).",
    forbidPatternTitle: (m) => `Patrón prohibido en el código agregado: "${m}"`,
    forbidPatternDetail: (line, path, source, only) =>
      `La línea ${line} de \`${path}\` coincide con el patrón prohibido \`${source}\`${only ? ` (dentro de ${{ comments: "comentarios", strings: "cadenas de texto", code: "código" }[only] ?? only})` : ""}.`,
    forbidPatternAction: "Mira la regla de arriba.",
    ruleLine: (id, text) => `Regla \`${id}\`: ${text}`,
  },
  citation: (id, source) => `Regla \`${id}\`${source ? ` (${source})` : ""}`,
  alsoAt: (shown, more) => `También en línea${shown.length + more > 1 ? "s" : ""} ${more > 0 ? `${shown.join(", ")} y ${more} más` : shown.join(", ")}.`,
  summary: {
    header: (mode, detail) => `**Guardrails** · modo ${mode} (${detail})`,
    findings: (total, fromChecks, fromModel, merged) =>
      `${count(total, "hallazgo", "hallazgos")}: ${fromChecks} de checks, ${fromModel} del modelo` + (merged ? `, ${count(merged, "duplicado combinado", "duplicados combinados")}` : ""),
    couldNotComplete: "No se pudo completar el análisis de este cambio. Sube un nuevo commit para intentarlo de nuevo.",
    noIssues: "No se encontraron problemas.",
    omitted: (n) => `${n} hallazgo(s) de menor prioridad omitido(s): por encima del tope de la revisión.`,
    passesFailed: (failed, passes) => `${failed} de ${passes} pasadas de revisión no se completaron (tiempo o presupuesto); los resultados vienen de la otra pasada y de los checks mecánicos.`,
    modelFailed: (r) =>
      `La revisión basada en el modelo no se completó (${{ budget: "llegó a su límite de gasto", timeout: "se quedó sin tiempo", error: "falló" }[r]}); solo se muestran los resultados de los checks mecánicos.`,
    checkFindingsNote: (n) => `${n} hallazgo(s) vienen de checks mecánicos de reglas.`,
    describeMode: (mode, detail) => `Modo de revisión: ${mode} (${detail}).`,
    stats: (cost, s, passes) => [cost === null ? "Costo n/d" : `Costo ~US$${cost.toFixed(2)}`, `${s} s`, count(passes, "pasada", "pasadas")].join(" · "),
  },
  coverage: {
    prefix: "Cobertura",
    complete: "completa",
    partial: (reasons, more) => `parcial (${reasons}${more > 0 ? `; +${more} más` : ""})`,
    reasonModelTimeout: "el modelo se quedó sin tiempo: solo checks",
    reasonModelBudget: "el modelo llegó a su límite de gasto: solo checks",
    reasonModelError: "el modelo falló: solo checks",
    reasonNoValidReport: "el modelo no dio un informe válido: solo checks",
    reasonPassFailed: (failed, passes) => `${failed} de ${passes} pasadas fallaron`,
    reasonStepBudget: "el agente llegó a su límite de pasos",
    reasonMissingVerdicts: (n) => (n ? `sin veredicto para ${count(n, "regla", "reglas")}` : "faltan algunos veredictos de reglas"),
    reasonDiffOverBudget: (n) => `${count(n, "archivo", "archivos")} fuera del presupuesto del diff`,
    reasonSingleFallback: (big) => `${big ? "repositorio demasiado grande" : "falló la descarga del repositorio"}: revisión de una sola llamada`,
    reasonChecksSkipped: (n) => `${count(n, "check", "checks")} sin ejecutar`,
    noChangedFiles: "sin archivos modificados",
    filesLine: (reviewed, total, byModel, others) =>
      `${reviewed} de ${count(total, "archivo modificado revisado", "archivos modificados revisados")}${byModel ? " por el modelo" : ""}${others ? ` (${others})` : ""}`,
    ignored: (n) => `${n} ignorados`,
    removed: (n) => `${n} eliminados`,
    noDiff: (n) => `${n} sin diff`,
    overBudget: (n) => `${n} fuera de presupuesto`,
    noRulesInScope: "sin reglas en alcance",
    rulesInScope: (n, parts) => `${count(n, "regla", "reglas")} en alcance: ${parts}`,
    byChecks: (n) => `${n} por checks`,
    byModel: (n, v) => `${n} por el modelo (${v} con veredicto)`,
    notReviewed: (n) => `${n} sin revisar`,
    hiddenPath: "(oculto: parece un secreto)",
    detailsSummary: "Qué se revisó",
    fileHeader: "| Archivo | Estado |",
    ruleHeader: "| Regla | Cómo | Resultado |",
    moreFiles: (n) => `y ${count(n, "archivo más", "archivos más")}.`,
    moreRules: (n) => `y ${count(n, "regla más", "reglas más")}.`,
    legend: "**check** = resultado exacto de código para lo que el check prueba. **model** = lo que afirma el modelo; puede equivocarse. La cobertura dice qué se miró, no que se haya mirado correctamente.",
    fileRemoved: "eliminado",
    fileIgnored: (cfg) => `ignorado (${cfg ? "config" : "por defecto"})`,
    fileNoDiff: "sin diff (binario o demasiado grande)",
    fileOverBudget: "fuera del presupuesto del diff · los checks corrieron",
    fileChecksOnly: (o) => `solo checks${o ? " · abierto por el agente" : ""}`,
    fileReviewed: (o) => `revisado${o ? " · abierto por el agente" : ""}`,
    modelReported: (n) => `${n} reportados`,
    modelViolatedNotPublished: (f) => `violada, no publicada${f ? ` (filtrados: ${f})` : ""}`,
    modelOk: "ok",
    modelNotApplicable: "no aplica",
    modelNotAsked: "no consultada",
    modelNoVerdict: "sin veredicto",
    modelNotRun: "no ejecutada",
    checkViolations: (n) => count(n, "infracción", "infracciones"),
    checkNoneFound: (p) => (p ? "ninguna encontrada (solo el patrón)" : "ninguna encontrada"),
    checkNotRun: "no ejecutado",
    howCheckModel: "check + model",
    howModelCheckFailed: "model (el check no pudo ejecutarse)",
    dropDuplicate: "duplicados (de un hallazgo de check o de otro en la misma línea)",
    dropLowConfidence: "por debajo del umbral de confianza",
    dropCommentTypeDisabled: "de un tipo de comentario desactivado",
    dropContradicted: "contradichos por el repositorio",
    dropOverCap: "por encima del tope de la revisión",
    filtered: (list) => `Filtrados antes de publicar: ${list}.`,
    agentTail: (steps, opened) => `Agente: ${count(steps, "paso", "pasos")}, ${count(opened, "archivo abierto", "archivos abiertos")} fuera del diff.`,
    singleTail: "Llamada única: sin herramientas.",
    outOfScope: (n) => `${count(n, "otra regla activa", "otras reglas activas")} fuera de alcance.`,
    observationsTitle: "**Observaciones de menor confianza** (no publicadas como comentarios):",
    observationsMore: (n) => `y ${n} más`,
    observationsSummary: "Observaciones de menor confianza",
  },
  cloud: {
    rulesChangeNote: (touched) =>
      `ℹ️ Este PR cambia las reglas de Guardrails (${touched}). Esta revisión usó las reglas de la rama base; los cambios se aplican a los PR posteriores al merge.`,
    failure: {
      "diff-too-large": (max) =>
        `**Guardrails** omitió este pull request: el cambio es demasiado grande para una sola revisión (límite: ${max} caracteres de diff). Divídelo en pull requests más pequeños, o agrega \`skip-guardrails\` para excluirlo.`,
      "rate-limit": () => "**Guardrails** no pudo revisar este pull request: se alcanzó un límite de uso. Sube un nuevo commit para intentarlo de nuevo.",
      budget: () => "**Guardrails** detuvo esta revisión porque llegó a su límite de gasto. Sube un nuevo commit para intentarlo de nuevo.",
      timeout: () => "**Guardrails** detuvo esta revisión porque se quedó sin tiempo. Sube un nuevo commit para intentarlo de nuevo.",
    },
  },
  cli: {
    header: (range, files, mode, model) => `Revisión de Guardrails: ${range} (${files} archivo(s)), modo ${mode}, modelo ${model}`,
    rulesApplied: (ids) => `Reglas aplicadas: ${ids}`,
    noFindings: "Sin hallazgos.",
    findingMeta: (sev, type, conf, isCheck) => `[${sev}/${type}, confianza ${conf}${isCheck ? ", check" : ""}]`,
    suggestion: "Sugerencia:",
    dropped: (n) => `Descartados (${n}):`,
    droppedRow: (reason, file, line, title, conf, type) => `  - ${reason}: ${file}:${line} ${title} (confianza ${conf}, ${type})`,
    notes: (t) => `Notas: ${t}`,
    mechanical: (n, ran) => `Checks mecánicos: ${n} hallazgo(s); reglas verificadas: ${ran || "ninguna"}`,
    modelIncomplete: (r) => `La parte del modelo no se completó (${r}); solo se muestran los hallazgos de los checks mecánicos.`,
    cost: (usd, steps, i, o) => `Costo: ${usd === null ? "desconocido (sin precio conocido)" : `$${usd.toFixed(5)}`}; ${steps} paso(s), ${i} tokens de entrada / ${o} de salida`,
    threshold: (f) => (f === "none" ? "Umbral: ninguno (nunca falla)." : `Umbral: falla con ${f} o superior.`),
  },
};

export const MESSAGES: Record<Language, Messages> = { en, es };

/** The messages of a language (English when none is given). */
export function messages(lang: Language = DEFAULT_LANGUAGE): Messages {
  return MESSAGES[lang];
}
