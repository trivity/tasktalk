// Mirror is the primary source of truth until webhooks are wired up reliably.
// Until then, prefer snapshot for any data within 24h. Override with TT_FRESH_MS env.
const FRESH_THRESHOLD_MS = Number(process.env.TT_FRESH_MS ?? 24 * 60 * 60 * 1000);

export type RouteDecision = 'snapshot' | 'live' | 'live-first-run';

export function decideRoute(opts: { lastSyncAt: Date | null; mirrorEmpty: boolean }): RouteDecision {
  if (opts.mirrorEmpty) return 'live-first-run';
  if (!opts.lastSyncAt) return 'snapshot';
  const age = Date.now() - opts.lastSyncAt.getTime();
  return age <= FRESH_THRESHOLD_MS ? 'snapshot' : 'live';
}
