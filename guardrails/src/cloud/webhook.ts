import { createHash } from "node:crypto";
import { LABEL_ACTIONS, MODE_LABEL_PREFIX, REVIEW_ACTIONS, SUBSCRIBED_EVENTS } from "./app-permissions";
import { log } from "./log";

export interface Triggers {
  drafts: boolean;
  forks: boolean;
  skipLabels: string[];
}

export interface PullRequestEvent {
  installationId: number;
  owner: string;
  repo: string;
  number: number;
  headSha: string;
  baseSha: string;
  action: string;
  draft: boolean;
  isFork: boolean;
  labels: string[];
  /** Name of the label that was added or removed (`labeled` / `unlabeled` actions). */
  label?: string | undefined;
  senderLogin: string;
  senderType: string;
  /** Id of the GitHub App that performed the action, when it was an app (used to ignore our own events). */
  performedByAppId?: number | undefined;
}

// ---------------------------------------------------------------------------------------------
// Best-effort dedupe of webhook deliveries.
//
// In memory, per server instance, with a TTL: a redelivery that lands on the same warm instance is
// dropped, one that lands on a cold or different instance is not. The durable version
// (`webhook_deliveries` table, unique on the delivery id) arrives with the database (backlog B19).
// ---------------------------------------------------------------------------------------------
export class DeliveryDedupe {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly ttlMs = 60 * 60 * 1000,
    private readonly maxEntries = 5_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns true the first time an id is seen inside the TTL window, false for repeats. */
  firstSeen(id: string): boolean {
    const t = this.now();
    const prev = this.seen.get(id);
    if (prev !== undefined && t - prev < this.ttlMs) return false;
    this.seen.delete(id);
    this.seen.set(id, t);
    this.evict(t);
    return true;
  }

  private evict(t: number): void {
    // Map keeps insertion order, so the oldest entries come first.
    for (const [id, at] of this.seen) {
      if (this.seen.size <= this.maxEntries && t - at < this.ttlMs) break;
      this.seen.delete(id);
    }
  }
}

const isRecord = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null;

/** Extracts what the handler needs from a `pull_request` payload; `null` if the shape is not usable. */
export function parsePullRequestEvent(p: unknown): PullRequestEvent | null {
  if (!isRecord(p) || !isRecord(p.pull_request) || !isRecord(p.repository) || !isRecord(p.installation)) return null;
  const pr = p.pull_request;
  const repo = p.repository;
  const owner = repo.owner?.login;
  if (
    typeof p.action !== "string" ||
    typeof owner !== "string" ||
    typeof repo.name !== "string" ||
    typeof pr.number !== "number" ||
    typeof pr.head?.sha !== "string" ||
    typeof pr.base?.sha !== "string" ||
    typeof p.installation.id !== "number"
  ) {
    return null;
  }
  const headRepo = pr.head.repo;
  return {
    installationId: p.installation.id,
    owner,
    repo: repo.name,
    number: pr.number,
    headSha: pr.head.sha,
    baseSha: pr.base.sha,
    action: p.action,
    draft: pr.draft === true,
    isFork: !headRepo || headRepo.full_name !== repo.full_name,
    labels: Array.isArray(pr.labels) ? pr.labels.map((l: any) => l?.name).filter((n: unknown): n is string => typeof n === "string") : [],
    label: typeof p.label?.name === "string" ? p.label.name : undefined,
    senderLogin: typeof p.sender?.login === "string" ? p.sender.login : "",
    senderType: typeof p.sender?.type === "string" ? p.sender.type : "",
    performedByAppId: typeof p.performed_via_github_app?.id === "number" ? p.performed_via_github_app.id : undefined,
  };
}

/** Bots (dependabot, renovate, ...) and this App itself never trigger a review. */
export function isBotEvent(ev: PullRequestEvent, ownAppId?: string): boolean {
  if (ev.senderType === "Bot" || ev.senderLogin.endsWith("[bot]")) return true;
  return ownAppId !== undefined && ev.performedByAppId !== undefined && String(ev.performedByAppId) === ownAppId;
}

export type TriggerDecision = { review: true } | { review: false; reason: "draft" | "fork" | "skip-label" };

