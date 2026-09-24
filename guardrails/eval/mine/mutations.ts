/**
 * Catalog of 10 deterministic bug mutations (PLAN-DETAILED 7.1 B), no LLM.
 * 6 local (the bug shows in the mutated line) + 4 cross-file (the mutated file's contract changes and a
 * caller in another file breaks). All operate on one source line, so line numbers never shift.
 */

export type MutLang = "ts" | "py";

export interface MutationCtx {
  lines: string[];
  /** 0-based index of the line being mutated. */
  index: number;
  file: string;
}

export interface MutationSite {
  /** The mutated line. */
  line: string;
  /** Human-readable change, e.g. "`<` -> `<=`". */
  detail: string;
  /** Cross-file only: the symbol whose contract changed (callers live in other files). */
  symbol?: string;
}

export interface Mutation {
  id: string;
  title: string;
  crossFile: boolean;
  languages: MutLang[];
  severity: "high" | "medium" | "low";
  category: string;
  /** Cross-file: what the caller line must look like. `call` = any call; `result` = the return value is used. */
  callerUse?: "call" | "result";
  apply(line: string, lang: MutLang, ctx: MutationCtx): MutationSite | null;
}

const COMMENT_PREFIXES = ["//", "#", "*", "/*", "*/"];

export function isCode(line: string): boolean {
  const t = line.trim();
  return t.length > 0 && t.length <= 220 && !COMMENT_PREFIXES.some((p) => t.startsWith(p));
}

/** True when `idx` sits inside a '...', "..." or `...` literal (crude, per line). */
export function inString(line: string, idx: number): boolean {
  for (const q of ["'", '"', "`"]) {
    let n = 0;
    for (let i = 0; i < idx; i++) if (line[i] === q && line[i - 1] !== "\\") n++;
    if (n % 2 === 1) return true;
  }
  return false;
}

/** Replaces the first regex match not inside a string literal. */
function replaceFirst(line: string, re: RegExp, fn: (m: RegExpExecArray) => string): { line: string; m: RegExpExecArray } | null {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  let m: RegExpExecArray | null;
  while ((m = g.exec(line))) {
    if (!inString(line, m.index)) {
      return { line: line.slice(0, m.index) + fn(m) + line.slice(m.index + m[0].length), m };
    }
    if (m[0].length === 0) g.lastIndex++;
  }
  return null;
}

function balanced(s: string): boolean {
  let p = 0;
  let b = 0;
  let c = 0;
  for (const ch of s) {
    if (ch === "(") p++;
    else if (ch === ")") p--;
    else if (ch === "[") b++;
    else if (ch === "]") b--;
    else if (ch === "{") c++;
    else if (ch === "}") c--;
    if (p < 0 || b < 0 || c < 0) return false;
  }
  return p === 0 && b === 0 && c === 0;
}

function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if ("<([{".includes(ch)) depth++;
    else if (">)]}".includes(ch)) depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  return parts;
}

const indentOf = (l: string) => /^[ \t]*/.exec(l)![0].length;

