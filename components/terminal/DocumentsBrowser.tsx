'use client';

/**
 * מסמכים — documents archive (completed deliveries).
 *
 * Full-screen overlay opened from the side drawer: paged document list with
 * category chips (All/Meat/Non-meat), text search over doc number / supplier /
 * item names, a month picker, and a read-only detail view (invoice photo,
 * lines with discrepancy flags, pallets created, Type B voice note).
 *
 * Data comes from GET /api/documents and /api/documents/detail, both guarded
 * by the page's live session token. Pallet rows hand off to PalletsBrowser.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { MI } from './MI';
import { ScreenOverlay } from './ScreenOverlay';
import { Toast, useToast } from './Toast';
import { PalletsBrowser } from './PalletsBrowser';
import { useT } from '@/lib/i18n';

interface DocumentCard {
  source: 'meat' | 'non_meat';
  id: string;
  document_number: string;
  supplier_hebrew: string;
  supplier_english: string;
  invoice_date: string | null;
  received_at: string;
  image_url: string | null;
  line_count: number;
  has_voice_note: boolean;
}

interface DocumentLine {
  name_hebrew: string;
  name_english: string;
  invoice_qty: number;
  unit: string;
  invoice_boxes: number | null;
  received_qty: number | null;
  received_boxes: number | null;
  discrepancy: string | null;
}

interface DocumentPalletRef {
  id: string;
  lpn: string;
  pallet_type: string;
  status: string;
  box_count: number;
}

interface DocumentVoiceNote {
  transcript: string;
  pallet_count: number | null;
  box_count: number | null;
  solo_count: number | null;
  other_notes: string | null;
}

interface DocumentDetail {
  card: DocumentCard;
  lines: DocumentLine[];
  pallets: DocumentPalletRef[];
  voice_note: DocumentVoiceNote | null;
}

type CategoryFilter = 'all' | 'meat' | 'non_meat';

const FILTERS: { id: CategoryFilter; key: string }[] = [
  { id: 'all', key: 'terminal.docsAll' },
  { id: 'meat', key: 'terminal.docsMeat' },
  { id: 'non_meat', key: 'terminal.docsNonMeat' },
];

const BADGE_STYLE: Record<'meat' | 'non_meat', { bg: string; color: string; key: string }> = {
  meat: { bg: 'rgba(19,164,236,.18)', color: '#7cc9f2', key: 'terminal.docsMeat' },
  non_meat: { bg: 'rgba(34,197,94,.16)', color: '#86efac', key: 'terminal.docsNonMeat' },
};

// Cream mini invoice thumbnail (46×58) — fallback when no photo exists.
// (Moved from the deleted DocsScreenLocked mock.)
function DocThumb() {
  return (
    <div className="flex-none w-[46px] h-[58px] rounded-[6px] bg-paper shadow-[0_3px_8px_rgba(0,0,0,.4)] relative overflow-hidden">
      <div className="absolute top-[6px] left-[5px] w-5 h-1 bg-[#b8b0a0] rounded-[1px]" />
      <div className="absolute top-[15px] left-[5px] right-[14px] h-[3px] bg-paper-line" />
      <div className="absolute top-[22px] left-[5px] right-[9px] h-[3px] bg-paper-line" />
      <div className="absolute top-[29px] left-[5px] right-[18px] h-[3px] bg-paper-line" />
      <div
        className="absolute bottom-[6px] left-[5px] right-[5px] h-[9px]"
        style={{ background: 'repeating-linear-gradient(90deg,#111 0 1.5px,transparent 1.5px 3px)' }}
      />
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getFullYear()}`;
}

/** 'YYYY-MM' → 'MM/YYYY' for the month-picker rows. */
function formatMonth(ym: string): string {
  return `${ym.slice(5, 7)}/${ym.slice(0, 4)}`;
}

function formatQty(qty: number, unit: string): string {
  const n = (Math.round(qty * 10) / 10).toLocaleString();
  return unit ? `${n} ${unit}` : n;
}

interface DocumentsBrowserProps {
  token: string;
  onBack: () => void;
}