/** Applies `config.triggers` (read from the BASE commit) to an event. Pure. */
export function evaluateTriggers(ev: Pick<PullRequestEvent, "draft" | "isFork" | "labels">, triggers: Triggers): TriggerDecision {
  if (ev.draft && !triggers.drafts) return { review: false, reason: "draft" };
  if (ev.isFork && !triggers.forks) return { review: false, reason: "fork" };
  if (ev.labels.some((l) => triggers.skipLabels.includes(l))) return { review: false, reason: "skip-label" };
  return { review: true };
}

export interface WebhookDeps {
  verifySignature(body: string, signature: string | null): boolean;
  /** Runs work after the response has been sent (Next.js `after`). */
  schedule(fn: () => Promise<unknown>): void;
  /** `config.triggers` from the PR's base commit. */
  loadTriggers(ev: PullRequestEvent): Promise<Triggers>;
  review(ev: PullRequestEvent): Promise<void>;
  /** Tells the PR (briefly, without internal details) that the review could not complete. */
  reportFailure(ev: PullRequestEvent, err: unknown): Promise<void>;
  dedupe: DeliveryDedupe;
  ownAppId?: string | undefined;
}

const accepted = () => new Response("accepted", { status: 202 });
const ignored = (why: string) => new Response(`ignored: ${why}`, { status: 202 });

/** Short, stable id for logs (the delivery id is not secret, but keep log lines compact). */
const shortId = (s: string | null) => (s ? createHash("sha256").update(s).digest("hex").slice(0, 8) : "none");

/**
 * Webhook entry point. Answers 202 as soon as the request is validated and queued; the review runs
 * afterwards through `deps.schedule`.
 */
export async function handleWebhook(req: Request, deps: WebhookDeps): Promise<Response> {
  const body = await req.text();
  if (!deps.verifySignature(body, req.headers.get("x-hub-signature-256"))) {
    log("webhook.rejected", { reason: "bad-signature" });
    return new Response("invalid signature", { status: 401 });
  }

  const event = req.headers.get("x-github-event") ?? "";
  const delivery = req.headers.get("x-github-delivery");
  const base = { delivery: shortId(delivery), event };

  if (!(SUBSCRIBED_EVENTS as readonly string[]).includes(event)) {
    log("webhook.ignored", { ...base, reason: "unsupported-event" });
    return ignored("unsupported event");
  }
  if (delivery && !deps.dedupe.firstSeen(delivery)) {
    log("webhook.ignored", { ...base, reason: "duplicate-delivery" });
    return ignored("duplicate delivery");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return new Response("invalid json", { status: 400 });
  }
  const ev = parsePullRequestEvent(payload);
  if (!ev) {
    log("webhook.ignored", { ...base, reason: "unusable-payload" });
    return ignored("unusable payload");
  }
  const at = { ...base, repo: `${ev.owner}/${ev.repo}`, pr: ev.number, action: ev.action };
  if ((LABEL_ACTIONS as readonly string[]).includes(ev.action)) {
    // Only a change of a `guardrails:*` label (the review mode) re-runs the review; any other label is noise.
    if (!ev.label?.toLowerCase().startsWith(MODE_LABEL_PREFIX)) {
      log("webhook.ignored", { ...at, reason: "label" });
      return ignored("label");
    }
  } else if (!(REVIEW_ACTIONS as readonly string[]).includes(ev.action)) {
    log("webhook.ignored", { ...at, reason: "action" });
    return ignored("action");
  }
  if (isBotEvent(ev, deps.ownAppId)) {
    log("webhook.ignored", { ...at, reason: "bot" });
    return ignored("bot");
  }

  deps.schedule(async () => {
    const started = Date.now();
    try {
      // Triggers come from the base commit's config, so the decision needs one API call: it runs here, after the 202.
      const decision = evaluateTriggers(ev, await deps.loadTriggers(ev));
      if (!decision.review) {
        log("review.skipped", { ...at, reason: decision.reason });
        return;
      }
      log("review.started", at);
      await deps.review(ev);
      log("review.finished", { ...at, ms: Date.now() - started });
    } catch (err) {
      log("review.failed", { ...at, ms: Date.now() - started, kind: err instanceof Error ? err.name : "unknown" });
      try {
        await deps.reportFailure(ev, err);
      } catch {
        log("review.report-failed", at);
      }
    }
  });
  return accepted();
}
