import { promises as fs } from "node:fs";
import path from "node:path";
import { caseSchema, reposFileSchema, type Case, type ReposFile } from "./schema";

export const EVAL_DIR = __dirname;

export type LoadIssue = { file: string; message: string };

function formatZod(err: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return err.issues.map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`).join("; ");
}

async function readJson(file: string): Promise<{ ok: true; data: unknown } | { ok: false; message: string }> {
  try {
    return { ok: true, data: JSON.parse(await fs.readFile(file, "utf8")) };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

/** Loads and validates every `<casesDir>/<id>/case.json`. Never throws on bad cases; reports issues. */
export async function loadCases(casesDir = path.join(EVAL_DIR, "cases")): Promise<{ cases: Case[]; issues: LoadIssue[] }> {
  const cases: Case[] = [];
  const issues: LoadIssue[] = [];
  let entries: string[];
  try {
    entries = (await fs.readdir(casesDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch {
    return { cases, issues: [{ file: casesDir, message: "cases directory not found" }] };
  }
  const seen = new Set<string>();
  for (const dir of entries) {
    const file = path.join(casesDir, dir, "case.json");
    const raw = await readJson(file);
    if (!raw.ok) {
      issues.push({ file, message: raw.message });
      continue;
    }
    const parsed = caseSchema.safeParse(raw.data);
    if (!parsed.success) {
      issues.push({ file, message: formatZod(parsed.error) });
      continue;
    }
    if (parsed.data.id !== dir) {
      issues.push({ file, message: `id "${parsed.data.id}" does not match directory name "${dir}"` });
      continue;
    }
    if (seen.has(parsed.data.id)) {
      issues.push({ file, message: `duplicate id ${parsed.data.id}` });
      continue;
    }
    seen.add(parsed.data.id);
    cases.push(parsed.data);
  }
  return { cases, issues };
}

export async function loadRepos(file = path.join(EVAL_DIR, "repos.json")): Promise<{ repos?: ReposFile; issues: LoadIssue[] }> {
  const raw = await readJson(file);
  if (!raw.ok) return { issues: [{ file, message: raw.message }] };
  const parsed = reposFileSchema.safeParse(raw.data);
  if (!parsed.success) return { issues: [{ file, message: formatZod(parsed.error) }] };
  return { repos: parsed.data, issues: [] };
}
