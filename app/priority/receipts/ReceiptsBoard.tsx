'use client';

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useSearchParams } from 'next/navigation';
import { MI } from '@/components/terminal/MI';
import { LanguageContext, t, useLangDir, type TranslationKey } from '@/lib/i18n';
import type { Language } from '@/types';
import {
  countByState,
  filterReceipts,
  formatReceiptTime,
  type CategoryFilter,
  type ReceiptRow,
  type ReceiptState,
  type WindowFilter,
} from '@/lib/priority-receipts';

type Load =
  | { kind: 'loading' }
  | { kind: 'error'; key: TranslationKey }
  | { kind: 'ready'; rows: ReceiptRow[]; truncated: boolean; attentionLink: string | null; at: Date };

type Tr = (key: TranslationKey, vars?: Record<string, string | number>) => string;

const LANG_KEY = 'priority-receipts.lang';
const FILTER_KEY = 'priority-receipts.filters';

type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'brand' | 'muted';

const TONE_CLASS: Record<Tone, string> = {
  ok: 'bg-ok-weak border-ok/30 text-ok-weak-ink',
  warn: 'bg-warn-weak border-warn/30 text-warn-weak-ink',
  danger: 'bg-danger-weak border-danger/30 text-danger-weak-ink',
  info: 'bg-info-weak border-info/30 text-info-weak-ink',
  brand: 'bg-brand-weak border-brand/30 text-brand-weak-ink',
  muted: 'bg-sunken border-line text-ink-muted',
};

const STATE_TONE: Record<ReceiptState, Tone> = {
  done: 'ok',
  waiting: 'brand',
  receiving: 'muted',
  refused: 'danger',
  partial: 'info',
  unconfirmed: 'warn',
  not_sent: 'warn',
};

/** The coloured bar on the card's leading edge. */
const STATE_BAR: Record<ReceiptState, string> = {
  done: 'bg-ok',
  waiting: 'bg-brand',
  receiving: 'bg-line-strong',
  refused: 'bg-danger',
  partial: 'bg-info',
  unconfirmed: 'bg-warn',
  not_sent: 'bg-warn',
};

/** This tab's choices; also what is used when the browser blocks storage. */
const memory = new Map<string, string>();
const listeners = new Set<() => void>();

function readStored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  let v = memory.get(key) ?? null;
  if (v === null) {
    try {
      v = window.localStorage.getItem(key);
    } catch {
      v = null;
    }
  }
  return v && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

function store(key: string, value: string) {
  memory.set(key, value);
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private window / blocked storage: remembered for this tab only */
  }
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/**
 * A choice remembered per browser (language, filters). The server render and
 * the first client render use the fallback, so hydration always matches.
 */
function usePersisted<T extends string>(key: string, allowed: readonly T[], fallback: T): [T, (v: T) => void] {
  const value = useSyncExternalStore(
    subscribe,
    () => readStored(key, allowed, fallback),
    () => fallback,
  );
  const set = useCallback((v: T) => store(key, v), [key]);
  return [value, set];
}

const LANGS = ['Hebrew', 'English'] as const;
const WINDOWS = ['today', '3d', '14d'] as const;
const CATEGORIES = ['all', 'meat', 'non_meat'] as const;

/**
 * The owner's receipts board. Hebrew (RTL) by default with an English
 * toggle; supplier names and Priority's own text stay as they are, with
 * dir="auto".
 */
