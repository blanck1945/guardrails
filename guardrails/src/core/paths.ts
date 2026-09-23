import picomatch from "picomatch";

/**
 * Path-based defaults from PLAN-DETAILED §3.3. Content-based rules (`@generated` header,
 * binaries, >500 KB) need file contents and are not handled here.
 */
export const DEFAULT_IGNORES: readonly string[] = [
  // lockfiles
  "**/pnpm-lock.yaml",
  "**/package-lock.json",
  "**/yarn.lock",
  "**/bun.lock",
  "**/bun.lockb",
  "**/poetry.lock",
  "**/Pipfile.lock",
  "**/uv.lock",
  "**/Cargo.lock",
  "**/composer.lock",
  "**/Gemfile.lock",
  "**/go.sum",
  // build output and vendored code
  "**/dist/**",
  "**/build/**",
  "**/vendor/**",
  // minified, maps, snapshots
  "**/*.min.*",
  "**/*.map",
  "**/__snapshots__/**",
  "**/*.snap",
];

function normalize(p: string): string {
  return p.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

/**
 * True if `path` matches any glob. Supports `**`, `?`, `{a,b}`; dotfiles match.
 * Patterns without a slash (e.g. `*.log`) match against the basename at any depth.
 */
export function isIgnored(path: string, patterns: readonly string[] = DEFAULT_IGNORES): boolean {
  if (!patterns.length) return false;
  const p = normalize(path);
  return patterns.some((pat) => picomatch(pat.replace(/^\.\//, ""), { dot: true, basename: !pat.includes("/") })(p));
}
