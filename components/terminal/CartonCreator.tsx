'use client';

/**
 * צור קרטון — New carton.
 *
 * A carton turns up with no supplier sticker, or one too torn to read. The
 * worker picks the item off THIS delivery's invoice, types what the missing
 * sticker would have said, and the scanner mints one sticker per carton with
 * its own barcode. Printing happens on the Labels screen.
 *
 * Creating stickers books no stock and touches no delivery, pallet or box
 * record. The worker prints the sticker, puts it on the carton, and scans it
 * through the ordinary receiving flow — so the meat and non-meat inbound paths
 * are untouched by this feature.
 */

import { useMemo, useState } from 'react';
import { MI } from './MI';
import { ScreenOverlay } from './ScreenOverlay';
import { CalendarPicker } from './CalendarPicker';
import { CartonSticker } from './CartonSticker';
import { Toast, useToast } from './Toast';
import { useT } from '@/lib/i18n';
import { normalizeString } from '@/lib/string-utils';
import type { CartonLabel } from '@/types';

/** The subset of an invoice line this screen needs, shared by both session shapes. */
export interface CartonItemOption {
  item_code?: string;
  item_name_english?: string;
  item_name_hebrew?: string;
}

interface CartonCreatorProps {
  token: string;
  items: CartonItemOption[];
  onBack: () => void;
  /** Fired after a batch is created — the page uses it to open Labels. */
  onCreated?: (count: number) => void;
}

type Step = 'item' | 'form';
type DateField = 'production' | 'expiry';

function displayDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

export function CartonCreator({ token, items, onBack, onCreated }: CartonCreatorProps) {
  const tr = useT();
  const { toast, showToast } = useToast();

  const [step, setStep] = useState<Step>('item');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<CartonItemOption | null>(null);

  const [quantity, setQuantity] = useState('1');
  const [weight, setWeight] = useState('');
  const [productionDate, setProductionDate] = useState('');
  const [expiryDate, setExpiryDate] = useState('');
  const [notes, setNotes] = useState('');
  const [printBarcode, setPrintBarcode] = useState(true);
  const [calendarFor, setCalendarFor] = useState<DateField | null>(null);
  const [saving, setSaving] = useState(false);

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
  };

  async function handleCreate() {
    if (!selected || saving || count < 1) return;
    setSaving(true);
    try {
      const res = await fetch('/api/carton-labels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          item_code: selected.item_code ?? null,
          item_name_hebrew: selected.item_name_hebrew ?? null,
          item_name_english: selected.item_name_english ?? null,
          weight_kg: weight ? Number(weight) : null,
          quantity: count,
          production_date: productionDate || null,
          expiry_date: expiryDate || null,
          notes: notes.trim() || null,
          print_barcode: printBarcode,
        }),
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
      onCreated?.(data.labels?.length ?? count);
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
                  onClick={() => { setSelected(item); setStep('form'); }}
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
              <div className={fieldLabel}>{tr('carton.quantity')}</div>
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
                  className={`${tile} flex-1 h-[52px] text-center bg-tile outline-none text-[20px] font-extrabold text-ink-inverse font-mono`}
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
            </div>

            {/* Weight */}
            <div>
              <div className={fieldLabel}>
                {tr('carton.weight')} <span className="text-ink-muted font-bold">· {tr('carton.optional')}</span>
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
                { field: 'production' as DateField, label: tr('carton.production'), value: productionDate },
                { field: 'expiry' as DateField, label: tr('carton.expiry'), value: expiryDate },
              ]).map(d => (
                <div key={d.field} className="flex-1 min-w-0">
                  <div className={fieldLabel}>{d.label}</div>
                  <button
                    onClick={() => setCalendarFor(d.field)}
                    className={`${tile} w-full h-[52px] px-3 flex items-center gap-2 text-start`}
                  >
                    <MI name="event" size={18} className="text-brand-weak-ink" />
                    <span
                      dir="ltr"
                      className={`flex-1 min-w-0 truncate font-mono text-[14px] font-extrabold ${d.value ? 'text-ink-inverse' : 'text-search-ink'}`}
                    >
                      {d.value ? displayDate(d.value) : '—'}
                    </span>
                  </button>
                </div>
              ))}
            </div>

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
            <button
              onClick={handleCreate}
              disabled={saving || count < 1}
              className="w-full h-[50px] rounded-[12px] bg-brand text-white text-[14px] font-black flex items-center justify-center gap-2 disabled:opacity-50"
            >
              <MI name="label" size={20} />
              {saving
                ? tr('carton.creating')
                : count === 1
                  ? tr('carton.createOne')
                  : tr('carton.create', { count })}
            </button>
          </div>
        </>
      )}

      {calendarFor ? (
        <CalendarPicker
          value={calendarFor === 'production' ? productionDate : expiryDate}
          fieldTitle={calendarFor === 'production' ? tr('carton.production') : tr('carton.expiry')}
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
