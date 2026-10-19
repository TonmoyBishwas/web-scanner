'use client';

/**
 * צור קרטון — New carton.
 *
 * A carton turns up with no supplier sticker, or one too torn to read. The
 * worker picks the item off THIS delivery's invoice, types what the missing
 * sticker would have said, and "Save N labels" stores one label per carton
 * with its own barcode, then returns straight to the scanner. Printing is a
 * later step on the Labels screen (amber badge on its chip until then).
 *
 * Saving labels books no stock and touches no delivery, pallet or box
 * record. The worker prints the label, puts it on the carton, and scans it
 * through the ordinary receiving flow — so the meat and non-meat inbound paths
 * are untouched by this feature.
 *
 * Except with `countOnSave` (pallet-verify, Q5 2026-10-13): the page puts one
 * row per saved label on the open list at once, counted at the weight typed
 * here — so the weight is required — and the pallet may close before the
 * labels are printed (lib/label-gate.ts).
 */

import { useMemo, useRef, useState } from 'react';
import { MI } from './MI';
import { ScreenOverlay } from './ScreenOverlay';
import { CalendarPicker } from './CalendarPicker';
import { CartonSticker } from './CartonSticker';
import { Toast, useToast } from './Toast';
import { useT } from '@/lib/i18n';
import { normalizeString } from '@/lib/string-utils';
import { batchIdForPayload } from '@/lib/label-batches';
import { validateCartonDates } from '@/lib/date-validation';
import { localIsoDate } from '@/lib/edit-panel-state';
import type { CartonLabel } from '@/types';

/** The subset of an invoice line this screen needs, shared by both session shapes. */
export interface CartonItemOption {
  item_code?: string;
  item_name_english?: string;
  item_name_hebrew?: string;
}

/** What the open list already holds of one item — see `CartonCreatorProps.onList`. */
export interface CartonOnList {
  /** Cartons of this item on the open list. */
  total: number;
  /** Of those, booked without a barcode (photo capture). */
  noBarcode: number;
  /** What "how many" opens on for it (lib/count-check.ts newCartonQuantity). */
  quantity: number;
  /** The line's cartons not on the list yet; null when not knowable. */
  left: number | null;
  /** The line's carton total when it is this pallet's alone; else null. */
  lineTotal: number | null;
}

/** New carton opened for one invoice line — see `CartonCreatorProps.preset`. */
export interface CartonCreatorPreset {
  item: CartonItemOption;
  weight?: number | null;
  quantity?: number;
  notice?: string;
  /** The invoice line's carton total, shown as a hint when the count is not
   *  prefilled from it (the line may sit on other pallets too). */
  lineTotal?: number | null;
}

interface CartonCreatorProps {
  token: string;
  items: CartonItemOption[];
  /**
   * Pallet the worker is on when saving (0 = the loose pile), stored on the
   * labels so the Labels screen can say where they belong; null when the
   * page has no pallet notion.
   */
  palletNumber: number | null;
  /**
   * Say above Save that the label counts nothing until it is scanned
   * (pallet-verify). David (2026-10-11) took "צור קרטון" (New carton) for
   * "add a carton": he printed labels for cartons the scanner had refused as
   * already counted, never scanned them, and the count stayed 12/15. The
   * line points him at "Another carton, same label" for that case.
   */
  notCountedWarning?: boolean;
  /**
   * Q5: the page counts each saved label as a carton at the typed weight
   * (no scan of the printed label needed). Weight becomes required and the
   * line above Save says the carton is counted now.
   */
  countOnSave?: boolean;
  /**
   * Open straight on the form for one invoice line (2026-10-15: a carton
   * whose only barcode is the supplier's short item code, e.g. `501004`).
   * Weight and count are DEFAULTS the worker sees and can change; nothing is
   * saved until he taps Save. With a preset the expiry is required (the
   * carton has no sticker the date could be read from later). `notice` is
   * the calm line shown above the form.
   */
  preset?: CartonCreatorPreset;
  /**
   * The cartons of an item already on the open list (pallet-verify,
   * document 48429). David photo-captured 3 cartons that had no long
   * barcode, then saved 22 labels here — one for every carton on the
   * pallet, those 3 included — and the list held 25 for a pallet of 22. With
   * this the form shows "already on the list: 3 cartons of this item", asks
   * "how many MORE", and opens on what the line still lacks.
   */
  onList?: (item: CartonItemOption) => CartonOnList | null;
  onBack: () => void;
  /** Fired after the batch is saved — the page closes this screen. `labels`
   *  = the saved rows as the server returned them (may be empty). */
  onCreated?: (count: number, batchId: string | null, labels: CartonLabel[]) => void;
}

