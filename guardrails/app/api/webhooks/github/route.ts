import { after } from "next/server";
import { verifySignature } from "@/cloud/github";
import { loadTriggersFromBase, reportReviewFailure, reviewPullRequest } from "@/cloud/review-pr";
import { DeliveryDedupe, handleWebhook, type WebhookDeps } from "@/cloud/webhook";

export const maxDuration = 300;

// Module scope: survives between requests on a warm instance (best-effort dedupe, see DeliveryDedupe).
const dedupe = new DeliveryDedupe();

const deps: WebhookDeps = {
  verifySignature,
  schedule: (fn) => after(fn),
  loadTriggers: loadTriggersFromBase,
  review: reviewPullRequest,
  reportFailure: reportReviewFailure,
  dedupe,
  ownAppId: process.env.GITHUB_APP_ID,
};

export async function POST(req: Request) {
  return handleWebhook(req, deps);
}
