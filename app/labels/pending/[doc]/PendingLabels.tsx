'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { MI } from '@/components/terminal/MI';
import { LanguageContext, t, useLangDir } from '@/lib/i18n';
import {
  groupLabelsByPallet,
  loadLabelSize,
  nextSignedSheetChunk,
  saveLabelSize,
  signedLabelSheetUrl,
  type PalletLabelGroup,
} from '@/lib/label-batches';
import type { CartonLabel, Language, LabelSize } from '@/types';

const SIZES: { id: LabelSize; name: string }[] = [
  { id: '10x10', name: '10×10' },
  { id: '10x15', name: '10×15' },
  { id: 'a4', name: 'A4' },
];

/** One line per item on a pallet card: name · count · weight · expiry. */
interface ItemLine {
  key: string;
  name: string;
  count: number;
  printed: number;
  weight: number | null;
  expiry: string | null;
}

function itemLines(labels: CartonLabel[]): ItemLine[] {
  const byKey = new Map<string, ItemLine>();
  for (const l of labels) {
    const name = l.item_name_hebrew || l.item_name_english || '—';
    const key = `${name}|${l.weight_kg ?? ''}|${l.expiry_date ?? ''}`;
    const line = byKey.get(key);
    if (line) {
      line.count += 1;
      if (l.status === 'printed') line.printed += 1;
    } else {
      byKey.set(key, {
        key, name, count: 1, printed: l.status === 'printed' ? 1 : 0,
        weight: l.weight_kg == null ? null : Number(l.weight_kg), expiry: l.expiry_date,
      });
    }
  }
  return [...byKey.values()];
}

