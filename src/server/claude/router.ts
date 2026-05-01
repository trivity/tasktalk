const FRESH_THRESHOLD_MS = 5 * 60 * 1000;

export type RouteDecision = 'snapshot' | 'live' | 'live-first-run';

export function decideRoute(opts: { lastSyncAt: Date | null; mirrorEmpty: boolean }): RouteDecision {
  if (opts.mirrorEmpty || !opts.lastSyncAt) return 'live-first-run';
  const age = Date.now() - opts.lastSyncAt.getTime();
  return age <= FRESH_THRESHOLD_MS ? 'snapshot' : 'live';
}
