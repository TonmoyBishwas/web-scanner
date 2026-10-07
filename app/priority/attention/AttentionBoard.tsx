'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { MI } from '@/components/terminal/MI';
import {
  canMarkFound,
  canSendAgain,
  errorClassText,
  fixLineText,
  formatIsraelTime,
  parseDocno,
  problemInfo,
  type AttentionRow,
  type FixDelivery,
} from '@/lib/priority-attention';

/** The signed link, passed back on every API call. */
interface Link {
  u: string;
  exp: string;
  sig: string;
}

type Load =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; rows: AttentionRow[]; truncated: boolean; fixes: FixDelivery[]; at: Date };

type Tone = 'danger' | 'warn' | 'muted';

const TONE_CLASS: Record<Tone, string> = {
  danger: 'bg-danger-weak border-danger/30 text-danger-weak-ink',
  warn: 'bg-warn-weak border-warn/30 text-warn-weak-ink',
  muted: 'bg-sunken border-line text-ink-muted',
};

const PROBLEM_TONE: Record<string, Tone> = {
  failed: 'danger',
  unconfirmed: 'warn',
  no_writeback: 'warn',
  not_queued: 'warn',
  bot_unreachable: 'warn',
  orphan_class3: 'warn',
};

/**
 * The needs-attention list. English UI; Hebrew data (supplier names, Priority
 * errors) is shown as is with dir="auto", and Priority's Hebrew error text is
 * glossed in English (lib/priority-attention.ts).
 */
