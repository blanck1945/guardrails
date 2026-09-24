/**
 * What the GitHub App must be granted for the code in `src/cloud` to work (PLAN-DETAILED section 8:
 * minimal permissions). `github-app/manifest.json` must declare exactly this; `app-manifest.test.ts`
 * checks both the manifest and the GitHub API namespaces the code actually calls.
 *
 * Not requested on purpose: `checks` (no Check Runs yet) and the events for feedback capture / commands
 * (`pull_request_review_comment`, `issue_comment`, ...): they arrive with those features.
 */
export const REQUIRED_PERMISSIONS = {
  metadata: "read",
  contents: "read", // read config, rules and files through the contents API
  pull_requests: "write", // read PRs and files; publish the review
} as const;

/** Webhook events the App subscribes to and the handler accepts. */
export const SUBSCRIBED_EVENTS = ["pull_request"] as const;

/**
 * `pull_request` actions `labeled` / `unlabeled` re-run the review ONLY when the label starts with `MODE_LABEL_PREFIX`
 * (the review mode changed). They arrive on the already subscribed `pull_request` event: no new event or permission.
 */
export const LABEL_ACTIONS = ["labeled", "unlabeled"] as const;
export const MODE_LABEL_PREFIX = "guardrails:";

/** `pull_request` actions that trigger a review. */
export const REVIEW_ACTIONS = ["opened", "synchronize", "reopened", "ready_for_review"] as const;
