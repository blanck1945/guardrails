/**
 * `guardrails hook install|uninstall`: manages a git `pre-push` hook that runs `guardrails review`
 * on what is about to be pushed.
 *
 * Policy: the hook blocks a push ONLY when the review reports findings at or above the threshold.
 * Any other failure (no API key, network, budget, crash) prints a warning and lets the push through.
 * `GUARDRAILS_SKIP=1 git push` skips it entirely.
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

export const HOOK_MARKER = "# guardrails-hook v1";
const PREV_SUFFIX = ".pre-guardrails";
/** Exit code the hook asks `guardrails review` to use for "findings" (a crash exits 1, findings must not). */
export const HOOK_BLOCK_EXIT = 42;

export interface HookResult {
  status: "installed" | "updated" | "chained" | "uninstalled" | "restored" | "not-installed" | "refused";
  hookPath: string;
  message: string;
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, windowsHide: true }, (err, stdout) => {
      if (err) reject(new Error(`not a git repository (or git is unavailable): ${cwd}`));
      else resolve(String(stdout).trim());
    });
  });
}

/** Path of the pre-push hook, honoring `core.hooksPath` and worktrees. */
export async function prePushPath(repo: string): Promise<string> {
  const p = await git(repo, ["rev-parse", "--git-path", "hooks/pre-push"]);
  return path.resolve(repo, p);
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** POSIX sh script. `toolDir` is the directory of the guardrails package (holds src/cli/guardrails.ts). */
export function buildHookScript(toolDir: string): string {
  const tool = toolDir.replace(/\\/g, "/");
  return `#!/bin/sh
${HOOK_MARKER}
# Managed by \`guardrails hook install\`. Remove with \`guardrails hook uninstall\`.
# Blocks a push only when the review finds issues at or above the threshold; every other failure lets it through.
# Skip once with: GUARDRAILS_SKIP=1 git push

[ "$GUARDRAILS_SKIP" = "1" ] && exit 0

STDIN=$(cat)

# A hook that existed before Guardrails was installed keeps running first.
PREV="$0${PREV_SUFFIX}"
if [ -x "$PREV" ]; then
  printf '%s\\n' "$STDIN" | "$PREV" "$@" || exit $?
fi

TOOL_DIR=${shq(tool)}
if [ ! -f "$TOOL_DIR/src/cli/guardrails.ts" ]; then
  echo "guardrails: CLI not found at $TOOL_DIR; push allowed" >&2
  exit 0
fi

ZERO=0000000000000000000000000000000000000000
REPO=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
BLOCK=0

while read -r local_ref local_sha remote_ref remote_sha; do
  [ -z "$local_sha" ] && continue
  [ "$local_sha" = "$ZERO" ] && continue # branch deletion
  if [ "$remote_sha" != "$ZERO" ] && git cat-file -e "$remote_sha^{commit}" 2>/dev/null; then
    set -- --base "$remote_sha"
  else
    set -- # new branch (or unknown remote commit): let review pick the default base
  fi
  ( cd "$TOOL_DIR" && GUARDRAILS_FINDINGS_EXIT=${HOOK_BLOCK_EXIT} node --import tsx src/cli/guardrails.ts review \\
      --path "$REPO" "$@" --head "$local_sha" --budget-usd "\${GUARDRAILS_BUDGET_USD:-0.50}" ) </dev/null
  code=$?
  case $code in
    0) ;;
    ${HOOK_BLOCK_EXIT}) BLOCK=1 ;;
    *) echo "guardrails: review could not run (exit $code); push allowed" >&2 ;;
  esac
done <<EOF
$STDIN
EOF

if [ "$BLOCK" = "1" ]; then
  echo "guardrails: push blocked by review findings. Fix them, or bypass once with: GUARDRAILS_SKIP=1 git push" >&2
  exit 1
fi
exit 0
`;
}

export async function installHook(repo: string, toolDir: string): Promise<HookResult> {
  const hookPath = await prePushPath(repo);
  await fs.mkdir(path.dirname(hookPath), { recursive: true });
  let existing: string | null = null;
  try {
    existing = await fs.readFile(hookPath, "utf8");
  } catch {
    /* none */
  }
  const script = buildHookScript(toolDir);
  let status: HookResult["status"] = "installed";
  let message = `Installed ${hookPath}`;
  if (existing !== null) {
    if (existing.includes(HOOK_MARKER)) {
      status = "updated";
      message = `Updated ${hookPath}`;
    } else {
      const prev = hookPath + PREV_SUFFIX;
      try {
        await fs.access(prev);
        return { status: "refused", hookPath, message: `Refusing to install: ${hookPath} is a foreign hook and ${prev} already exists. Resolve it manually.` };
      } catch {
        /* free */
      }
      await fs.rename(hookPath, prev);
      await fs.chmod(prev, 0o755);
      status = "chained";
      message = `Installed ${hookPath}; the existing hook was kept as ${path.basename(prev)} and still runs first.`;
    }
  }
  await fs.writeFile(hookPath, script, { mode: 0o755 });
  await fs.chmod(hookPath, 0o755);
  return { status, hookPath, message };
}

export async function uninstallHook(repo: string): Promise<HookResult> {
  const hookPath = await prePushPath(repo);
  let existing: string | null = null;
  try {
    existing = await fs.readFile(hookPath, "utf8");
  } catch {
    /* none */
  }
  if (existing === null || !existing.includes(HOOK_MARKER)) {
    return { status: "not-installed", hookPath, message: "The Guardrails pre-push hook is not installed." };
  }
  await fs.rm(hookPath);
  const prev = hookPath + PREV_SUFFIX;
  try {
    await fs.access(prev);
    await fs.rename(prev, hookPath);
    return { status: "restored", hookPath, message: `Removed the Guardrails hook and restored the previous ${path.basename(hookPath)}.` };
  } catch {
    return { status: "uninstalled", hookPath, message: `Removed ${hookPath}.` };
  }
}
