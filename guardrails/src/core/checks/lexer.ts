/**
 * Minimal lexer for TS/JS/TSX/JSX used by `forbid-pattern(comments|code|strings)`.
 * It classifies every character of a file as code, comment or string so a regex can be applied to one zone only.
 *
 * Limitations (documented in the README): regex literals are not recognized (a quote inside one can confuse the lexer),
 * JSX text between tags counts as code, and template literals are strings except for the `${...}` expressions.
 */
export type Zone = "code" | "comment" | "string";

export const LEXABLE = /\.(?:[cm]?[jt]sx?)$/i;

/** Returns, per line (0-based), the text of the line with every character outside `zone` replaced by a space. */
export function maskLines(text: string, zone: Zone): string[] {
  const src = text.replace(/\r\n?/g, "\n");
  const kinds: Zone[] = new Array<Zone>(src.length).fill("code");
  const braceStack: number[] = []; // template literal nesting: brace depth at which `${` was opened
  let i = 0;
  let depth = 0;
  const mark = (from: number, to: number, z: Zone) => {
    for (let k = from; k < to && k < src.length; k++) kinds[k] = z;
  };
  const scanTemplate = () => {
    // called with i just after the opening backtick or the closing brace of a `${}`
    const start = i;
    while (i < src.length) {
      const c = src[i]!;
      if (c === "\\") i += 2;
      else if (c === "`") {
        mark(start - 1 < 0 ? 0 : start - 1, i + 1, "string");
        i++;
        return;
      } else if (c === "$" && src[i + 1] === "{") {
        mark(start, i + 2, "string");
        braceStack.push(depth);
        depth++;
        i += 2;
        return; // back to code until the matching `}`
      } else i++;
    }
    mark(start, src.length, "string");
  };
  while (i < src.length) {
    const c = src[i]!;
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      const end = src.indexOf("\n", i);
      const to = end === -1 ? src.length : end;
      mark(i, to, "comment");
      i = to;
    } else if (c === "/" && n === "*") {
      const end = src.indexOf("*/", i + 2);
      const to = end === -1 ? src.length : end + 2;
      mark(i, to, "comment");
      i = to;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      mark(i, j + 1, "string");
      i = j + 1;
    } else if (c === "`") {
      i++;
      scanTemplate();
    } else if (c === "{") {
      depth++;
      i++;
    } else if (c === "}") {
      depth = Math.max(0, depth - 1);
      i++;
      if (braceStack.length && braceStack[braceStack.length - 1] === depth) {
        braceStack.pop();
        scanTemplate();
      }
    } else i++;
  }
  return src.split("\n").map((line, idx, all) => {
    let offset = 0;
    for (let k = 0; k < idx; k++) offset += all[k]!.length + 1;
    let out = "";
    for (let k = 0; k < line.length; k++) out += kinds[offset + k] === zone ? line[k] : " ";
    offset += line.length + 1;
    return out;
  });
}
