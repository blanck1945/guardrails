import { parseArgs } from "node:util";
import { loadCases, loadRepos } from "./loader";
import { mineClean } from "./mine/clean";
import { mineInject } from "./mine/inject";
import { mineInjection } from "./mine/injection";
import { mineSzz } from "./mine/szz";

async function validate(): Promise<number> {
  const { cases, issues } = await loadCases();
  const repos = await loadRepos();
  const all = [...issues, ...repos.issues];
  for (const i of all) console.error(`INVALID ${i.file}: ${i.message}`);
  if (cases.length === 0 && all.length === 0) {
    console.error("No cases found in eval/cases");
    return 1;
  }
  console.log(`cases: ${cases.length} valid, ${issues.length} invalid`);
  console.log(`repos.json: ${repos.repos ? `${repos.repos.repos.length} candidates` : "invalid"}`);
  return all.length === 0 ? 0 : 1;
}

const MINE_USAGE = [
  "Usage: pnpm eval mine szz --repo owner/name [--repo ...] [--limit N] [--max-pages N]",
  "       pnpm eval mine inject --repo owner/name [--repo ...] --count N   (count per repo)",
].join("\n");

async function mineInjectCmd(rest: string[]): Promise<number> {
  const { values } = parseArgs({ args: rest, options: { repo: { type: "string", multiple: true }, count: { type: "string", default: "5" } } });
  const count = Number(values.count);
  if (!values.repo?.length || !Number.isInteger(count) || count < 1) {
    console.error(MINE_USAGE);
    return 2;
  }
  let code = 0;
  for (const repo of values.repo) {
    console.log(`== inject ${repo} (count ${count})`);
    try {
      const r = await mineInject({ repo, count, log: (m) => console.log(m) });
      console.log(`${repo}: ${r.created} created (${r.crossFile} cross-file), ${r.existing} pre-existing, scanned ${r.scanned} PR commits` + (r.shortfall ? `; SHORTFALL ${r.shortfall}` : ""));
      if (r.shortfall) code = 1;
    } catch (e) {
      console.error(`${repo}: ${e instanceof Error ? e.message : String(e)}`);
      code = 1;
    }
  }
  return code;
}

async function mineCleanCmd(rest: string[]): Promise<number> {
  const { values } = parseArgs({ args: rest, options: { repo: { type: "string", multiple: true }, count: { type: "string", default: "5" } } });
  const count = Number(values.count);
  if (!values.repo?.length || !Number.isInteger(count) || count < 1) {
    console.error(MINE_USAGE);
    return 2;
  }
  let code = 0;
  for (const repo of values.repo) {
    console.log(`== clean ${repo} (count ${count})`);
    try {
      const r = await mineClean({ repo, count, log: (m) => console.log(m) });
      console.log(`${repo}: ${r.created} created, ${r.existing} pre-existing, ${r.eligible} eligible PRs` + (r.shortfall ? `; SHORTFALL ${r.shortfall}` : ""));
      if (r.shortfall) code = 1;
    } catch (e) {
      console.error(`${repo}: ${e instanceof Error ? e.message : String(e)}`);
      code = 1;
    }
  }
  return code;
}

async function mine(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === "inject") return mineInjectCmd(rest);
  if (sub === "clean") return mineCleanCmd(rest);
  if (sub === "injection") {
    const r = await mineInjection((m) => console.log(m));
    console.log(`injection: ${r.created.length} cases written`);
    return 0;
  }
  if (sub !== "szz") {
    console.error(MINE_USAGE);
    return 2;
  }
  const { values } = parseArgs({
    args: rest,
    options: {
      repo: { type: "string", multiple: true },
      limit: { type: "string", default: "10" },
      "max-pages": { type: "string" },
    },
  });
  const limit = Number(values.limit);
  if (!values.repo?.length || !Number.isInteger(limit) || limit < 1) {
    console.error(MINE_USAGE);
    return 2;
  }
  let code = 0;
  for (const repo of values.repo) {
    console.log(`== ${repo} (limit ${limit})`);
    try {
      const r = await mineSzz({
        repo,
        limit,
        ...(values["max-pages"] ? { maxPages: Number(values["max-pages"]) } : {}),
        log: (m) => console.log(m),
      });
      console.log(
        `${repo}: ${r.total} candidates (${r.created} new); scanned ${r.scannedFixPrs} fix PRs; ` +
          `api cache ${r.apiCache.hits} hits / ${r.apiCache.misses} misses`,
      );
      const skipped = Object.entries(r.skipped).sort((a, b) => b[1] - a[1]);
      if (skipped.length) console.log("  skipped: " + skipped.map(([k, v]) => `${k} x${v}`).join("; "));
    } catch (e) {
      console.error(`${repo}: ${e instanceof Error ? e.message : String(e)}`);
      code = 1;
    }
  }
  return code;
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "validate":
      return validate();
    case "mine":
      return mine(rest);
    default:
      console.error(`Usage: pnpm eval validate\n(unknown command: ${cmd ?? "none"}; run/report/calibrate come in B14-B16)`);
      return 2;
  }
}

main().then((code) => process.exit(code));