export function ReceiptsBoard() {
  const params = useSearchParams();
  const u = params.get('u') ?? '';
  const sig = params.get('sig') ?? '';
  const hasLink = Boolean(u && sig);

  const [lang, setLang] = usePersisted<Language>(LANG_KEY, LANGS, 'Hebrew');
  const [windowFilter, pickWindow] = usePersisted<WindowFilter>(`${FILTER_KEY}.window`, WINDOWS, '14d');
  const [category, pickCategory] = usePersisted<CategoryFilter>(`${FILTER_KEY}.category`, CATEGORIES, 'all');
  useLangDir(lang);
  const tr = useCallback<Tr>((key, vars) => t(lang, key, vars), [lang]);

  const [load, setLoad] = useState<Load>(() =>
    hasLink ? { kind: 'loading' } : { kind: 'error', key: 'receipts.noLink' },
  );
  const [reloads, setReloads] = useState(0);
  const refresh = useCallback(() => setReloads((n) => n + 1), []);

  useEffect(() => {
    if (!hasLink) return;
    let cancelled = false;
    (async () => {
      try {
        const q = new URLSearchParams({ u, sig });
        const res = await fetch(`/api/priority/receipts?${q.toString()}`, { cache: 'no-store' });
        const data = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok || !data?.success) {
          const key: TranslationKey =
            data?.error === 'link_invalid'
              ? 'receipts.linkInvalid'
              : data?.error === 'not_admin'
                ? 'receipts.notAdmin'
                : 'receipts.loadFailed';
          setLoad({ kind: 'error', key });
          return;
        }
        setLoad({
          kind: 'ready',
          rows: data.rows as ReceiptRow[],
          truncated: data.truncated === true,
          attentionLink: typeof data.attention_link === 'string' ? data.attention_link : null,
          at: new Date(),
        });
      } catch {
        if (!cancelled) setLoad({ kind: 'error', key: 'receipts.offline' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hasLink, u, sig, reloads]);

  const shown = useMemo(
    () => (load.kind === 'ready' ? filterReceipts(load.rows, windowFilter, category) : []),
    [load, windowFilter, category],
  );
  const counts = useMemo(() => countByState(shown), [shown]);
  const problems = shown.filter((r) => r.attention).length;

  const toggleLang = () => setLang(lang === 'Hebrew' ? 'English' : 'Hebrew');

  return (
    <LanguageContext.Provider value={lang}>
      <div dir={lang === 'Hebrew' ? 'rtl' : 'ltr'} className="min-h-screen bg-canvas text-ink">
        <div className="max-w-2xl mx-auto px-4 py-6 space-y-4">
          <header className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-xl font-extrabold">{tr('receipts.title')}</h1>
              <p className="text-sm text-ink-muted mt-1">{tr('receipts.subtitle')}</p>
            </div>
            <div className="flex-none flex flex-col items-end gap-2">
              <button
                onClick={toggleLang}
                className="inline-flex items-center gap-1 bg-tile border border-line-strong rounded-xl px-3 py-2 text-sm font-bold text-ink hover:bg-hover transition"
              >
                <MI name="translate" size={16} /> {tr('receipts.langToggle')}
              </button>
              {hasLink && (
                <button
                  onClick={refresh}
                  className="inline-flex items-center gap-1 bg-tile border border-line-strong rounded-xl px-3 py-2 text-sm font-bold text-ink hover:bg-hover transition"
                >
                  <MI name="refresh" size={16} /> {tr('receipts.refresh')}
                </button>
              )}
            </div>
          </header>

          {load.kind === 'loading' && <p className="text-sm text-ink-muted">{tr('receipts.loading')}</p>}

          {load.kind === 'error' && (
            <div className={`border rounded-[11px] px-3 py-[10px] text-sm font-semibold ${TONE_CLASS.danger}`}>
              {tr(load.key)}
            </div>
          )}

          {load.kind === 'ready' && (
            <>
              <div className="space-y-2">
                <ChipRow>
                  {WINDOWS.map((w) => (
                    <FilterChip key={w} active={windowFilter === w} onClick={() => pickWindow(w)}>
                      {tr(`receipts.filter.${w}`)}
                    </FilterChip>
                  ))}
                </ChipRow>
                <ChipRow>
                  <FilterChip active={category === 'all'} onClick={() => pickCategory('all')}>
                    {tr('receipts.filter.all')}
                  </FilterChip>
                  <FilterChip active={category === 'meat'} onClick={() => pickCategory('meat')}>
                    {tr('receipts.filter.meat')}
                  </FilterChip>
                  <FilterChip active={category === 'non_meat'} onClick={() => pickCategory('non_meat')}>
                    {tr('receipts.filter.nonMeat')}
                  </FilterChip>
                </ChipRow>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <SummaryTile tone="ok" label={tr('receipts.sum.done')} value={counts.done} />
                <SummaryTile tone="brand" label={tr('receipts.sum.waiting')} value={counts.waiting + counts.receiving} />
                <SummaryTile tone={problems ? 'danger' : 'muted'} label={tr('receipts.sum.problem')} value={problems} />
              </div>

              <p className="text-xs text-ink-muted">
                {tr('receipts.count', { n: shown.length })}
                {' · '}
                {tr('receipts.updated', { time: formatReceiptTime(load.at.toISOString()) })}
                {load.truncated && ` · ${tr('receipts.truncated')}`}
              </p>

              {shown.length === 0 && <p className="text-sm text-ink-muted">{tr('receipts.empty')}</p>}

              {shown.map((row) => (
                <ReceiptCard key={row.delivery_id} row={row} tr={tr} attentionLink={load.attentionLink} />
              ))}
            </>
          )}
        </div>
      </div>
    </LanguageContext.Provider>
  );
}

function ChipRow({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap gap-2">{children}</div>;
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full border px-3 py-[6px] text-sm font-bold transition ${
        active ? 'bg-brand text-ink-inverse border-brand' : 'bg-tile border-line-strong text-ink hover:bg-hover'
      }`}
    >
      {children}
    </button>
  );
}

function SummaryTile({ tone, label, value }: { tone: Tone; label: string; value: number }) {
  return (
    <div className={`border rounded-[14px] px-3 py-2 ${TONE_CLASS[tone]}`}>
      <div className="text-2xl font-extrabold leading-tight">{value}</div>
      <div className="text-xs font-bold">{label}</div>
    </div>
  );
}

function stateLabel(row: ReceiptRow, tr: Tr): string {
  switch (row.state) {
    case 'done':
      return row.gr_docno ? tr('receipts.state.done', { docno: row.gr_docno }) : tr('receipts.state.doneNoDoc');
    case 'waiting':
      return tr('receipts.state.waiting');
    case 'receiving':
      return tr('receipts.state.receiving');
    case 'refused':
      return tr('receipts.state.refused');
    case 'partial':
      return tr('receipts.state.partial');
    case 'unconfirmed':
      return tr('receipts.state.unconfirmed');
    case 'not_sent':
      return row.is_test ? tr('receipts.state.test') : tr('receipts.state.notSent');
  }
}

function ReceiptCard({ row, tr, attentionLink }: { row: ReceiptRow; tr: Tr; attentionLink: string | null }) {
  const tone = row.is_test && row.state === 'not_sent' ? 'muted' : STATE_TONE[row.state];
  const bar = row.is_test && row.state === 'not_sent' ? 'bg-line-strong' : STATE_BAR[row.state];
  const note = row.document_number || '—';
  // Priority's status word (טיוטא = draft) is glossed in English mode
  const grStatus = row.gr_status ? (row.gr_status === 'טיוטא' ? tr('receipts.state.draft') : row.gr_status) : null;
  const showReason = row.reason && row.state !== 'done' && !(row.state === 'not_sent' && row.reason === 'test');

  return (
    <div className="relative overflow-hidden bg-raised border border-line rounded-[14px] p-4 ps-5 space-y-2">
      <span aria-hidden className={`absolute inset-y-0 start-0 w-[5px] ${bar}`} />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-extrabold text-ink truncate">
            <bdi>{row.supplier || '—'}</bdi>
          </div>
          <div className="text-sm text-ink-body mt-[2px]">
            {tr('receipts.note')}{' '}
            <span dir="ltr" className="font-mono font-bold">
              {note}
            </span>
          </div>
        </div>
        <div className="flex-none flex flex-col items-end gap-1">
          <span className={`border rounded-full px-2 py-[2px] text-xs font-extrabold whitespace-nowrap ${TONE_CLASS[tone]}`}>
            <bdi>{stateLabel(row, tr)}</bdi>
          </span>
          {row.state === 'done' && grStatus && <span className="text-[11px] text-ink-muted">{grStatus}</span>}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-muted">
        <span dir="ltr">{formatReceiptTime(row.created_at)}</span>
        {row.category && (
          <MetaChip tone={row.category === 'meat' ? 'danger' : 'ok'}>
            {tr(row.category === 'meat' ? 'receipts.cat.meat' : 'receipts.cat.nonMeat')}
          </MetaChip>
        )}
        <MetaChip tone="muted">{row.line_count === 1 ? tr('receipts.line') : tr('receipts.lines', { n: row.line_count })}</MetaChip>
        <MetaChip tone={row.po_number ? 'brand' : 'muted'}>
          {row.po_number ? (
            <>
              {tr('receipts.po')}{' '}
              <span dir="ltr" className="font-mono">
                {row.po_number}
              </span>
            </>
          ) : (
            tr('receipts.noPo')
          )}
        </MetaChip>
        {row.worker && (
          <span dir="auto">
            {tr('receipts.by', { name: row.worker })}
          </span>
        )}
        {row.is_test && <MetaChip tone="warn">{tr('receipts.test')}</MetaChip>}
      </div>

      {showReason && row.reason && (
        <p className="text-sm font-semibold text-ink">{tr(`receipts.reason.${row.reason}` as TranslationKey)}</p>
      )}
      {row.state === 'partial' && (
        <p className={`border rounded-[11px] px-3 py-2 text-sm font-semibold ${TONE_CLASS.info}`}>
          {row.partial_docno
            ? tr('receipts.partialDoc', { docno: row.partial_docno })
            : tr('receipts.partialNoDoc', { note })}
        </p>
      )}
      {row.priority_error && (
        <p className="text-xs text-ink-muted" dir="auto">
          {row.priority_error}
        </p>
      )}

      {row.attention && attentionLink && (
        <a
          href={attentionLink}
          className="inline-flex items-center gap-1 bg-tile border border-line-strong rounded-xl px-3 py-2 text-sm font-bold text-ink hover:bg-hover transition"
        >
          <MI name="build" size={16} /> {tr('receipts.openAttention')}
        </a>
      )}
    </div>
  );
}

function MetaChip({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <span className={`border rounded-full px-2 py-[1px] text-[11px] font-bold ${TONE_CLASS[tone]}`}>{children}</span>;
}
