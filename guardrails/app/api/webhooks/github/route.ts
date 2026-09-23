import { after } from "next/server";
import { verifySignature } from "@/cloud/github";
import { reviewPullRequest } from "@/cloud/review-pr";

export const maxDuration = 300;

const ACTIONS = new Set(["opened", "synchronize", "reopened", "ready_for_review"]);

export async function POST(req: Request) {
  const body = await req.text();
  if (!verifySignature(body, req.headers.get("x-hub-signature-256"))) {
    return new Response("invalid signature", { status: 401 });
  }
  if (req.headers.get("x-github-event") !== "pull_request") {
    return new Response("ignored", { status: 202 });
  }

  const p = JSON.parse(body);
  if (!ACTIONS.has(p.action) || p.pull_request.draft) {
    return new Response("ignored", { status: 202 });
  }

  after(() =>
    reviewPullRequest({
      installationId: p.installation.id,
      owner: p.repository.owner.login,
      repo: p.repository.name,
      number: p.pull_request.number,
      headSha: p.pull_request.head.sha,
    }).catch((err) => console.error("review failed", err)),
  );

  return new Response("accepted", { status: 202 });
}