export function AttentionBoard() {
  const params = useSearchParams();
  const link = useMemo<Link>(
    () => ({ u: params.get('u') ?? '', exp: params.get('exp') ?? '', sig: params.get('sig') ?? '' }),
    [params],
  );
  const hasLink = Boolean(link.u && link.exp && link.sig);

  const [load, setLoad] = useState<Load>(() =>
    hasLink ? { kind: 'loading' } : { kind: 'error', message: 'Open this page from the link in the WhatsApp alert.' },
  );
  const [banner, setBanner] = useState<string | null>(null);
  /** Bumped by Refresh and after an action; the effect below re-reads the list. */
  const [reloads, setReloads] = useState(0);
  const refresh = useCallback(() => setReloads((n) => n + 1), []);

  useEffect(() => {
    if (!hasLink) return;
    let cancelled = false;
    (async () => {
      try {
        const q = new URLSearchParams({ u: link.u, exp: link.exp, sig: link.sig });
        const res = await fetch(`/api/priority/attention?${q.toString()}`, { cache: 'no-store' });
        const data = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok || !data?.success) {
          setLoad({ kind: 'error', message: data?.error || 'Could not load the list. Refresh the page.' });
          return;
        }
        setLoad({
          kind: 'ready',
          rows: data.rows as AttentionRow[],
          truncated: data.truncated === true,
          fixes: Array.isArray(data.fixes) ? (data.fixes as FixDelivery[]) : [],
          at: new Date(),
        });
      } catch {
        if (!cancelled) setLoad({ kind: 'error', message: 'No connection. Refresh the page.' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hasLink, link, reloads]);

  const onDone = useCallback(
    (message: string) => {
      setBanner(message);
      refresh();
    },
    [refresh],
  );

  return (
    <div className="min-h-screen bg-canvas text-ink">
      <div className="max-w-2xl mx-auto px-4 py-6 space-y-4">
        <header className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-extrabold">Priority — needs attention</h1>
            <p className="text-sm text-ink-muted mt-1">
              Finished deliveries that are not in Priority and need a person. Nothing on this page sends by itself.
            </p>
          </div>
          {hasLink && (
            <button
              onClick={refresh}
              className="flex-none inline-flex items-center gap-1 bg-tile border border-line-strong rounded-xl px-3 py-2 text-sm font-bold text-ink hover:bg-hover transition"
            >
              <MI name="refresh" size={18} /> Refresh
            </button>
          )}
        </header>

        {banner && (
          <div className="flex items-start gap-2 bg-ok-weak border border-ok/30 text-ok-weak-ink rounded-[11px] px-3 py-[10px] text-sm font-semibold">
            <MI name="check_circle" size={18} className="flex-none mt-[1px]" />
            <span className="flex-1 min-w-0">{banner}</span>
            <button onClick={() => setBanner(null)} aria-label="Dismiss" className="flex-none">
              <MI name="close" size={18} />
            </button>
          </div>
        )}

        {load.kind === 'loading' && <p className="text-sm text-ink-muted">Loading…</p>}

        {load.kind === 'error' && (
          <div className={`border rounded-[11px] px-3 py-[10px] text-sm font-semibold ${TONE_CLASS.danger}`}>
            {load.message}
          </div>
        )}

        {load.kind === 'ready' && (
          <>
            <p className="text-xs text-ink-muted">
              {load.rows.length === 0
                ? 'Nothing needs attention. Every finished delivery is in Priority or on its way.'
                : `${load.rows.length} to look at`}
              {' · updated '}
              {formatIsraelTime(load.at.toISOString())}
              {load.truncated && ' · showing the newest 200 only — tell Tonmoy'}
            </p>
            {load.rows.map((row, i) => (
              <AttentionCard
                key={`${row.problem}:${row.outbox_id ?? row.delivery_id ?? i}`}
                row={row}
                link={link}
                onDone={onDone}
              />
            ))}
            {load.fixes.length > 0 && (
              <section className="space-y-3 pt-2">
                <h2 className="text-base font-extrabold">In Priority — lines to check there (last 7 days)</h2>
                <p className="text-xs text-ink-muted">
                  Lines of finished deliveries that need a look in the Priority draft: short or over, not counted,
                  a unit risk, or an item not linked to a Priority item. Fix them in Priority before confirming the
                  draft. Nothing here sends anything.
                </p>
                {load.fixes.map((fix) => (
                  <FixCard key={fix.delivery_id} fix={fix} />
                ))}
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** One delivery's lines to check in Priority (read-only). */
function FixCard({ fix }: { fix: FixDelivery }) {
  return (
    <div className="bg-raised border border-line rounded-[14px] p-4 space-y-2">
      <div className="font-extrabold text-ink">
        Note <span dir="ltr" className="font-mono">{fix.document_number || '—'}</span>
        {fix.supplier && (
          <>
            {' · '}
            <span dir="auto">{fix.supplier}</span>
          </>
        )}
      </div>
      <div className="text-xs text-ink-muted">
        {fix.gr_docno ? `Priority draft ${fix.gr_docno}` : 'No Priority draft linked yet'}
        {` · opened ${formatIsraelTime(fix.created_at)}`}
      </div>
      <ul className="space-y-1">
        {fix.lines.map((line, i) => (
          <li key={`${line.code ?? 'line'}:${i}`} className="text-sm text-ink-body">
            {fixLineText(line)}
          </li>
        ))}
      </ul>
    </div>
  );
}

function AttentionCard({ row, link, onDone }: { row: AttentionRow; link: Link; onDone: (message: string) => void }) {
  const info = problemInfo(row.problem);
  const tone = PROBLEM_TONE[row.problem] ?? 'muted';
  const gloss = errorClassText(row.error_class);
  const note = row.document_number || '—';

  const [panel, setPanel] = useState<'none' | 'resend' | 'found'>('none');
  const [priorityChecked, setPriorityChecked] = useState(false);
  const [makeChecked, setMakeChecked] = useState(false);
  // Prefilled when Priority already has a GR for the delivery (the view's gr_docno).
  const [docno, setDocno] = useState(row.gr_docno ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = (next: 'resend' | 'found') => {
    setPanel((p) => (p === next ? 'none' : next));
    setError(null);
  };

  async function send(path: string, extra: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...link, outbox_id: row.outbox_id, ...extra }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        setError((data?.error as string) || 'Not done. Refresh the list and look again.');
        return null;
      }
      return data as Record<string, unknown>;
    } catch {
      setError('No connection — nothing was changed.');
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function sendAgain() {
    const data = await send('/api/priority/resend', { priority_checked: priorityChecked, make_checked: makeChecked });
    if (!data) return;
    const attempt = typeof data.attempt === 'number' ? ` (send #${data.attempt})` : '';
    onDone(
      `Note ${note} is queued again${attempt}. It goes out within about 15 seconds; if Priority refuses it again, a new alert comes.`,
    );
  }

  async function markFound() {
    const clean = parseDocno(docno);
    if (!clean) return;
    const data = await send('/api/priority/mark-found', { docno: clean });
    if (!data) return;
    onDone(`Note ${note} is recorded as found in Priority (${clean}). Nothing was sent.`);
  }

  return (
    <div className="bg-raised border border-line rounded-[14px] p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-extrabold text-ink">
            Note <span dir="ltr" className="font-mono">{note}</span>
            {row.supplier && (
              <>
                {' · '}
                <span dir="auto">{row.supplier}</span>
              </>
            )}
          </div>
          <div className="text-xs text-ink-muted mt-[2px]">
            {row.category === 'non_meat' ? 'Non-meat' : row.category === 'meat' ? 'Meat' : row.category || '—'}
            {row.outbox_id != null && ` · outbox #${row.outbox_id}`}
            {row.target === 'test' && ' · TEST (fake Make)'}
            {row.outbox_status && ` · status ${row.outbox_status}`}
            {row.status_code != null && ` · HTTP ${row.status_code}`}
            {` · sent ${formatIsraelTime(row.sent_at)}`}
            {row.receiver_chat_id != null && ` · received by ${row.receiver_chat_id}`}
          </div>
        </div>
        <span className={`flex-none border rounded-full px-2 py-[2px] text-[11px] font-extrabold ${TONE_CLASS[tone]}`}>
          {info.title}
        </span>
      </div>

      {row.reason_text && (
        <p className="text-sm text-ink-body" dir="auto">
          {row.reason_text}
        </p>
      )}
      {gloss && <p className="text-sm text-ink-body">{gloss}</p>}
      <p className="text-sm text-ink-muted">
        <span className="font-bold text-ink">What to check: </span>
        {info.check}
      </p>

      {(canSendAgain(row) || canMarkFound(row)) && (
        <div className="flex flex-wrap gap-2">
          {canSendAgain(row) && (
            <button
              onClick={() => open('resend')}
              className="inline-flex items-center gap-1 bg-tile border border-line-strong rounded-xl px-3 py-2 text-sm font-bold text-ink hover:bg-hover transition"
            >
              <MI name="autorenew" size={16} /> Send again
            </button>
          )}
          {canMarkFound(row) && (
            <button
              onClick={() => open('found')}
              className="inline-flex items-center gap-1 bg-tile border border-line-strong rounded-xl px-3 py-2 text-sm font-bold text-ink hover:bg-hover transition"
            >
              <MI name="task_alt" size={16} /> Mark as found
            </button>
          )}
        </div>
      )}

      {panel === 'resend' && (
        <div className="bg-sunken border border-line rounded-[11px] p-3 space-y-3">
          <p className="text-sm font-bold text-ink">Before sending again, both of these:</p>
          <label className="flex items-start gap-2 text-sm text-ink-body">
            <input
              type="checkbox"
              className="mt-1"
              checked={priorityChecked}
              onChange={(e) => setPriorityChecked(e.target.checked)}
            />
            <span>
              I searched Priority for BOOKNUM <span dir="ltr" className="font-mono font-bold">{note}</span> in any
              status, including draft (טיוטא), and it is not there.
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm text-ink-body">
            <input type="checkbox" className="mt-1" checked={makeChecked} onChange={(e) => setMakeChecked(e.target.checked)} />
            <span>I checked the Make history for this note.</span>
          </label>
          <div className="flex gap-2">
            <button
              onClick={() => void sendAgain()}
              disabled={!priorityChecked || !makeChecked || busy}
              className="bg-brand text-ink-inverse rounded-xl px-4 py-2 text-sm font-extrabold hover:bg-brand-hover transition disabled:opacity-40"
            >
              {busy ? 'Sending…' : 'Send again'}
            </button>
            <button onClick={() => setPanel('none')} className="px-3 py-2 text-sm font-bold text-ink-muted">
              Cancel
            </button>
          </div>
        </div>
      )}

      {panel === 'found' && (
        <div className="bg-sunken border border-line rounded-[11px] p-3 space-y-3">
          <label className="block text-sm text-ink-body">
            <span className="font-bold text-ink">The Priority document number of the draft you found</span>
            <input
              value={docno}
              onChange={(e) => setDocno(e.target.value)}
              placeholder="GR26000049"
              dir="ltr"
              autoCapitalize="characters"
              className="mt-1 w-full bg-canvas border border-line-strong rounded-xl px-3 py-2 font-mono text-ink"
            />
          </label>
          <div className="flex gap-2">
            <button
              onClick={() => void markFound()}
              disabled={!parseDocno(docno) || busy}
              className="bg-brand text-ink-inverse rounded-xl px-4 py-2 text-sm font-extrabold hover:bg-brand-hover transition disabled:opacity-40"
            >
              {busy ? 'Saving…' : 'Mark as found'}
            </button>
            <button onClick={() => setPanel('none')} className="px-3 py-2 text-sm font-bold text-ink-muted">
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className={`border rounded-[11px] px-3 py-[10px] text-sm font-semibold ${TONE_CLASS.danger}`}>{error}</div>
      )}
    </div>
  );
}
