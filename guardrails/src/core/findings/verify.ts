import type { Workspace } from "../workspace";

/** Minimal finding shape the verifier needs (works for v1 and v2 findings). */
export interface VerifiableFinding {
  file: string;
  title: string;
  body: string;
  ruleId?: string | undefined;
}

export const COLOCATED_TESTS_RULE_ID = "colocated-tests";

const EXTENSIONS = "tsx?|jsx?|mjs|cjs|json|md|mdx|css|scss|html|ya?ml|vue|svelte|py|go|rs|java|rb|php|sh";
const PATH = String.raw`(?:[\w@.~-]+\/)*[\w@.~-]+\.(?:${EXTENSIONS})\b`;
/** Words allowed between the absence word and the path ("no colocated test file Foo.test.tsx"). */
const FILLER = String.raw`(?:(?:colocated|co-located|matching|corresponding|dedicated|test|spec|unit|file|the|a|an)\s+)*`;
const QUOTE = "[`'\"]?";

/** "no <path>", "missing <path>", "without <path>", "lacks <path>": the path is the thing claimed absent. */
const OBJECT_AFTER = new RegExp(String.raw`\b(?:no|missing|without|lacks?|lacking|absent)\s+${FILLER}${QUOTE}(${PATH})`, "gi");
/** "<path> does not exist", "<path> is missing", "<path> not found". */
const OBJECT_BEFORE = new RegExp(
  String.raw`(${PATH})${QUOTE}\s+(?:does\s*n[o']t|doesn't|do\s+not|is\s*n[o']t|isn't|was\s*n[o']t|not|is|are)\s+(?:(?:exist|found|present|defined|there|available)\b|missing\b|absent\b)`,
  "gi",
);
/** Generic absence wording, used for the derived colocated-test check (no path in the text). */
const ABSENCE_WORDS =
  /\b(?:no\s+(?:colocated|co-located|matching|corresponding|dedicated|test|spec|unit)|has\s+no\s+(?:colocated\s+)?test|(?:does\s*n[o']t|doesn't|do\s+not)\s+(?:have|exist|include|come\s+with)|not\s+found|missing|without\s+(?:a\s+|its\s+)?(?:colocated\s+|matching\s+)?test|lacks?\b)/i;

const norm = (p: string) => p.replaceAll("\\", "/").replace(/^\.\//, "");
const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

/** Paths a text claims are absent (object of "no X", "X does not exist", "missing X"). */
export function extractAbsenceClaims(text: string): string[] {
  const out = new Set<string>();
  for (const re of [OBJECT_AFTER, OBJECT_BEFORE]) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) out.add(norm(m[1]!));
  }
  return [...out];
}

/** foo.ts -> [foo.test.ts, foo.test.tsx] in the same directory. Empty for files that are already tests or have no extension. */
export function colocatedTestCandidates(file: string): string[] {
  const f = norm(file);
  const m = /^(.*?)\.(tsx?|jsx?)$/.exec(f);
  if (!m || /\.(test|spec)$/.test(m[1]!)) return [];
  const stem = m[1]!;
  const isTs = /^tsx?$/.test(m[2]!);
  const exts = isTs ? ["ts", "tsx"] : ["js", "jsx", "ts", "tsx"];
  return exts.map((e) => `${stem}.test.${e}`);
}

/**
 * Does the claimed path exist? A path with a directory matches exactly or as a suffix; a bare file name is only
 * looked up next to the file the finding is about (the usual "next to it" claim). Unknown -> false (do not discard).
 */
function pathExists(claimed: string, findingFile: string, files: ReadonlySet<string>): boolean {
  if (claimed.includes("/")) {
    if (files.has(claimed)) return true;
    for (const f of files) if (f.endsWith("/" + claimed)) return true;
    return false;
  }
  const dir = dirOf(norm(findingFile));
  return files.has(dir ? `${dir}/${claimed}` : claimed);
}

/**
 * Returns the reason a finding is contradicted by the repo, or null. Conservative: only an explicit absence claim
 * about a file that is present in the tree counts; a text without a path (and not the colocated-tests rule) is kept.
 */
export function contradiction(f: VerifiableFinding, files: ReadonlySet<string>): string | null {
  const text = `${f.title}\n${f.body}`;
  const claimed = extractAbsenceClaims(text);
  if (claimed.length && claimed.every((c) => pathExists(c, f.file, files))) {
    return `claims ${claimed.join(", ")} is absent but it exists`;
  }
  const colocated = f.ruleId === COLOCATED_TESTS_RULE_ID || /co-?located\s+tests?/i.test(text);
  if (!claimed.length && colocated && ABSENCE_WORDS.test(text)) {
    const found = colocatedTestCandidates(f.file).find((c) => files.has(c));
    if (found) return `claims the colocated test is absent but ${found} exists`;
  }
  return null;
}

export interface VerifyResult<T> {
  kept: T[];
  contradicted: { finding: T; detail: string }[];
}

/**
 * Deterministic grounding check of absence claims against the head tree. Any workspace failure keeps every finding.
 */
export async function verifyAbsenceClaims<T extends VerifiableFinding>(findings: readonly T[], ws: Workspace): Promise<VerifyResult<T>> {
  if (!findings.length) return { kept: [], contradicted: [] };
  let files: Set<string>;
  try {
    files = new Set((await ws.listFiles({ ref: "head", limit: 50_000 })).files.map(norm));
  } catch {
    return { kept: [...findings], contradicted: [] };
  }
  const kept: T[] = [];
  const contradicted: VerifyResult<T>["contradicted"] = [];
  for (const f of findings) {
    const detail = contradiction(f, files);
    if (detail) contradicted.push({ finding: f, detail });
    else kept.push(f);
  }
  return { kept, contradicted };
}
