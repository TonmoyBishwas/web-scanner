'use client';

/**
 * Manager entry point for a split delivery — GET/POST/PATCH /api/split-plan
 * (Task 6) live behind this one URL, `/assign/{token}`, sent to whichever
 * manager chose "Split between workers" for the delivery.
 *
 * Two modes on one route, chosen purely by `session.status`:
 *   - 'planning' → SplitPlanner: set totals, tick a roster, optionally quota
 *     each worker, pin or pool the loose boxes, Send.
 *   - anything else ('active' | 'completed') → SplitBoard: live per-pallet
 *     status, Release/Reassign, a roster editor.
 *
 * Unlike a worker's /pallet-verify/{token}?w={chat_id} link, the manager's
 * link carries no identity query param — see SplitBoard's top comment for
 * why that matters for who Release/Reassign act as.
 */

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import SplitPlanner from '@/components/terminal/SplitPlanner';
import SplitBoard from '@/components/terminal/SplitBoard';
import { MI } from '@/components/terminal/MI';
import { useLangDir, useT, LanguageContext } from '@/lib/i18n';
import type { Language, MultiPalletSession } from '@/types';

type Phase = 'loading' | 'ready' | 'expired' | 'error';

function LoadingScreen() {
  const tr = useT();
  return (
    <div className="h-dvh flex items-center justify-center bg-canvas">
      <div className="text-center">
        <div className="animate-spin rounded-full h-10 w-10 border-4 border-line border-t-brand mx-auto mb-4" />
        <p className="text-[13px] font-semibold text-ink-muted">{tr('common.loading')}</p>
      </div>
    </div>
  );
}

function ExpiredScreen() {
  const tr = useT();
  return (
    <div className="h-dvh flex flex-col items-center justify-center gap-3 bg-canvas text-center px-6">
      <MI name="schedule" size={34} className="text-ink-muted" />
      <div className="text-[14px] font-extrabold text-ink-inverse">{tr('split.page.expiredTitle')}</div>
      <div className="text-[12px] font-semibold text-ink-muted">{tr('split.page.expiredBody')}</div>
    </div>
  );
}

function ErrorScreen({ onRetry }: { onRetry: () => void }) {
  const tr = useT();
  return (
    <div className="h-dvh flex flex-col items-center justify-center gap-3 bg-canvas text-center px-6">
      <MI name="error" size={34} className="text-ink-muted" />
      <div className="text-[13px] font-semibold text-ink-muted">{tr('split.page.errorBody')}</div>
      <button
        onClick={onRetry}
        className="mt-1 px-4 py-2 rounded-[11px] border border-line bg-tile text-[12px] font-extrabold text-ink-inverse tap-target"
      >
        {tr('common.retry')}
      </button>
    </div>
  );
}

function AssignContent({ session, onSent }: { session: MultiPalletSession; onSent: () => void }) {
  return session.status === 'planning' ? (
    <SplitPlanner session={session} onSent={onSent} />
  ) : (
    <SplitBoard session={session} />
  );
}

export default function AssignPage() {
  const params = useParams();
  const token = params.token as string;

  const [session, setSession] = useState<MultiPalletSession | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  // Bumped by the retry button and by a child's onSent — included in the
  // fetch effect's dependency array so either one re-runs the load without
  // exposing the loader itself as a stable callback (see the comment below).
  const [reloadKey, setReloadKey] = useState(0);

  const language = (session?.language as Language) || 'English';
  useLangDir(language);

  // Data fetch keyed by token + reloadKey, following the same shape as
  // app/complete/[token]/page.tsx: the async function is declared AND called
  // inside the effect body (not hoisted out via useCallback) — a `cancelled`
  // guard replaces that file's simpler "last write wins" because this effect
  // can re-run on demand (retry / onSent), not just once per token.
  useEffect(() => {
    let cancelled = false;
    async function run() {
      try {
        const res = await fetch(`/api/split-plan?token=${encodeURIComponent(token)}`);
        if (cancelled) return;
        if (res.status === 404) {
          setPhase('expired');
          return;
        }
        if (!res.ok) {
          setPhase('error');
          return;
        }
        const data = (await res.json()) as MultiPalletSession;
        if (cancelled) return;
        setSession(data);
        setPhase('ready');
      } catch {
        if (!cancelled) setPhase('error');
      }
    }
    run();
    return () => {
      cancelled = true;
    };
  }, [token, reloadKey]);

  const reload = () => setReloadKey((k) => k + 1);

  return (
    <LanguageContext.Provider value={language}>
      {phase === 'loading' && <LoadingScreen />}
      {phase === 'expired' && <ExpiredScreen />}
      {phase === 'error' && <ErrorScreen onRetry={reload} />}
      {phase === 'ready' && session && <AssignContent session={session} onSent={reload} />}
    </LanguageContext.Provider>
  );
}