type Step = 'item' | 'form';
type DateField = 'production' | 'expiry';

function displayDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

export function CartonCreator({ token, items, palletNumber, notCountedWarning = false, countOnSave = false, preset, onList, onBack, onCreated }: CartonCreatorProps) {
  const tr = useT();
  const { toast, showToast } = useToast();

  const [step, setStep] = useState<Step>(preset ? 'form' : 'item');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<CartonItemOption | null>(preset?.item ?? null);

  const [quantity, setQuantity] = useState(String(preset?.quantity && preset.quantity > 0 ? preset.quantity : 1));
  const [weight, setWeight] = useState(preset?.weight && preset.weight > 0 ? String(preset.weight) : '');
  const [productionDate, setProductionDate] = useState('');
  const [expiryDate, setExpiryDate] = useState('');
  const [notes, setNotes] = useState('');
  const [printBarcode, setPrintBarcode] = useState(true);
  const [calendarFor, setCalendarFor] = useState<DateField | null>(null);
  const [saving, setSaving] = useState(false);
  // One batch id per distinct save content (lib/label-batches.ts): a retry
  // of the same save after a lost response returns the batch the first
  // attempt saved instead of minting a second one — and a save for another
  // item or count (the worker went back and changed it) gets its own.
  const batchIdsRef = useRef(new Map<string, string>());

  const filtered = useMemo(() => {
    const q = normalizeString(query.trim());
    if (!q) return items;
    return items.filter(item =>
      normalizeString(item.item_name_hebrew ?? '').includes(q) ||
      normalizeString(item.item_name_english ?? '').includes(q) ||
      (item.item_code ?? '').toLowerCase().includes(query.trim().toLowerCase())
    );
  }, [items, query]);

  const count = Math.min(Math.max(parseInt(quantity, 10) || 0, 0), 500);
  // The picked item's cartons already on the open list (read live: the
  // camera is paused under this screen, so it holds still while he types).
  const listed = selected ? onList?.(selected) ?? null : null;
  const onListNow = listed && listed.total > 0 ? listed : null;

  /** Pick an item off the invoice. With some of it already on the list, the
   *  count opens on the rest of the line ("3 on the list — how many MORE?"),
   *  never on a figure that counts those 3 again. */
  function pickItem(item: CartonItemOption) {
    setSelected(item);
    const ctx = onList?.(item);
    if (ctx && ctx.total > 0) setQuantity(String(ctx.quantity));
    setStep('form');
  }
  // Counted at this weight (countOnSave): a carton with none can't be booked
  // (the bot skips a box with no weight), so Save waits for one.
  const weightMissing = countOnSave && !(Number(weight) > 0);
  // The label prints these dates: a refused expiry (on/before today or on/
  // before the production date) blocks Save; a blank one never does.
  const dateError = validateCartonDates({ production: productionDate, expiry: expiryDate, receiptDate: localIsoDate() }).expiryError;
  // A preset (short item code) carton has no sticker to read the date off
  // later, so its expiry is required.
  const expiryMissing = !!preset && !expiryDate;

  // The preview is the real sticker component fed placeholder identifiers, so
  // what the worker approves is what comes out of the printer.
  const previewLabel: CartonLabel | null = selected && {
    id: 'preview',
    batch_id: 'preview',
    barcode: '2800000000000000',
    serial: 'C-000000-0000',
    session_token: null,
    document_number: null,
    item_code: selected.item_code ?? null,
    item_name_hebrew: selected.item_name_hebrew ?? null,
    item_name_english: selected.item_name_english ?? null,
    weight_kg: weight ? Number(weight) || null : null,
    quantity: count || 1,
    production_date: productionDate || null,
    expiry_date: expiryDate || null,
    notes: null,
    print_barcode: printBarcode,
    label_size: '10x15',
    status: 'created',
    print_count: 0,
    printed_at: null,
    created_at: new Date().toISOString(),
    origin: 'new_carton',
    source_barcode: null,
    pallet_number: palletNumber,
  };

  async function handleSave() {
    if (!selected || saving || count < 1 || dateError || weightMissing || expiryMissing) return;
    setSaving(true);
    try {
      const payload = {
        pallet_number: palletNumber,
        item_code: selected.item_code ?? null,
        item_name_hebrew: selected.item_name_hebrew ?? null,
        item_name_english: selected.item_name_english ?? null,
        weight_kg: weight ? Number(weight) : null,
        quantity: count,
        production_date: productionDate || null,
        expiry_date: expiryDate || null,
        notes: notes.trim() || null,
        print_barcode: printBarcode,
      };
      const res = await fetch('/api/carton-labels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, batch_id: batchIdForPayload(batchIdsRef.current, payload), ...payload }),
      });
      const data = await res.json();
      if (res.status === 401) {
        showToast(tr('carton.sessionExpired'), 'error', '#ef8a8a');
        return;
      }
      if (!data?.success) {
        showToast(tr('carton.error'), 'error', '#ef8a8a');
        return;
      }
      const labels: CartonLabel[] = Array.isArray(data.labels) ? data.labels : [];
      onCreated?.(labels.length || count, data.batch_id ?? null, labels);
    } catch {
      showToast(tr('carton.error'), 'error', '#ef8a8a');
    } finally {
      setSaving(false);
    }
  }

  const fieldLabel = 'text-[10px] font-extrabold tracking-[1px] text-brand-weak-ink mb-[7px] mx-[2px]';
  const tile = 'bg-tile border border-line rounded-[12px]';

  return (
    <ScreenOverlay title={tr('carton.title')} onBack={onBack}>
      {step === 'item' ? (
        <>
          <div className="flex-none px-3 pt-3 pb-2">
            <p className="text-[11px] font-bold text-ink-muted mb-2 leading-[1.45]">
              {tr('carton.pickItemHint')}
            </p>
            <div className="flex items-center gap-2 bg-search-bg border border-search-border rounded-[11px] px-3 h-[42px]">
              <MI name="search" size={18} className="text-search-ink" />
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder={tr('carton.searchPlaceholder')}
                className="flex-1 min-w-0 bg-transparent outline-none text-[13px] font-bold text-ink-inverse placeholder:text-search-ink"
              />
            </div>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-4 flex flex-col gap-2">
            {items.length === 0 ? (
              <p className="text-[12px] font-bold text-ink-muted text-center mt-8">{tr('carton.noItems')}</p>
            ) : filtered.length === 0 ? (
              <p className="text-[12px] font-bold text-ink-muted text-center mt-8">{tr('carton.noMatches')}</p>
            ) : (
              filtered.map((item, i) => (
                <button
                  key={`${item.item_code ?? ''}-${i}`}
                  onClick={() => pickItem(item)}
                  className={`${tile} w-full px-3 py-[13px] text-start flex items-center gap-3`}
                >
                  <span className="flex-1 min-w-0">
                    <span className="block text-[14px] font-extrabold text-ink-inverse truncate">
                      {item.item_name_hebrew || item.item_name_english}
                    </span>
                    {item.item_code ? (
                      <span className="block text-[10.5px] font-bold text-ink-muted mt-[2px]">
                        {tr('carton.itemCode', { code: item.item_code })}
                      </span>
                    ) : null}
                  </span>
                  <MI name="chevron_left" size={20} className="text-ink-muted" />
                </button>
              ))
            )}
          </div>
        </>
      ) : (
        <>
          <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3 flex flex-col gap-[13px]">
            {preset?.notice ? (
              <p role="status" className="flex items-start gap-[6px] rounded-[12px] border border-brand/50 bg-brand-weak px-3 py-[9px] text-[12px] font-bold leading-[1.45] text-brand-weak-ink">
                <MI name="info" size={16} className="flex-none mt-[1px]" />
                <span className="min-w-0">{preset.notice}</span>
              </p>
            ) : null}
            {/* Chosen item + a way back to the picker */}
            <button
              onClick={() => setStep('item')}
              className={`${tile} w-full px-3 py-[12px] flex items-center gap-3 text-start`}
            >
              <span className="flex-1 min-w-0">
                <span className="block text-[15px] font-extrabold text-ink-inverse truncate">
                  {selected?.item_name_hebrew || selected?.item_name_english}
                </span>
                <span className="block text-[10.5px] font-bold text-brand-weak-ink mt-[2px]">
                  {tr('carton.changeItem')}
                </span>
              </span>
              <MI name="swap_horiz" size={20} className="text-brand-weak-ink" />
            </button>

            {/* Cartons */}
            <div>
              <div className={fieldLabel}>{tr(onListNow ? 'carton.quantityMore' : 'carton.quantity')}</div>
              {onListNow && (
                // Above the count, where he looks before typing: what is on
                // the list already, so the same cartons are not counted twice.
                <p role="status" className="flex items-start gap-[6px] mb-[8px] rounded-[12px] border border-brand/50 bg-brand-weak px-3 py-[9px] text-[12px] font-bold leading-[1.45] text-brand-weak-ink">
                  <MI name="checklist" size={16} className="flex-none mt-[1px]" />
                  <span className="min-w-0">
                    {onListNow.total === 1
                      ? tr('carton.onListHintOne')
                      : tr('carton.onListHint', { count: onListNow.total })}
                    {onListNow.noBarcode > 0 && <> {tr('carton.onListNoBarcode', { count: onListNow.noBarcode })}</>}
                    {onListNow.lineTotal !== null && onListNow.left !== null && (
                      <> {tr('carton.onListLeft', { total: onListNow.lineTotal, left: onListNow.left })}</>
                    )}
                  </span>
                </p>
              )}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setQuantity(String(Math.max(1, count - 1)))}
                  className={`${tile} w-[52px] h-[52px] flex items-center justify-center text-ink-inverse`}
                  aria-label="-"
                >
                  <MI name="remove" size={22} />
                </button>
                <input
                  value={quantity}
                  onChange={e => setQuantity(e.target.value.replace(/\D/g, '').slice(0, 3))}
                  inputMode="numeric"
                  className={`${tile} flex-1 min-w-0 h-[52px] text-center bg-tile outline-none text-[20px] font-extrabold text-ink-inverse font-mono`}
                />
                <button
                  onClick={() => setQuantity(String(Math.min(500, count + 1)))}
                  className={`${tile} w-[52px] h-[52px] flex items-center justify-center text-ink-inverse`}
                  aria-label="+"
                >
                  <MI name="add" size={22} />
                </button>
              </div>
              <p className="text-[10.5px] font-semibold text-ink-muted mt-[6px] mx-[2px] leading-[1.45]">
                {tr('carton.quantityHint')}
              </p>
              {preset?.lineTotal ? (
                <p className="text-[10.5px] font-semibold text-ink-muted mt-[2px] mx-[2px] leading-[1.45]">
                  {tr('carton.lineTotalHint', { total: preset.lineTotal })}
                </p>
              ) : null}
              {onListNow && onListNow.lineTotal !== null && count + onListNow.total > onListNow.lineTotal && (
                // Says it, never stops him: the note can be wrong too.
                <p className="flex items-start gap-[5px] text-[11px] font-bold text-warn-weak-ink mt-[6px] mx-[2px] leading-[1.45]">
                  <MI name="report_problem" size={15} className="flex-none mt-[1px]" />
                  <span className="min-w-0">
                    {tr('carton.onListOver', { sum: count + onListNow.total, total: onListNow.lineTotal })}
                  </span>
                </p>
              )}
            </div>

            {/* Weight */}
            <div>
              <div className={fieldLabel}>
                {tr('carton.weight')}{' '}
                {!countOnSave && <span className="text-ink-muted font-bold">· {tr('carton.optional')}</span>}
              </div>
              <input
                value={weight}
                onChange={e => setWeight(e.target.value.replace(/[^\d.]/g, '').slice(0, 7))}
                inputMode="decimal"
                dir="ltr"
                placeholder="0.00"
                className={`${tile} w-full h-[52px] px-3 bg-tile outline-none text-[18px] font-extrabold text-ink-inverse font-mono placeholder:text-search-ink`}
              />
            </div>

            {/* Dates */}
            <div className="flex gap-2">
              {([
                { field: 'production' as DateField, label: tr('carton.production'), value: productionDate, clear: () => setProductionDate(''), clearLabel: tr('terminal.clearProduction') },
                { field: 'expiry' as DateField, label: tr('carton.expiry'), value: expiryDate, clear: () => setExpiryDate(''), clearLabel: tr('terminal.clearExpiry') },
              ]).map(d => {
                const bad = d.field === 'expiry' && !!dateError;
                return (
                  <div key={d.field} className="flex-1 min-w-0">
                    <div className={fieldLabel}>{d.label}</div>
                    <div className="relative">
                      <button
                        onClick={() => setCalendarFor(d.field)}
                        className={`${bad ? 'bg-tile border-2 border-danger rounded-[12px]' : tile} w-full h-[52px] ps-3 pe-[38px] flex items-center gap-2 text-start`}
                      >
                        <MI name="event" size={18} className={bad ? 'text-danger' : 'text-brand-weak-ink'} />
                        <span
                          dir="ltr"
                          className={`flex-1 min-w-0 truncate font-mono text-[14px] font-extrabold ${bad ? 'text-danger-weak-ink' : d.value ? 'text-ink-inverse' : 'text-search-ink'}`}
                        >
                          {d.value ? displayDate(d.value) : '—'}
                        </span>
                      </button>
                      {/* Clearing is always allowed: "no expiry" never blocks. */}
                      {d.value && (
                        <button
                          onClick={d.clear}
                          aria-label={d.clearLabel}
                          title={d.clearLabel}
                          className="absolute top-1/2 -translate-y-1/2 end-[6px] flex items-center justify-center w-[30px] h-[30px] rounded-full text-ink-muted"
                        >
                          <MI name="close" size={16} />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            {dateError && (
              <p role="alert" className="-mt-[6px] flex items-start gap-[5px] text-[11px] font-extrabold text-danger-weak-ink mx-[2px]">
                <MI name="error" size={15} className="flex-none mt-[1px]" />
                <span className="min-w-0">{tr(dateError)}</span>
              </p>
            )}

            {/* Barcode toggle — default on, because a sticker without bars
                cannot be scanned into stock. */}
            <button
              onClick={() => setPrintBarcode(v => !v)}
              className={`${tile} w-full px-[14px] py-[13px] flex items-start gap-[10px] text-start`}
            >
              <MI name="density_medium" size={20} className="text-ink-inverse mt-[2px]" />
              <span className="flex-1 min-w-0">
                <span className="block text-[14px] font-extrabold text-ink-inverse">{tr('carton.withBarcode')}</span>
                <span className="block text-[10.5px] font-semibold text-ink-muted mt-[3px] leading-[1.45]">
                  {tr('carton.withBarcodeHint')}
                </span>
              </span>
              <span
                className="flex-none w-[40px] h-[24px] rounded-full px-[3px] flex items-center transition-colors mt-[2px]"
                style={{
                  background: printBarcode ? '#13a4ec' : '#2a3a47',
                  justifyContent: printBarcode ? 'flex-end' : 'flex-start',
                }}
              >
                <span className="block w-[18px] h-[18px] rounded-full bg-white" />
              </span>
            </button>

            {/* Note */}
            <div>
              <div className={fieldLabel}>
                {tr('carton.notes')} <span className="text-ink-muted font-bold">· {tr('carton.optional')}</span>
              </div>
              <input
                value={notes}
                onChange={e => setNotes(e.target.value.slice(0, 200))}
                placeholder={tr('carton.notesPlaceholder')}
                className={`${tile} w-full h-[52px] px-3 bg-tile outline-none text-[13px] font-bold text-ink-inverse placeholder:text-search-ink`}
              />
            </div>

            {/* Preview of the physical sticker */}
            {previewLabel ? (
              <div>
                <div className={fieldLabel}>{tr('carton.preview')}</div>
                <div className="rounded-[12px] overflow-hidden border border-line" style={{ height: 190 }}>
                  <CartonSticker label={previewLabel} fontSize="9px" />
                </div>
                <p className="text-[10.5px] font-semibold text-ink-muted mt-[8px] mx-[2px] leading-[1.45]">
                  {tr('carton.printedNote')}
                </p>
              </div>
            ) : null}
          </div>

          <div className="flex-none px-3 py-[11px] border-t border-line bg-header safe-bottom">
            {countOnSave && (
              <p className="flex items-start gap-1.5 mb-[9px] text-[11.5px] font-bold leading-snug text-ink-muted">
                <MI name="inventory_2" size={16} className="shrink-0 mt-px" />
                <span className="min-w-0">{tr(weightMissing ? 'carton.countOnSaveNeedWeight' : 'carton.countOnSaveNote')}</span>
              </p>
            )}
            {expiryMissing && (
              <p className="flex items-start gap-1.5 mb-[9px] text-[11.5px] font-bold leading-snug text-warn-weak-ink">
                <MI name="event" size={16} className="shrink-0 mt-px" />
                <span className="min-w-0">{tr('carton.shortCodeNeedExpiry')}</span>
              </p>
            )}
            {notCountedWarning && !countOnSave && (
              <p className="flex items-start gap-1.5 mb-[9px] text-[11.5px] font-bold leading-snug text-warn-weak-ink">
                <MI name="warning" size={16} className="shrink-0 mt-px" />
                <span className="min-w-0">{tr('carton.notCountedWarning')}</span>
              </p>
            )}
            <button
              onClick={handleSave}
              disabled={saving || count < 1 || !!dateError || weightMissing || expiryMissing}
              className="w-full h-[50px] rounded-[12px] bg-brand text-white text-[14px] font-black flex items-center justify-center gap-2 disabled:opacity-50"
            >
              <MI name="save" size={20} />
              {saving
                ? tr('carton.saving')
                : count === 1
                  ? tr('carton.saveOne')
                  : tr('carton.save', { count })}
            </button>
          </div>
        </>
      )}

      {calendarFor ? (
        <CalendarPicker
          value={calendarFor === 'production' ? productionDate : expiryDate}
          fieldTitle={calendarFor === 'production' ? tr('carton.production') : tr('carton.expiry')}
          // Never a silent "today": an empty date opens with no day chosen
          // and OK disabled until the worker picks one off the sticker.
          requirePick
          onPick={iso => {
            if (calendarFor === 'production') setProductionDate(iso);
            else setExpiryDate(iso);
            setCalendarFor(null);
          }}
          onClose={() => setCalendarFor(null)}
        />
      ) : null}

      <Toast toast={toast} />
    </ScreenOverlay>
  );
}
