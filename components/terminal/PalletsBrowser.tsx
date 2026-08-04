'use client';

/**
 * משטחים — pallets browser (floor lookup).
 *
 * Full-screen overlay opened from the tool-dock chip: paged pallet list with
 * status filters + text search, camera scan-to-find (box barcode or LPN QR),
 * and a read-only per-pallet detail view with a sticker link.
 *
 * Data comes from GET /api/pallets and /api/pallets/detail, both guarded by
 * the page's live session token.
 */

import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { MI } from './MI';
import { ScreenOverlay } from './ScreenOverlay';
import { Toast, useToast } from './Toast';
import { SmartScanner } from '@/components/scanner/SmartScanner';
import { LanguageContext, useT } from '@/lib/i18n';
import type { ParsedBarcode, BoxStickerOCR } from '@/types';

interface PalletCard {
  id: string;
  lpn: string;
  status: string;
  pallet_type: string;
  category: string;
  item_name: string;
  document_number: string;
  expected_boxes: number;
  remaining_boxes: number;
  total_weight_kg: number;
  created_at: string;
}

interface PalletDetailItem {
  name_hebrew: string;
  name_english: string;
  expected_boxes: number;
  remaining_boxes: number;
  issued_boxes: number;
  avg_box_weight_kg: number;
  total_weight_kg: number;
  earliest_expiry: string | null;
  remaining_quantity: number | null;
  unit: string | null;
}

interface PalletDetail {
  card: PalletCard;
  items: PalletDetailItem[];
}

type StatusFilter = 'active' | 'in_stock' | 'partial' | 'empty' | 'all';

const FILTERS: { id: StatusFilter; key: string }[] = [
  { id: 'active', key: 'terminal.palletsFilterActive' },
  { id: 'in_stock', key: 'terminal.palletsFilterInStock' },
  { id: 'partial', key: 'terminal.palletsFilterPartial' },
  { id: 'empty', key: 'terminal.palletsFilterEmpty' },
  { id: 'all', key: 'terminal.palletsFilterAll' },
];

const STATUS_STYLE: Record<string, { bg: string; color: string; key: string }> = {
  Verified: { bg: 'rgba(19,164,236,.18)', color: '#7cc9f2', key: 'terminal.palletsStatusVerified' },
  'In Stock': { bg: 'rgba(34,197,94,.16)', color: '#86efac', key: 'terminal.palletsStatusInStock' },
  'Partially Issued': { bg: 'rgba(245,158,11,.18)', color: '#fbbf5c', key: 'terminal.palletsStatusPartial' },
  Empty: { bg: '#243444', color: '#94a3b8', key: 'terminal.palletsStatusEmpty' },
};

