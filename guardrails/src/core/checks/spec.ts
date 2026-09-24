import safeRegex from "safe-regex2";

/**
 * Mechanical checks attached to a rule with `check:` in rules.md (one line).
 *
 *   check: max-lines: 150
 *   check: colocated-test
 *   check: forbid-import: **\/repositories/**        (glob when it has * ? { }, else a substring of the import specifier)
 *   check: forbid-pattern: [áéíóúñ¿¡]                (regex, or /regex/flags with flags i and u only)
 *   check: forbid-pattern(comments): [áéíóúñ]         (only inside comments; also `code` and `strings`)
 */
export type CheckSpec =
  | { kind: "max-lines"; max: number }
  | { kind: "colocated-test" }
  | { kind: "forbid-import"; pattern: string }
  | { kind: "forbid-pattern"; source: string; flags: string; only?: PatternZone };

/**
 * How much of a rule a check decides. `exhaustive`: the check fully decides the rule, so the model skips it.
 * `partial`: the check only catches a subset of violations, so the model still reviews the rule.
 */
export type CheckCoverage = "exhaustive" | "partial";
export const CHECK_COVERAGE_VALUES = ["exhaustive", "partial"] as const;

/** Default coverage per kind: length and test presence are decided completely; imports and patterns are a subset. */
export function defaultCoverage(spec: CheckSpec): CheckCoverage {
  return spec.kind === "max-lines" || spec.kind === "colocated-test" ? "exhaustive" : "partial";
}

export type PatternZone = "comments" | "code" | "strings";

/** Longest regex source accepted for `forbid-pattern`. */
export const MAX_PATTERN_LENGTH = 200;
export const MAX_LINES_LIMIT = 100_000;

export type ParsedCheck = { ok: true; spec: CheckSpec } | { ok: false; error: string };

const FORM = /^([a-z-]+)(?:\((comments|code|strings)\))?\s*(?::\s*(.*))?$/s;

function fail(error: string): ParsedCheck {
  return { ok: false, error };
}

/** Parses and validates a `check:` value. Never throws. */
export function parseCheck(value: string): ParsedCheck {
  const m = FORM.exec(value.trim());
  if (!m) return fail(`invalid check "${value.trim()}"`);
  const [, kind, zone, rawArg] = m;
  const arg = rawArg?.trim() ?? "";
  if (zone && kind !== "forbid-pattern") return fail(`"(${zone})" only applies to forbid-pattern`);
  switch (kind) {
    case "max-lines": {
      if (!/^\d+$/.test(arg)) return fail("max-lines needs a positive integer, e.g. `max-lines: 150`");
      const max = Number(arg);
      if (max < 1 || max > MAX_LINES_LIMIT) return fail(`max-lines must be between 1 and ${MAX_LINES_LIMIT}`);
      return { ok: true, spec: { kind: "max-lines", max } };
    }
    case "colocated-test":
      if (arg) return fail("colocated-test takes no argument");
      return { ok: true, spec: { kind: "colocated-test" } };
    case "forbid-import":
      if (!arg) return fail("forbid-import needs a pattern (glob or substring)");
      if (arg.length > MAX_PATTERN_LENGTH) return fail(`forbid-import pattern is longer than ${MAX_PATTERN_LENGTH} characters`);
      return { ok: true, spec: { kind: "forbid-import", pattern: arg } };
    case "forbid-pattern": {
      if (!arg) return fail("forbid-pattern needs a regular expression");
      let source = arg;
      let flags = "";
      const lit = /^\/(.+)\/([a-z]*)$/s.exec(arg);
      if (lit) {
        source = lit[1]!;
        flags = lit[2]!;
        if (!/^[iu]*$/.test(flags)) return fail("forbid-pattern flags may only be i and u");
      }
      if (source.length > MAX_PATTERN_LENGTH) return fail(`forbid-pattern regex is longer than ${MAX_PATTERN_LENGTH} characters`);
      let re: RegExp;
      try {
        re = new RegExp(source, flags);
      } catch (e) {
        return fail(`forbid-pattern regex is invalid: ${(e as Error).message}`);
      }
      if (!safeRegex(re)) return fail("forbid-pattern regex is rejected as unsafe (possible catastrophic backtracking)");
      return { ok: true, spec: { kind: "forbid-pattern", source, flags, ...(zone ? { only: zone as PatternZone } : {}) } };
    }
    default:
      return fail(`unknown check type "${kind}" (expected max-lines, colocated-test, forbid-import or forbid-pattern)`);
  }
}