const FN_TS = /^\s*(export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+(\w+)\s*[<(]|^\s*(export\s+)?const\s+(\w+)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*(?::[^=]+)?=>/;
const FN_PY = /^(\s*)(?:async\s+)?def\s+(\w+)\s*\(/;
const CONTROL_TS = /^\s*(\}\s*)?(if|else|for|while|switch|case|default|try|catch|finally|do)\b/;
const CONTROL_PY = /^\s*(if|elif|else|for|while|try|except|finally|with)\b/;

/**
 * Name of the function whose body directly contains line `index` (only through control-flow blocks).
 * Returns null for callbacks, nested arrows and anything ambiguous. `exported` is only meaningful for TS.
 */
export function enclosingFunction(ctx: MutationCtx, lang: MutLang): { name: string; exported: boolean } | null {
  const { lines, index } = ctx;
  let indent = indentOf(lines[index]!);
  for (let i = index - 1; i >= 0; i--) {
    const l = lines[i]!;
    if (l.trim() === "" || indentOf(l) >= indent) continue;
    if (lang === "ts") {
      const m = FN_TS.exec(l);
      if (m) return { name: (m[2] ?? m[4])!, exported: Boolean(m[1] ?? m[3]) };
      if (!CONTROL_TS.test(l)) return null;
    } else {
      const m = FN_PY.exec(l);
      if (m) return { name: m[2]!, exported: m[1]!.length === 0 && !m[2]!.startsWith("_") };
      if (!CONTROL_PY.test(l)) return null;
    }
    indent = indentOf(l);
  }
  return null;
}

// ---------------------------------------------------------------- local mutations

const offByOne: Mutation = {
  id: "off-by-one",
  title: "Off-by-one in a loop/boundary comparison",
  crossFile: false,
  languages: ["ts", "py"],
  severity: "medium",
  category: "logic",
  apply(line, lang) {
    const lenRe = lang === "ts" ? /(?<![<=])<(?!=)(\s*[\w.$]+\.length\b)/ : /(?<![<=])<(?!=)(\s*len\()/;
    const a = replaceFirst(line, lenRe, (m) => `<=${m[1]}`);
    if (a) return { line: a.line, detail: "`<` became `<=` against a length (iterates one element past the end)" };
    const b = replaceFirst(line, /(?<![>=-])>=(?![=>])/, () => ">");
    if (b) return { line: b.line, detail: "`>=` became `>` (boundary value now excluded)" };
    const c = replaceFirst(line, /(?<![<=-])<=(?![=>])/, () => "<");
    if (c) return { line: c.line, detail: "`<=` became `<` (boundary value now excluded)" };
    return null;
  },
};

const invertedCondition: Mutation = {
  id: "inverted-condition",
  title: "Condition inverted",
  crossFile: false,
  languages: ["ts", "py"],
  severity: "high",
  category: "logic",
  apply(line, lang) {
    const isCond = lang === "ts" ? /^\s*(\}\s*else\s+)?if\s*\(/.test(line) : /^\s*(if|elif|while)\s/.test(line);
    if (!isCond) return null;
    const ops: [RegExp, string, string][] = [
      [/(?<![=!<>])===(?!=)/, "!==", "`===` became `!==`"],
      [/(?<![=!<>])!==(?!=)/, "===", "`!==` became `===`"],
      [/(?<![=!<>])==(?![=])/, "!=", "`==` became `!=`"],
      [/(?<![=!<>])!=(?![=])/, "==", "`!=` became `==`"],
    ];
    for (const [re, to, detail] of ops) {
      const r = replaceFirst(line, re, () => to);
      if (r) return { line: r.line, detail };
    }
    if (lang === "ts") {
      const r = replaceFirst(line, /\bif\s*\(!(?=[\w$.])/, () => "if (");
      if (r) return { line: r.line, detail: "leading `!` removed from the `if` condition" };
    } else {
      const r = replaceFirst(line, /\b(if|elif|while) not\s+/, (m) => `${m[1]} `);
      if (r) return { line: r.line, detail: "`not` removed from the condition" };
    }
    return null;
  },
};

const nullCheckRemoved: Mutation = {
  id: "null-check-removed",
  title: "Null/undefined guard removed",
  crossFile: false,
  languages: ["ts", "py"],
  severity: "high",
  category: "null-safety",
  apply(line, lang) {
    if (lang === "ts") {
      const g = replaceFirst(line, /([\w$]+) && \1\.(?=[\w$])/, (m) => `${m[1]}.`);
      if (g) return { line: g.line, detail: "guard `x && x.y` reduced to `x.y` (no null check)" };
      const r = replaceFirst(line, /\?\.(?=[\w$[(])/, () => ".");
      if (r) return { line: r.line, detail: "optional chaining `?.` replaced by `.` (throws on null/undefined)" };
      return null;
    }
    const r = replaceFirst(line, /[\w.]+ is not None and /, () => "");
    if (r) return { line: r.line, detail: "`x is not None and` guard removed" };
    return null;
  },
};

const missingAwait: Mutation = {
  id: "missing-await",
  title: "Missing await on an async call",
  crossFile: false,
  languages: ["ts", "py"],
  severity: "high",
  category: "async",
  apply(line) {
    if (/\bfor\s+await\b|\basync\s+for\b|\basync\s+with\b/.test(line)) return null;
    const r = replaceFirst(line, /\bawait\s+(?=[\w$(])/, () => "");
    return r ? { line: r.line, detail: "`await` removed (the promise/coroutine is used unresolved)" } : null;
  },
};

const NOT_CALLS = new Set(["if", "for", "while", "switch", "catch", "function", "def", "return", "typeof", "await", "new", "super", "elif", "and", "or", "not", "print"]);

const argsSwapped: Mutation = {
  id: "args-swapped",
  title: "Two call arguments swapped",
  crossFile: false,
  languages: ["ts", "py"],
  severity: "medium",
  category: "logic",
  apply(line) {
    if (/\b(function|def|class|interface|type)\b/.test(line)) return null;
    const g = new RegExp(/([\w$.]+)\(\s*([A-Za-z_$][\w$.]*)\s*,\s*([A-Za-z_$][\w$.]*)\s*([,)])/.source, "g");
    let m: RegExpExecArray | null;
    while ((m = g.exec(line))) {
      const callee = m[1]!.split(".").pop()!;
      if (NOT_CALLS.has(callee) || inString(line, m.index) || m[2] === m[3]) continue;
      const rep = `${m[1]}(${m[3]}, ${m[2]}${m[4]}`;
      return { line: line.slice(0, m.index) + rep + line.slice(m.index + m[0].length), detail: `arguments \`${m[2]}\` and \`${m[3]}\` swapped in the call to \`${callee}\`` };
    }
    return null;
  },
};

const logicalOperatorSwap: Mutation = {
  id: "logical-operator-swap",
  title: "Logical operator swapped (and/or)",
  crossFile: false,
  languages: ["ts", "py"],
  severity: "medium",
  category: "logic",
  apply(line, lang) {
    if (lang === "ts") {
      if (!/^\s*(\}\s*else\s+)?if\s*\(/.test(line)) return null;
      const a = replaceFirst(line, /\s&&\s/, () => " || ");
      if (a) return { line: a.line, detail: "`&&` became `||` in an `if` condition" };
      const b = replaceFirst(line, /\s\|\|\s/, () => " && ");
      if (b) return { line: b.line, detail: "`||` became `&&` in an `if` condition" };
      return null;
    }
    if (!/^\s*(if|elif|while)\s/.test(line)) return null;
    const a = replaceFirst(line, /\sand\s/, () => " or ");
    if (a) return { line: a.line, detail: "`and` became `or` in a condition" };
    const b = replaceFirst(line, /\sor\s/, () => " and ");
    if (b) return { line: b.line, detail: "`or` became `and` in a condition" };
    return null;
  },
};

// ---------------------------------------------------------------- cross-file mutations

const signatureParamsSwapped: Mutation = {
  id: "signature-params-swapped",
  title: "Function signature changed (first two parameters swapped); callers not updated",
  crossFile: true,
  languages: ["ts", "py"],
  severity: "high",
  category: "api-contract",
  callerUse: "call",
  apply(line, lang) {
    let m: RegExpExecArray | null;
    if (lang === "ts") {
      m = /^(\s*export\s+(?:default\s+)?(?:async\s+)?function\*?\s+)(\w+)(\s*(?:<[^>(]*>)?\s*)\(([^()]*)\)(.*)$/.exec(line);
      if (!m) return null;
    } else {
      m = /^(def\s+|async\s+def\s+)(\w+)()\(([^()]*)\)(.*)$/.exec(line);
      if (!m || m[2]!.startsWith("_")) return null;
    }
    const params = splitTopLevel(m[4]!).map((p) => p.trim());
    const start = lang === "py" && /^(self|cls)$/.test(params[0] ?? "") ? 1 : 0;
    const a = params[start];
    const b = params[start + 1];
    if (!a || !b) return null;
    if ([a, b].some((p) => /[{[=?*.]/.test(p))) return null;
    const nameOf = (p: string) => p.split(/[:\s]/)[0]!;
    if (nameOf(a) === nameOf(b)) return null;
    const next = [...params];
    next[start] = b;
    next[start + 1] = a;
    const out = `${m[1]}${m[2]}${m[3]}(${next.join(", ")})${m[5]}`;
    return { line: out, symbol: m[2]!, detail: `parameters \`${nameOf(a)}\` and \`${nameOf(b)}\` of \`${m[2]}\` swapped in the signature` };
  },
};

function returnMutation(id: string, title: string, re: RegExp, to: (m: RegExpExecArray, lang: MutLang) => string, detail: (m: RegExpExecArray) => string): Mutation {
  return {
    id,
    title,
    crossFile: true,
    languages: ["ts", "py"],
    severity: "high",
    category: "api-contract",
    callerUse: "result",
    apply(line, lang, ctx) {
      const m = re.exec(line);
      if (!m) return null;
      const expr = m[2] ?? "";
      if (!balanced(expr) || /^(undefined|None|void 0)$/.test(expr.trim())) return null;
      const fn = enclosingFunction(ctx, lang);
      if (!fn || !fn.exported && lang === "ts") return null;
      const out = to(m, lang);
      if (out === line) return null;
      return { line: out, symbol: fn.name, detail: detail(m).replace("$fn", fn.name) };
    },
  };
}

const returnDropped = returnMutation(
  "return-value-dropped",
  "Return value dropped in an exported function; callers still use the result",
  /^(\s*)return\s+([^;\s][^;]*?);?\s*$/,
  (m, lang) => (lang === "ts" ? `${m[1]}return;` : `${m[1]}return None`),
  () => "`return <value>` replaced by an empty return in `$fn` (callers still consume the result)",
);

const returnFlipped = returnMutation(
  "return-boolean-flipped",
  "Boolean return semantics flipped in an exported function; callers not updated",
  /^(\s*)return\s+(true|false|True|False)\b;?\s*$/,
  (m, lang) => {
    const v = m[2]!;
    const flipped = v === "true" ? "false" : v === "false" ? "true" : v === "True" ? "False" : "True";
    return `${m[1]}return ${flipped}${lang === "ts" ? ";" : ""}`;
  },
  (m) => `\`return ${m[2]}\` flipped in \`$fn\` (callers rely on the old meaning of the result)`,
);

const declRenamed: Mutation = {
  id: "declaration-renamed",
  title: "Exported function renamed without updating its callers",
  crossFile: true,
  languages: ["ts", "py"],
  severity: "high",
  category: "api-contract",
  callerUse: "call",
  apply(line, lang) {
    const m =
      lang === "ts"
        ? /^(\s*export\s+(?:default\s+)?(?:async\s+)?function\*?\s+)(\w+)(\s*[<(].*)$/.exec(line)
        : /^(def\s+|async\s+def\s+)(\w+)(\(.*)$/.exec(line);
    if (!m || m[2]!.startsWith("_")) return null;
    const name = m[2]!;
    const renamed = `${name}V2`;
    return { line: `${m[1]}${renamed}${m[3]}`, symbol: name, detail: `\`${name}\` renamed to \`${renamed}\` in its declaration only; callers still use \`${name}\`` };
  },
};

export const MUTATIONS: readonly Mutation[] = [
  offByOne,
  invertedCondition,
  nullCheckRemoved,
  missingAwait,
  argsSwapped,
  logicalOperatorSwap,
  signatureParamsSwapped,
  returnDropped,
  returnFlipped,
  declRenamed,
];

export function callerRegex(symbol: string, use: "call" | "result"): RegExp {
  const s = symbol.replace(/[$]/g, "\\$");
  return use === "call"
    ? new RegExp(`(^|[^\\w$.])${s}\\s*\\(|\\.${s}\\s*\\(`)
    : new RegExp(`(=|\\(|return|await|&&|\\|\\||\\bif|\\bnot)\\s*(?:await\\s+)?[\\w$.]*\\b${s}\\s*\\(`);
}
