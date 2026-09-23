import { loadCases, loadRepos } from "./loader";

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

async function main(): Promise<number> {
  const [cmd] = process.argv.slice(2);
  switch (cmd) {
    case "validate":
      return validate();
    default:
      console.error(`Usage: pnpm eval validate\n(unknown command: ${cmd ?? "none"}; run/report/calibrate come in B14-B16)`);
      return 2;
  }
}

main().then((code) => process.exit(code));