/** Extract an LPN from a scanned QR payload (sticker URL or bare LPN text). */
function lpnFromPayload(payload: string): string | null {
  const urlMatch = payload.match(/\/(?:sticker\/v1|pallet)\/([^/?#]+)/);
  if (urlMatch) {
    try {
      return decodeURIComponent(urlMatch[1]);
    } catch {
      return urlMatch[1];
    }
  }
  const lpnMatch = payload.match(/(?:NM-)?(?:LPN|LOOSE)-[A-Za-z0-9-]+/);
  return lpnMatch ? lpnMatch[0] : null;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getFullYear()}`;
}

function formatKg(kg: number): string {
  return (Math.round(kg * 10) / 10).toLocaleString();
}

interface PalletsBrowserProps {
  token: string;
  onBack: () => void;
}

export function PalletsBrowser({ token, onBack }: PalletsBrowserProps) {
  const tr = useT();
  const language = useContext(LanguageContext);
  const { toast, showToast } = useToast();

  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('active');
  const [pallets, setPallets] = useState<PalletCard[]>([]);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [errorKey, setErrorKey] = useState<'terminal.palletsError' | 'terminal.palletsSessionExpired' | null>(null);
  const [detail, setDetail] = useState<PalletDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [showScanner, setShowScanner] = useState(false);

  // Stable empty maps — SmartScanner only uses them for duplicate checks.
  const emptyScans = useMemo(() => new Map<string, ParsedBarcode>(), []);
  const emptyOcr = useMemo(() => new Map<string, BoxStickerOCR>(), []);

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
        const params = new URLSearchParams({
          token,
          status: statusFilter,
          page: String(pageNum),
        });
        if (debouncedQuery) params.set('q', debouncedQuery);
        const res = await fetch(`/api/pallets?${params}`);
        if (seq !== requestSeq.current) return;
        if (res.status === 401) {
          setErrorKey('terminal.palletsSessionExpired');
          return;
        }
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || 'load failed');
        setErrorKey(null);
        setPallets(prev => (append ? [...prev, ...data.pallets] : data.pallets));
        setHasMore(Boolean(data.hasMore));
        setPage(pageNum);
      } catch {
        if (seq === requestSeq.current) setErrorKey('terminal.palletsError');
      } finally {
        if (seq === requestSeq.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [token, statusFilter, debouncedQuery]
  );

  useEffect(() => {
    fetchPage(0, false);
  }, [fetchPage]);

  const openDetail = useCallback(
    async (id: string) => {
      setDetailLoading(true);
      try {
        const res = await fetch(`/api/pallets/detail?${new URLSearchParams({ token, id })}`);
        if (res.status === 401) {
          setErrorKey('terminal.palletsSessionExpired');
          return;
        }
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || 'load failed');
        setDetail({ card: data.card, items: data.items });
      } catch {
        showToast(tr('terminal.palletsError'), 'error', '#ef8a8a');
      } finally {
        setDetailLoading(false);
      }
    },
    [token, showToast, tr]
  );

  /** Scan-to-find: LPN QR → that pallet; ≥13-digit barcode → owning pallet. */
  const handleScanPayload = useCallback(
    async (payload: string) => {
      setShowScanner(false);
      const lpn = lpnFromPayload(payload);
      const digits = payload.replace(/\D/g, '');
      const params = new URLSearchParams({ token });
      if (lpn) params.set('lpn', lpn);
      else if (digits.length >= 13) params.set('barcode', payload.trim());
      else {
        showToast(tr('terminal.palletsNotFound'), 'search_off', '#ef8a8a');
        return;
      }
      try {
        const res = await fetch(`/api/pallets?${params}`);
        if (res.status === 401) {
          setErrorKey('terminal.palletsSessionExpired');
          return;
        }
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || 'lookup failed');
        if (data.pallets.length > 0) openDetail(data.pallets[0].id);
        else showToast(tr('terminal.palletsNotFound'), 'search_off', '#ef8a8a');
      } catch {
        showToast(tr('terminal.palletsError'), 'error', '#ef8a8a');
      }
    },
    [token, openDetail, showToast, tr]
  );

  const openSticker = useCallback(
    (lpn: string) => {
      const lang = language === 'Hebrew' ? 'Hebrew' : 'English';
      window.open(`/sticker/v1/${encodeURIComponent(lpn)}?lang=${lang}`, '_blank');
    },
    [language]
  );

  const typeBadge = (card: PalletCard): string => {
    if (card.category === 'non_meat') return tr('terminal.palletsTypeNonMeat');
    if (card.pallet_type === 'Mix') return tr('terminal.palletsTypeMix');
    if (card.pallet_type === 'Loose') return tr('terminal.palletsTypeLoose');
    return tr('terminal.palletsTypeSingle');
  };

  const statusChip = (status: string) => {
    const style = STATUS_STYLE[status];
    return (
      <span
        className="px-2 py-[2px] rounded-full text-[10px] font-extrabold whitespace-nowrap"
        style={style ? { background: style.bg, color: style.color } : { background: '#243444', color: '#94a3b8' }}
      >
        {style ? tr(style.key as Parameters<typeof tr>[0]) : status}
      </span>
    );
  };

  return (
    <ScreenOverlay title={tr('terminal.palletsTitle')} onBack={onBack}>
      {/* Search + filters */}
      <div className="flex-none px-3 pt-3 pb-[10px] border-b border-[#101821] bg-header flex flex-col gap-[9px]">
        <div className="flex gap-2 items-center">
          <div className="flex-1 flex items-center gap-2 bg-search-bg border border-search-border rounded-[11px] px-3 h-[42px]">
            <MI name="search" size={19} className="text-search-ink" />
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={tr('terminal.palletsSearch')}
              className="flex-1 min-w-0 bg-transparent outline-none text-[13px] font-bold text-ink-inverse placeholder:text-search-ink"
            />
            {query && (
              <button onClick={() => setQuery('')} className="flex text-search-ink" aria-label="clear">
                <MI name="close" size={17} />
              </button>
            )}
          </div>
          <button
            onClick={() => setShowScanner(true)}
            className="w-[42px] h-[42px] rounded-[11px] border border-line bg-tile flex items-center justify-center text-ink-inverse"
            aria-label="scan"
          >
            <MI name="qr_code_scanner" size={20} />
          </button>
        </div>
        <div className="flex gap-[7px] overflow-x-auto no-scrollbar">
          {FILTERS.map(f => (
            <button
              key={f.id}
              onClick={() => setStatusFilter(f.id)}
              className="flex-none px-3 py-[6px] rounded-full text-[11px] font-extrabold border"
              style={
                statusFilter === f.id
                  ? { background: 'rgba(19,164,236,.14)', borderColor: '#13a4ec', color: '#7cc9f2' }
                  : { borderColor: 'var(--color-line, #2a3a47)', background: 'var(--color-tile, #1a2530)', color: '#e8eef2' }
              }
            >
              {tr(f.key as Parameters<typeof tr>[0])}
            </button>
          ))}
        </div>
      </div>

      {/* List */}
      <div className="flex-1 min-h-0 overflow-y-auto p-3 flex flex-col gap-[10px]">
        {errorKey ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-6">
            <MI name={errorKey === 'terminal.palletsSessionExpired' ? 'schedule' : 'error'} size={34} className="text-ink-muted" />
            <div className="text-[13px] font-bold text-ink-muted">{tr(errorKey)}</div>
            {errorKey === 'terminal.palletsError' && (
              <button
                onClick={() => fetchPage(0, false)}
                className="px-4 py-2 rounded-[11px] border border-line bg-tile text-[12px] font-extrabold text-ink-inverse"
              >
                {tr('terminal.palletsLoadMore')}
              </button>
            )}
          </div>
        ) : loading ? (
          <div className="flex-1 flex items-center justify-center text-[13px] font-bold text-ink-muted">
            {tr('terminal.palletsLoading')}
          </div>
        ) : pallets.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-3">
            <MI name="pallet" size={34} className="text-ink-muted" />
            <div className="text-[13px] font-bold text-ink-muted">{tr('terminal.palletsEmptyList')}</div>
          </div>
        ) : (
          <>
            {pallets.map(card => (
              <button
                key={card.id}
                onClick={() => openDetail(card.id)}
                className="flex items-center gap-3 bg-raised border border-line rounded-[14px] p-[11px] text-start"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-[6px] mb-[3px] flex-wrap">
                    {statusChip(card.status)}
                    <span className="px-2 py-[2px] rounded-full text-[9px] font-extrabold bg-[#243444] text-[#cbd5e1]">
                      {typeBadge(card)}
                    </span>
                    <span className="font-mono text-[10px] font-semibold text-[#cbd5e1]" dir="ltr">
                      {card.lpn}
                    </span>
                  </div>
                  <div className="text-[14px] font-extrabold text-[#e8eef2] whitespace-nowrap overflow-hidden text-ellipsis">
                    {card.item_name || card.document_number || card.lpn}
                  </div>
                  <div className="flex items-center gap-2 mt-[3px] flex-wrap">
                    <span className="text-[11px] font-bold text-[#e8eef2]">
                      {tr('terminal.palletsBoxes', { remaining: card.remaining_boxes, expected: card.expected_boxes })}
                    </span>
                    {card.total_weight_kg > 0 && (
                      <span className="text-[11px] font-semibold text-ink-muted">
                        · {tr('terminal.palletsWeight', { kg: formatKg(card.total_weight_kg) })}
                      </span>
                    )}
                    <span className="text-[11px] font-semibold text-ink-muted">· {formatDate(card.created_at)}</span>
                    {card.document_number && (
                      <span className="text-[11px] font-semibold text-ink-muted" dir="ltr">
                        · {card.document_number}
                      </span>
                    )}
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
                {loadingMore ? tr('terminal.palletsLoading') : tr('terminal.palletsLoadMore')}
              </button>
            )}
          </>
        )}
      </div>

      {/* Scan-to-find modal */}
      {showScanner && (
        <div className="absolute inset-0 z-20 bg-canvas flex flex-col">
          <div className="h-12 flex-none flex items-center gap-2 px-2 bg-header border-b border-[#101821]">
            <button onClick={() => setShowScanner(false)} className="p-2 flex text-[#e8eef2]" aria-label="close scanner">
              <MI name="close" size={22} />
            </button>
            <span className="text-[13px] font-extrabold text-ink-inverse">{tr('terminal.palletsScanHint')}</span>
          </div>
          <div className="flex-1 min-h-0 relative">
            <SmartScanner
              onBarcodeDetected={barcode => handleScanPayload(barcode)}
              scannedBarcodes={emptyScans}
              ocrResults={emptyOcr}
              frame="square"
              className="h-full"
            />
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
              {tr('terminal.palletsDetailTitle')}
            </h2>
          </div>
          {detailLoading || !detail ? (
            <div className="flex-1 flex items-center justify-center text-[13px] font-bold text-ink-muted">
              {tr('terminal.palletsLoading')}
            </div>
          ) : (
            <div className="flex-1 min-h-0 overflow-y-auto p-3 flex flex-col gap-3">
              {/* Header card */}
              <div className="bg-raised border border-line rounded-[14px] p-[13px] flex flex-col gap-[6px]">
                <div className="flex items-center gap-[6px] flex-wrap">
                  {statusChip(detail.card.status)}
                  <span className="px-2 py-[2px] rounded-full text-[9px] font-extrabold bg-[#243444] text-[#cbd5e1]">
                    {typeBadge(detail.card)}
                  </span>
                </div>
                <div className="font-mono text-[15px] font-bold text-ink-inverse" dir="ltr">
                  {detail.card.lpn}
                </div>
                <div className="flex flex-col gap-[2px] text-[12px] font-semibold text-ink-muted">
                  {detail.card.document_number && (
                    <span>
                      {tr('terminal.palletsDoc')}: <span dir="ltr">{detail.card.document_number}</span>
                    </span>
                  )}
                  <span>
                    {tr('terminal.palletsReceived')}: {formatDate(detail.card.created_at)}
                  </span>
                  {detail.card.total_weight_kg > 0 && (
                    <span>
                      {tr('terminal.palletsTotalWeight')}:{' '}
                      {tr('terminal.palletsWeight', { kg: formatKg(detail.card.total_weight_kg) })}
                    </span>
                  )}
                  <span className="text-[13px] font-extrabold text-ink-inverse">
                    {tr('terminal.palletsBoxes', {
                      remaining: detail.card.remaining_boxes,
                      expected: detail.card.expected_boxes,
                    })}
                  </span>
                </div>
              </div>

              {/* Items */}
              <div className="text-[12px] font-extrabold text-ink-muted px-1">{tr('terminal.palletsItemsHeader')}</div>
              {detail.items.map((item, i) => (
                <div key={i} className="bg-raised border border-line rounded-[14px] p-[12px] flex flex-col gap-[4px]">
                  <div className="text-[14px] font-extrabold text-[#e8eef2]">
                    {item.name_hebrew || item.name_english}
                  </div>
                  <div className="flex items-center gap-2 flex-wrap text-[11px] font-semibold text-ink-muted">
                    <span className="font-bold text-[#e8eef2]">
                      {tr('terminal.palletsRemaining')}: {item.remaining_boxes}/{item.expected_boxes}
                    </span>
                    {item.issued_boxes > 0 && (
                      <span>
                        · {tr('terminal.palletsIssued')}: {item.issued_boxes}
                      </span>
                    )}
                    {item.avg_box_weight_kg > 0 && (
                      <span>
                        · {tr('terminal.palletsAvgBox')}:{' '}
                        {tr('terminal.palletsWeight', { kg: formatKg(item.avg_box_weight_kg) })}
                      </span>
                    )}
                    {item.total_weight_kg > 0 && (
                      <span>· {tr('terminal.palletsWeight', { kg: formatKg(item.total_weight_kg) })}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 flex-wrap text-[11px] font-semibold text-ink-muted">
                    {item.earliest_expiry && (
                      <span>
                        {tr('terminal.palletsExpiry')}: {formatDate(item.earliest_expiry)}
                      </span>
                    )}
                    {item.remaining_quantity !== null && item.unit && (
                      <span>
                        {tr('terminal.palletsRemainingQty')}: {item.remaining_quantity} {item.unit}
                      </span>
                    )}
                  </div>
                </div>
              ))}

              {/* Sticker link (loose pallets have no printed sticker) */}
              {detail.card.pallet_type !== 'Loose' && (
                <button
                  onClick={() => openSticker(detail.card.lpn)}
                  className="mt-1 mb-3 flex items-center justify-center gap-2 px-4 py-[12px] rounded-[12px] border border-line bg-tile text-[13px] font-extrabold text-ink-inverse"
                >
                  <MI name="qr_code_2" size={19} />
                  {tr('terminal.palletsOpenSticker')}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      <Toast toast={toast} />
    </ScreenOverlay>
  );
}