export function DocumentsBrowser({ token, onBack }: DocumentsBrowserProps) {
  const tr = useT();
  const { toast, showToast } = useToast();

  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [category, setCategory] = useState<CategoryFilter>('all');
  const [month, setMonth] = useState<string | null>(null);
  const [showMonthPicker, setShowMonthPicker] = useState(false);
  const [documents, setDocuments] = useState<DocumentCard[]>([]);
  const [months, setMonths] = useState<string[]>([]);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [errorKey, setErrorKey] = useState<'terminal.docsError' | 'terminal.docsSessionExpired' | null>(null);
  const [detail, setDetail] = useState<DocumentDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [palletId, setPalletId] = useState<string | null>(null);

  const requestSeq = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 300);
    return () => clearTimeout(timer);
  }, [query]);

  const fetchPage = useCallback(
    async (pageNum: number, append: boolean) => {
      const seq = ++requestSeq.current;
      if (append) setLoadingMore(true);
      else setLoading(true);
      try {
        const params = new URLSearchParams({ token, category, page: String(pageNum) });
        if (debouncedQuery) params.set('q', debouncedQuery);
        if (month) params.set('month', month);
        const res = await fetch(`/api/documents?${params}`);
        if (seq !== requestSeq.current) return;
        if (res.status === 401) {
          setErrorKey('terminal.docsSessionExpired');
          return;
        }
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || 'load failed');
        setErrorKey(null);
        setDocuments(prev => (append ? [...prev, ...data.documents] : data.documents));
        setMonths(data.months);
        setHasMore(Boolean(data.hasMore));
        setPage(pageNum);
      } catch {
        if (seq === requestSeq.current) setErrorKey('terminal.docsError');
      } finally {
        if (seq === requestSeq.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [token, category, month, debouncedQuery]
  );

  useEffect(() => {
    fetchPage(0, false);
  }, [fetchPage]);

  const openDetail = useCallback(
    async (card: DocumentCard) => {
      setDetailLoading(true);
      try {
        const params = new URLSearchParams({ token, source: card.source, id: card.id });
        const res = await fetch(`/api/documents/detail?${params}`);
        if (res.status === 401) {
          setErrorKey('terminal.docsSessionExpired');
          return;
        }
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || 'load failed');
        setDetail({ card: data.card, lines: data.lines, pallets: data.pallets, voice_note: data.voice_note });
      } catch {
        showToast(tr('terminal.docsError'), 'error', '#ef8a8a');
      } finally {
        setDetailLoading(false);
      }
    },
    [token, showToast, tr]
  );

  const categoryBadge = (source: 'meat' | 'non_meat') => {
    const style = BADGE_STYLE[source];
    return (
      <span
        className="px-2 py-[2px] rounded-full text-[9px] font-extrabold"
        style={{ background: style.bg, color: style.color }}
      >
        {tr(style.key as Parameters<typeof tr>[0])}
      </span>
    );
  };

  return (
    <ScreenOverlay title={tr('terminal.docsTitle')} onBack={onBack}>
      {/* Search + month + category chips */}
      <div className="flex-none px-3 pt-3 pb-[10px] border-b border-[#101821] bg-header flex flex-col gap-[9px]">
        <div className="flex gap-2 items-center">
          <div className="flex-1 flex items-center gap-2 bg-search-bg border border-search-border rounded-[11px] px-3 h-[42px]">
            <MI name="search" size={19} className="text-search-ink" />
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={tr('terminal.docsSearch')}
              className="flex-1 min-w-0 bg-transparent outline-none text-[13px] font-bold text-ink-inverse placeholder:text-search-ink"
            />
            {query && (
              <button onClick={() => setQuery('')} className="flex text-search-ink" aria-label="clear">
                <MI name="close" size={17} />
              </button>
            )}
          </div>
          <button
            onClick={() => setShowMonthPicker(true)}
            className="w-[42px] h-[42px] rounded-[11px] border flex items-center justify-center"
            style={
              month
                ? { background: 'rgba(19,164,236,.14)', borderColor: '#13a4ec', color: '#7cc9f2' }
                : { borderColor: 'var(--color-line, #2a3a47)', background: 'var(--color-tile, #1a2530)', color: '#e8eef2' }
            }
            aria-label="month"
          >
            <MI name="calendar_month" size={20} />
          </button>
        </div>
        <div className="flex gap-[7px] overflow-x-auto no-scrollbar">
          {FILTERS.map(f => (
            <button
              key={f.id}
              onClick={() => setCategory(f.id)}
              className="flex-none px-3 py-[6px] rounded-full text-[11px] font-extrabold border"
              style={
                category === f.id
                  ? { background: 'rgba(19,164,236,.14)', borderColor: '#13a4ec', color: '#7cc9f2' }
                  : { borderColor: 'var(--color-line, #2a3a47)', background: 'var(--color-tile, #1a2530)', color: '#e8eef2' }
              }
            >
              {tr(f.key as Parameters<typeof tr>[0])}
            </button>
          ))}
          {month && (
            <button
              onClick={() => setMonth(null)}
              className="flex-none px-3 py-[6px] rounded-full text-[11px] font-extrabold border flex items-center gap-1"
              style={{ background: 'rgba(19,164,236,.14)', borderColor: '#13a4ec', color: '#7cc9f2' }}
            >
              {formatMonth(month)}
              <MI name="close" size={13} />
            </button>
          )}
        </div>
      </div>

      {/* List */}
      <div className="flex-1 min-h-0 overflow-y-auto p-3 flex flex-col gap-[10px]">
        {errorKey ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-6">
            <MI name={errorKey === 'terminal.docsSessionExpired' ? 'schedule' : 'error'} size={34} className="text-ink-muted" />
            <div className="text-[13px] font-bold text-ink-muted">{tr(errorKey)}</div>
            {errorKey === 'terminal.docsError' && (
              <button
                onClick={() => fetchPage(0, false)}
                className="px-4 py-2 rounded-[11px] border border-line bg-tile text-[12px] font-extrabold text-ink-inverse"
              >
                {tr('terminal.docsLoadMore')}
              </button>
            )}
          </div>
        ) : loading ? (
          <div className="flex-1 flex items-center justify-center text-[13px] font-bold text-ink-muted">
            {tr('terminal.docsLoading')}
          </div>
        ) : documents.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-3">
            <MI name="description" size={34} className="text-ink-muted" />
            <div className="text-[13px] font-bold text-ink-muted">{tr('terminal.docsEmpty')}</div>
          </div>
        ) : (
          <>
            {documents.map(card => (
              <button
                key={`${card.source}:${card.id}`}
                onClick={() => openDetail(card)}
                className="flex items-center gap-3 bg-raised border border-line rounded-[14px] p-[11px] text-start"
              >
                {card.image_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={card.image_url}
                    alt=""
                    className="flex-none w-[46px] h-[58px] rounded-[6px] object-cover bg-tile"
                  />
                ) : (
                  <DocThumb />
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-[6px] mb-[3px] flex-wrap">
                    {categoryBadge(card.source)}
                    {card.document_number && (
                      <span className="font-mono text-[10px] font-semibold text-[#cbd5e1]" dir="ltr">
                        {card.document_number}
                      </span>
                    )}
                    {card.has_voice_note && <MI name="mic" size={13} className="text-[#7cc9f2]" />}
                  </div>
                  <div className="text-[14px] font-extrabold text-[#e8eef2] whitespace-nowrap overflow-hidden text-ellipsis">
                    {card.supplier_hebrew || card.supplier_english || card.document_number}
                  </div>
                  <div className="flex items-center gap-2 mt-[3px] flex-wrap">
                    <span className="text-[11px] font-semibold text-[#e8eef2]">{formatDate(card.received_at)}</span>
                    <span className="text-[11px] font-semibold text-[#e8eef2]">
                      · {tr('terminal.docsLines', { count: card.line_count })}
                    </span>
                  </div>
                </div>
                <MI name="chevron_left" size={20} className="flex-none text-[#cbd5e1]" />
              </button>
            ))}
            {hasMore && (
              <button
                onClick={() => fetchPage(page + 1, true)}
                disabled={loadingMore}
                className="mt-1 mb-2 px-4 py-[10px] rounded-[11px] border border-line bg-tile text-[12px] font-extrabold text-ink-inverse disabled:opacity-50"
              >
                {loadingMore ? tr('terminal.docsLoading') : tr('terminal.docsLoadMore')}
              </button>
            )}
          </>
        )}
      </div>

      {/* Month picker */}
      {showMonthPicker && (
        <div
          className="absolute inset-0 z-20 bg-black/60 flex items-end"
          onClick={() => setShowMonthPicker(false)}
        >
          <div
            className="w-full max-h-[60%] overflow-y-auto bg-canvas border-t border-line rounded-t-[16px] p-3 flex flex-col gap-2"
            onClick={e => e.stopPropagation()}
          >
            <button
              onClick={() => {
                setMonth(null);
                setShowMonthPicker(false);
              }}
              className="px-4 py-[11px] rounded-[11px] border text-[13px] font-extrabold text-start"
              style={
                month === null
                  ? { background: 'rgba(19,164,236,.14)', borderColor: '#13a4ec', color: '#7cc9f2' }
                  : { borderColor: 'var(--color-line, #2a3a47)', background: 'var(--color-tile, #1a2530)', color: '#e8eef2' }
              }
            >
              {tr('terminal.docsMonthAll')}
            </button>
            {months.map(m => (
              <button
                key={m}
                onClick={() => {
                  setMonth(m);
                  setShowMonthPicker(false);
                }}
                className="px-4 py-[11px] rounded-[11px] border text-[13px] font-extrabold text-start"
                style={
                  month === m
                    ? { background: 'rgba(19,164,236,.14)', borderColor: '#13a4ec', color: '#7cc9f2' }
                    : { borderColor: 'var(--color-line, #2a3a47)', background: 'var(--color-tile, #1a2530)', color: '#e8eef2' }
                }
                dir="ltr"
              >
                {formatMonth(m)}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Detail overlay */}
      {(detail || detailLoading) && (
        <div className="absolute inset-0 z-30 bg-canvas flex flex-col">
          <div className="h-14 flex-none flex items-center gap-2 px-2 border-b border-[#101821] bg-header">
            <button onClick={() => setDetail(null)} className="p-2 flex text-[#e8eef2]" aria-label="back">
              <MI name="arrow_forward_ios" size={22} />
            </button>
            <h2 className="flex-1 text-[15px] font-extrabold text-ink-inverse m-0">
              {tr('terminal.docsDetailTitle')}
            </h2>
          </div>
          {detailLoading || !detail ? (
            <div className="flex-1 flex items-center justify-center text-[13px] font-bold text-ink-muted">
              {tr('terminal.docsLoading')}
            </div>
          ) : (
            <div className="flex-1 min-h-0 overflow-y-auto p-3 flex flex-col gap-3">
              {/* Header card */}
              <div className="bg-raised border border-line rounded-[14px] p-[13px] flex flex-col gap-[6px]">
                <div className="flex items-center gap-[6px] flex-wrap">
                  {categoryBadge(detail.card.source)}
                  {detail.card.document_number && (
                    <span className="font-mono text-[12px] font-semibold text-[#cbd5e1]" dir="ltr">
                      {detail.card.document_number}
                    </span>
                  )}
                </div>
                <div className="text-[16px] font-extrabold text-ink-inverse">
                  {detail.card.supplier_hebrew || detail.card.supplier_english}
                </div>
                <div className="flex flex-col gap-[2px] text-[12px] font-semibold text-ink-muted">
                  {detail.card.invoice_date && (
                    <span>
                      {tr('terminal.docsInvoiceDate')}: {formatDate(detail.card.invoice_date)}
                    </span>
                  )}
                  <span>
                    {tr('terminal.docsReceived')}: {formatDate(detail.card.received_at)}
                  </span>
                </div>
              </div>

              {/* Invoice photo */}
              {detail.card.image_url && (
                <button
                  onClick={() => window.open(detail.card.image_url as string, '_blank')}
                  className="relative flex-none bg-raised border border-line rounded-[14px] overflow-hidden"
                  aria-label={tr('terminal.docsOpenImage')}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={detail.card.image_url} alt="" className="w-full max-h-[320px] object-contain bg-black/30" />
                  <span className="absolute bottom-2 end-2 flex items-center gap-1 px-2 py-[3px] rounded-full bg-black/60 text-[10px] font-extrabold text-white">
                    <MI name="open_in_new" size={13} />
                    {tr('terminal.docsOpenImage')}
                  </span>
                </button>
              )}

              {/* Lines */}
              <div className="text-[12px] font-extrabold text-ink-muted px-1">{tr('terminal.docsItemsHeader')}</div>
              {detail.lines.map((line, i) => (
                <div key={i} className="bg-raised border border-line rounded-[14px] p-[12px] flex flex-col gap-[4px]">
                  <div className="flex items-center gap-2">
                    <span className="flex-1 text-[14px] font-extrabold text-[#e8eef2]">
                      {line.name_hebrew || line.name_english}
                    </span>
                    {line.discrepancy && (
                      <span
                        className="px-2 py-[2px] rounded-full text-[9px] font-extrabold"
                        style={{ background: 'rgba(245,158,11,.18)', color: '#fbbf5c' }}
                      >
                        {tr('terminal.docsGap')}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 flex-wrap text-[11px] font-semibold text-ink-muted">
                    <span className="font-bold text-[#e8eef2]">
                      {tr('terminal.docsInvoiceQty', { qty: formatQty(line.invoice_qty, line.unit) })}
                    </span>
                    {line.invoice_boxes !== null && line.invoice_boxes > 0 && (
                      <span>· {tr('terminal.docsBoxes', { count: line.invoice_boxes })}</span>
                    )}
                  </div>
                  {line.discrepancy && (
                    <div className="flex flex-col gap-[2px] text-[11px] font-semibold" style={{ color: '#fbbf5c' }}>
                      {line.received_qty !== null && (
                        <span>
                          {tr('terminal.docsReceivedQty', { qty: formatQty(line.received_qty, line.unit) })}
                          {line.received_boxes !== null && line.received_boxes > 0 &&
                            ` · ${tr('terminal.docsBoxes', { count: line.received_boxes })}`}
                        </span>
                      )}
                      <span>{line.discrepancy}</span>
                    </div>
                  )}
                </div>
              ))}

              {/* Pallets created */}
              {detail.pallets.length > 0 && (
                <>
                  <div className="text-[12px] font-extrabold text-ink-muted px-1">
                    {tr('terminal.docsPalletsHeader')}
                  </div>
                  {detail.pallets.map(p => (
                    <button
                      key={p.id}
                      onClick={() => setPalletId(p.id)}
                      className="flex items-center gap-3 bg-raised border border-line rounded-[14px] p-[12px] text-start"
                    >
                      <MI name="pallet" size={20} className="flex-none text-[#7cc9f2]" />
                      <div className="flex-1 min-w-0">
                        <div className="font-mono text-[12px] font-bold text-ink-inverse" dir="ltr">
                          {p.lpn}
                        </div>
                        <div className="text-[11px] font-semibold text-ink-muted">
                          {p.pallet_type}
                          {p.box_count > 0 && ` · ${tr('terminal.docsBoxes', { count: p.box_count })}`}
                        </div>
                      </div>
                      <MI name="chevron_left" size={20} className="flex-none text-[#cbd5e1]" />
                    </button>
                  ))}
                </>
              )}

              {/* Voice note (Type B non-meat) */}
              {detail.voice_note && (
                <>
                  <div className="text-[12px] font-extrabold text-ink-muted px-1 flex items-center gap-1">
                    <MI name="mic" size={14} />
                    {tr('terminal.docsVoiceHeader')}
                  </div>
                  <div className="bg-raised border border-line rounded-[14px] p-[12px] flex flex-col gap-[6px] mb-3">
                    <div className="text-[11px] font-bold text-[#e8eef2]">
                      {tr('terminal.docsVoiceCounts', {
                        pallets: detail.voice_note.pallet_count ?? 0,
                        boxes: detail.voice_note.box_count ?? 0,
                        solo: detail.voice_note.solo_count ?? 0,
                      })}
                    </div>
                    {detail.voice_note.transcript && (
                      <div className="text-[12px] font-semibold text-ink-muted whitespace-pre-wrap">
                        {detail.voice_note.transcript}
                      </div>
                    )}
                    {detail.voice_note.other_notes && (
                      <div className="text-[11px] font-semibold text-ink-muted">{detail.voice_note.other_notes}</div>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* Pallet hand-off */}
      {palletId && (
        <PalletsBrowser token={token} initialPalletId={palletId} onBack={() => setPalletId(null)} />
      )}

      <Toast toast={toast} />
    </ScreenOverlay>
  );
}
