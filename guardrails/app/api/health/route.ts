// Liveness probe: 200 and nothing else. Never reports configuration, versions or which secrets are set.
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ status: "ok" }, { headers: { "cache-control": "no-store" } });
}
