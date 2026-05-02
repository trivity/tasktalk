import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/rpc.js';

type Phase = 'welcome' | 'connect' | 'estimate' | 'syncing' | 'done';

export function Onboarding() {
  const [phase, setPhase] = useState<Phase>('welcome');
  const [estimate, setEstimate] = useState<{ approxTaskCount: number; listCount: number } | null>(null);
  const [progress, setProgress] = useState<{
    status: string;
    syncState?: { phase?: string; listsDone?: number; listsTotal?: number };
  } | null>(null);
  const nav = useNavigate();

  useEffect(() => {
    api.clickupStatus().then((r) => { if (r.connected) setPhase('estimate'); }).catch(() => {});
  }, []);

  useEffect(() => {
    if (phase !== 'estimate') return;
    api.estimateWorkspace().then((e) => { setEstimate(e); setPhase('syncing'); }).catch(() => {});
  }, [phase]);

  useEffect(() => {
    if (phase !== 'syncing') return;
    const t = setInterval(async () => {
      const p = await api.syncProgress();
      setProgress(p);
      if (p.status === 'done') { setPhase('done'); clearInterval(t); }
    }, 2000);
    return () => clearInterval(t);
  }, [phase]);

  const needsAddOn = estimate ? estimate.approxTaskCount > 250 : false;

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-bg text-text">
      <div className="bg-surface rounded-lg p-10 w-[540px] shadow-lg shadow-black/5">
        {phase === 'welcome' && (
          <>
            <h1 className="text-[24px] font-semibold mb-2 leading-tight">Welcome to Tasktalk</h1>
            <p className="text-text-muted text-sm mb-8">
              Talk to your ClickUp workspace through Claude. We'll connect your account, index your data, and get you a working chat in a few minutes.
            </p>
            <button
              onClick={() => setPhase('connect')}
              className="bg-accent hover:bg-accent-hover text-white rounded-md px-4 py-2 font-medium transition-colors duration-150"
            >
              Get started →
            </button>
          </>
        )}
        {phase === 'connect' && (
          <>
            <h1 className="text-[24px] font-semibold mb-2 leading-tight">Connect ClickUp</h1>
            <p className="text-text-muted text-sm mb-8">
              You'll be sent to ClickUp to authorize Tasktalk. We only request the scopes needed to read tasks and comment on your behalf.
            </p>
            <a
              href="/api/clickup/connect"
              className="bg-accent hover:bg-accent-hover text-white rounded-md px-4 py-2 font-medium inline-block transition-colors duration-150"
            >
              Connect ClickUp
            </a>
          </>
        )}
        {phase === 'estimate' && (
          <>
            <h1 className="text-[24px] font-semibold mb-2 leading-tight">Estimating workspace size…</h1>
            <p className="text-text-muted text-sm">This takes about 30 seconds.</p>
          </>
        )}
        {phase === 'syncing' && (
          <>
            <h1 className="text-[24px] font-semibold mb-2 leading-tight">Indexing your workspace</h1>
            {estimate && (
              <p className="text-text-muted text-sm mb-3">
                ~{estimate.approxTaskCount.toLocaleString()} tasks across {estimate.listCount} lists.
                {needsAddOn && (
                  <span className="block mt-2 text-warning">
                    ⚠️ Heads up: that's larger than ClickUp's default 300 calls/day rate limit can index in one shot. Consider enabling the "Everything AI" add-on, or we'll pace this across multiple days.
                  </span>
                )}
              </p>
            )}
            {progress?.syncState && (
              <div className="mt-4">
                <div className="text-xs text-text-muted mb-2">Phase: {progress.syncState.phase ?? '…'}</div>
                {typeof progress.syncState.listsTotal === 'number' && (
                  <div className="w-full bg-bg rounded h-2 overflow-hidden">
                    <div
                      className="bg-accent h-2 transition-all"
                      style={{ width: `${Math.round(((progress.syncState.listsDone ?? 0) / Math.max(1, progress.syncState.listsTotal)) * 100)}%` }}
                    />
                  </div>
                )}
              </div>
            )}
          </>
        )}
        {phase === 'done' && (
          <>
            <h1 className="text-[24px] font-semibold mb-2 leading-tight">You're ready 🎉</h1>
            <p className="text-text-muted text-sm mb-8">Try a sample question to get a feel for it.</p>
            <button
              onClick={() => nav('/chat')}
              className="bg-accent hover:bg-accent-hover text-white rounded-md px-4 py-2 font-medium transition-colors duration-150"
            >
              Open chat
            </button>
          </>
        )}
      </div>
    </div>
  );
}
