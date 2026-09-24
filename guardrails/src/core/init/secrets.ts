import path from "node:path";

/**
 * Files whose CONTENT must never be read or sent to a model (PLAN-DETAILED §8).
 * Matching is by basename/segment, case-insensitive. Their names are not listed either.
 */
const SECRET_BASENAME = [
  /^\.env(\..*)?$/i, // .env, .env.local, .env.production, .env.example (all excluded: simplest and safest)
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk|asc|gpg)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^\.(npmrc|netrc|pypirc|git-credentials|htpasswd)$/i,
  /^credentials(\..*)?$/i,
  /^secrets?(\..*)?$/i,
  /^service-account.*\.json$/i,
  /\.tfvars$/i,
  /^terraform\.tfstate(\..*)?$/i,
];
const SECRET_DIRS = new Set([".ssh", ".aws", ".gnupg", ".kube"]);

export function isSecretPath(p: string): boolean {
  const norm = p.replaceAll("\\", "/");
  const segments = norm.split("/");
  if (segments.some((s) => SECRET_DIRS.has(s.toLowerCase()))) return true;
  const base = path.posix.basename(norm);
  return SECRET_BASENAME.some((re) => re.test(base));
}

const REDACTIONS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[REDACTED PRIVATE KEY]"],
  [/\b(sk|pk|rk)-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, "[REDACTED]"],
  [/\bgithub_pat_[A-Za-z0-9_]{30,}\b/g, "[REDACTED]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED]"],
  // NAME=value assignments for names that look like secrets
  [/\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY)[A-Z0-9_]*)\s*[=:]\s*["']?[^\s"'`]{8,}/g, "$1=[REDACTED]"],
];

/** Defense in depth: strips secret-looking strings that slipped into docs or configs. */
export function redactSecrets(text: string): string {
  return REDACTIONS.reduce((acc, [re, rep]) => acc.replace(re, rep), text);
}