/** DD/MM/YY from ISO — what the floor reads on every other screen. */
function shortDate(iso: string | null): string {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1].slice(2)}` : iso;
}

/**
 * The signed pending-labels page (see page.tsx). Lists the note's labels
 * still at 'created', one card per pallet, each with its own Print; "Print
 * all" at the bottom. Printing opens the ordinary print sheet with the exact
 * label ids and the signature — the sheet marks what it rendered as printed,
 * and this page re-reads when the worker comes back to the tab.
 */
export function PendingLabels({ doc }: { doc: string }) {
  const params = useSearchParams();
  const sig = params.get('sig') ?? '';
  const language: Language = params.get('lang') === 'English' ? 'English' : 'Hebrew';
  useLangDir(language);
  const tr = useCallback(
    (key: Parameters<typeof t>[1], vars?: Parameters<typeof t>[2]) => t(language, key, vars),
    [language],
  );

  const [labels, setLabels] = useState<CartonLabel[] | null>(null);
  const [state, setState] = useState<'ok' | 'invalid' | 'failed'>('ok');
  const [showPrinted, setShowPrinted] = useState(false);
  // The size this device printed with last (per device, never shared).
  const [size, setSize] = useState<LabelSize>(() => loadLabelSize());
  const [blocked, setBlocked] = useState(false);

  const load = useCallback(() => {
    if (!sig) return;
    fetch(`/api/carton-labels/pending?doc=${encodeURIComponent(doc)}&sig=${encodeURIComponent(sig)}${showPrinted ? '&printed=1' : ''}`)
      .then(async (r) => {
        if (r.status === 401) {
          setState('invalid');
          return;
        }
        const data = await r.json();
        if (!data?.success) {
          setState('failed');
          return;
        }
        setState('ok');
        setLabels(data.labels as CartonLabel[]);
      })
      .catch(() => setState('failed'));
  }, [doc, sig, showPrinted]);

  useEffect(() => {
    load();
    // Back from the print tab: the sheet marked what it printed.
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', load);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', load);
    };
  }, [load]);

  const groups: PalletLabelGroup<CartonLabel>[] = useMemo(() => groupLabelsByPallet(labels ?? []), [labels]);
  const waiting = (labels ?? []).filter((l) => l.status === 'created');

  function print(list: CartonLabel[]) {
    if (!list.length) return;
    // Synchronously inside the tap: a window.open after an await is what
    // pop-up blockers kill.
    // At most SIGNED_SHEET_MAX_IDS per sheet (URL length); the rest are
    // offered again once this sheet marks its labels printed.
    const win = window.open(
      signedLabelSheetUrl({ doc, sig, ids: nextSignedSheetChunk(list).map((l) => l.id), size, language }),
      '_blank',
    );
    setBlocked(!win);
  }

  function pickSize(next: LabelSize) {
    setSize(next);
    saveLabelSize(next);
  }

  /** Button text: "Print N", or "Print next 150 (of N)" past one sheet. */
  const printLabel = (key: 'pending.printGroup' | 'pending.printAll', count: number) => {
    const chunk = nextSignedSheetChunk(Array.from({ length: count })).length;
    return chunk < count ? tr('pending.printNext', { count: chunk, total: count }) : tr(key, { count });
  };

  const groupTitle = (g: PalletLabelGroup<CartonLabel>) =>
    g.pallet_number === null ? tr('pending.unknown') : g.pallet_number === 0 ? tr('pending.loose') : tr('pending.pallet', { n: g.pallet_number });

  return (
    <LanguageContext.Provider value={language}>
      <div className="min-h-dvh bg-canvas text-ink flex flex-col">
        <header className="flex-none bg-header border-b border-line px-4 py-3">
          <div className="max-w-[560px] mx-auto">
            <h1 className="flex items-center gap-2 text-[18px] font-black text-ink-inverse">
              <MI name="label" size={22} className="text-brand-weak-ink" />
              {tr('pending.title')}
            </h1>
            <p className="text-[12px] font-semibold text-ink-muted mt-[2px]">
              {tr('palletVerify.docPrefix', { doc })}
            </p>
          </div>
        </header>

        <main className="flex-1 w-full max-w-[560px] mx-auto px-4 py-4 flex flex-col gap-3">
          {!sig || state === 'invalid' ? (
            <p className="text-center text-[14px] font-bold text-danger-weak-ink py-10">{tr('pending.invalid')}</p>
          ) : state === 'failed' ? (
            <div className="text-center py-10">
              <p className="text-[14px] font-bold text-danger-weak-ink">{tr('pending.failed')}</p>
              <button onClick={load} className="mt-3 px-4 py-2 rounded-[10px] bg-tile border border-line text-[13px] font-extrabold text-ink-inverse">
                {tr('pending.refresh')}
              </button>
            </div>
          ) : labels === null ? (
            <p className="text-center text-[13px] text-ink-muted py-10">{tr('labels.sheetLoading')}</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                {SIZES.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => pickSize(s.id)}
                    className={`px-3 py-[7px] rounded-[9px] border text-[12px] font-extrabold ${size === s.id ? 'bg-brand-weak border-brand text-brand-weak-ink' : 'bg-tile border-line text-ink-inverse'}`}
                  >
                    {/* Isolated LTR: in RTL the bidi algorithm turned 10×15 into 15×10. */}
                    <bdi dir="ltr">{s.name}</bdi>
                  </button>
                ))}
                <label className="ms-auto inline-flex items-center gap-[6px] text-[12px] font-bold text-ink-muted">
                  <input type="checkbox" checked={showPrinted} onChange={(e) => setShowPrinted(e.target.checked)} />
                  {tr('pending.showPrinted')}
                </label>
              </div>

              {blocked && <p className="text-[12px] font-bold text-danger-weak-ink">{tr('labels.printBlocked')}</p>}

              {groups.length === 0 ? (
                <p className="flex items-center justify-center gap-2 text-center text-[14px] font-bold text-ok-weak-ink py-10">
                  <MI name="check_circle" size={20} /> {tr('pending.none')}
                </p>
              ) : (
                groups.map((g) => {
                  const toPrint = g.labels.filter((l) => l.status === 'created');
                  return (
                    <section key={String(g.pallet_number)} className="bg-header border border-line rounded-[14px] overflow-hidden">
                      <div className="flex items-center justify-between gap-2 px-3 py-[10px] border-b border-line">
                        <h2 className="text-[14px] font-black text-ink-inverse">{groupTitle(g)}</h2>
                        <button
                          onClick={() => print(toPrint.length ? toPrint : g.labels)}
                          className="inline-flex items-center gap-[5px] px-3 py-[8px] rounded-[10px] bg-brand text-white text-[12px] font-black"
                        >
                          <MI name="print" size={16} />
                          {printLabel('pending.printGroup', toPrint.length || g.labels.length)}
                        </button>
                      </div>
                      <ul className="divide-y divide-line">
                        {itemLines(g.labels).map((line) => (
                          <li key={line.key} className="flex items-center gap-2 px-3 py-[9px]">
                            <span className="flex-1 min-w-0">
                              <span className="block text-[13px] font-extrabold text-ink-inverse truncate">{line.name}</span>
                              <span className="block text-[11px] font-semibold text-ink-muted" dir="ltr">
                                {line.weight != null ? `${line.weight} kg` : ''}
                                {line.expiry ? ` · ${shortDate(line.expiry)}` : ''}
                              </span>
                            </span>
                            {line.printed > 0 && (
                              <span className="flex-none text-[10px] font-extrabold text-ok-weak-ink">
                                {line.printed} {tr('pending.printedTag')}
                              </span>
                            )}
                            <span className="flex-none font-mono text-[16px] font-black text-ink-inverse" dir="ltr">×{line.count}</span>
                          </li>
                        ))}
                      </ul>
                    </section>
                  );
                })
              )}
            </>
          )}
        </main>

        {sig && state === 'ok' && waiting.length > 0 && (
          <footer className="flex-none sticky bottom-0 bg-header border-t border-line px-4 py-3 safe-bottom">
            <button
              onClick={() => print(waiting)}
              className="w-full max-w-[560px] mx-auto h-[50px] rounded-[12px] bg-brand text-white text-[14px] font-black flex items-center justify-center gap-2"
            >
              <MI name="print" size={20} />
              {printLabel('pending.printAll', waiting.length)}
            </button>
          </footer>
        )}
      </div>
    </LanguageContext.Provider>
  );
}
