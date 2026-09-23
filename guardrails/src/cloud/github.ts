import { App } from "octokit";
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifySignature(body: string, signature: string | null): boolean {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret || !signature) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

let app: App | undefined;

/** Octokit authenticated as the installation (short-lived token, scoped to that repo owner). */
export async function installationOctokit(installationId: number) {
  app ??= new App({
    appId: process.env.GITHUB_APP_ID!,
    privateKey: process.env.GITHUB_APP_PRIVATE_KEY!.replace(/\\n/g, "\n"),
  });
  return app.getInstallationOctokit(installationId);
}

export type Octo = Awaited<ReturnType<typeof installationOctokit>>;
