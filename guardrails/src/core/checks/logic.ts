import { maskLines } from "./lexer";

const STMT_CONT_END = /(?:[=|&,<(:?]|=>)\s*$/;

/**
 * Heuristic: does a TS/JS source file contain runnable logic? Files made only of types/interfaces, imports,
 * re-exports and plain constants (no calls, functions, classes, arrow functions or JSX) return false, so
 * `colocated-test` does not ask for a test next to them. Conservative: when in doubt it says "has logic".
 */
export function hasLogic(source: string): boolean {
  // Drop comments, keep strings but blank their content (a string may contain `(` or `=>`).
  const noComments = maskLines(source, "comment");
  const src = source.replace(/\r\n?/g, "\n").split("\n");
  const code = src
    .map((line, i) => {
      const cm = noComments[i] ?? "";
      let out = "";
      for (let k = 0; k < line.length; k++) out += cm[k] !== " " || line[k] === " " ? " " : line[k];
      return out.trimEnd();
    })
    .join("\n");
  const stringsBlank = blankStrings(code);
  const stmts = splitStatements(stringsBlank);
  for (const raw of stmts) {
    const s = raw.trim();
    if (!s) continue;
    if (/^import\b/.test(s)) continue;
    if (/^export\s+(?:type\s+)?\*/.test(s)) continue;
    if (/^export\s+(?:type\s+)?\{[^}]*\}\s*(?:from\b.*)?$/s.test(s)) continue;
    if (/^(?:export\s+)?(?:declare\s+)?(?:type|interface)\b/.test(s)) continue;
    if (/^(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\b/.test(s)) continue;
    if (/^export\s+default\s+[A-Za-z_$][\w$]*\s*$/.test(s)) continue;
    if (/^["']use (?:client|server)["']$/.test(s.replace(/\s/g, ""))) continue;
    // Constants: `export const X = <no calls, functions, classes, JSX>`
    if (/^(?:export\s+)?(?:const|let|var)\b/.test(s) && !/=>|\bfunction\b|\bclass\b|\bnew\b|\w\s*\(|<\/?[A-Za-z]|\bawait\b/.test(s.replace(/\bas\s+const\b/g, ""))) continue;
    return true;
  }
  return false;
}

function blankStrings(code: string): string {
  const strings = maskLines(code, "string");
  return code
    .split("\n")
    .map((line, i) => {
      const sm = strings[i] ?? "";
      let out = "";
      for (let k = 0; k < line.length; k++) out += sm[k] !== " " && sm[k] !== undefined ? "_" : line[k];
      return out;
    })
    .join("\n");
}

/** Splits at `;` or at a newline outside brackets when the statement is not obviously continued. */
function splitStatements(code: string): string[] {
  const out: string[] = [];
  let cur = "";
  let depth = 0;
  const lines = code.split("\n");
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!;
    for (const ch of line) {
      if ("({[".includes(ch)) depth++;
      else if (")}]".includes(ch)) depth = Math.max(0, depth - 1);
      if (ch === ";" && depth === 0) {
        out.push(cur);
        cur = "";
      } else cur += ch;
    }
    cur += "\n";
    const next = lines.slice(li + 1).find((l) => l.trim() !== "");
    const continues = STMT_CONT_END.test(line) || (next !== undefined && /^\s*(?:[|&.?:]|=>)/.test(next));
    if (depth === 0 && !continues && line.trim() !== "") {
      out.push(cur);
      cur = "";
    }
  }
  if (cur.trim()) out.push(cur);
  return out;
}
