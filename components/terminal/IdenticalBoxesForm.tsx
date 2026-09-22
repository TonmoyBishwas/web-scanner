'use client';

/**
 * כל הקרטונים זהים — "All boxes identical → print labels".
 *
 * Opened from a captured row on pallet-verify (pallet or loose phase) when
 * the WORKER says every carton of this product is the same: same supplier
 * barcode, same name, same weight, same dates. Nothing in the system offers
 * this from the barcode's shape.
 *
 * Step `form`: the sample's OCR prefills weight / dates; the worker corrects
 * them and types the count. Create → POST /api/carton-labels mints N unique
 * barcodes (origin `identical`). Step `created`: print the sheet (opened
 * synchronously in the click so pop-up blockers let it through) or reprint
 * later from the Labels chip. The page turns the sample row into N rows via
 * lib/identical-boxes.ts — those rows ARE the stock; no scanning back in.
 */

import { useState } from 'react';
import { MI } from './MI';
import { ScreenOverlay } from './ScreenOverlay';
import { CalendarPicker } from './CalendarPicker';
import { CartonSticker } from './CartonSticker';
import { Toast, useToast } from './Toast';
import { useT } from '@/lib/i18n';
import type { IdenticalForm } from '@/lib/identical-boxes';
import type { CartonLabel, Language } from '@/types';

export interface IdenticalSample {
  barcode: string;
  item_code?: string | null;
  item_name: string;
  item_name_hebrew: string;
  weight: number;
  /** `DD/MM/YYYY` as the scan row stores it ('' when unknown). */
  expiry: string;
  /** `YYYY-MM-DD` ('' when unknown). */
  production_date: string;
}

interface IdenticalBoxesFormProps {
  token: string;
  language: Language;
  /** Pallet the batch is minted on; 0 = the loose pile. */
  palletNumber: number;
  sample: IdenticalSample;
  onBack: () => void;
  /** The batch exists in carton_labels; the page expands the sample row. */
  onCreated: (labels: CartonLabel[], form: IdenticalForm) => void;
  /** Worker closed the created screen (after printing or not). */
  onDone: () => void;
}

type DateField = 'production' | 'expiry';

const ddmmyyyyToIso = (v: string): string => {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec((v || '').trim());
  if (!m) return /^\d{4}-\d{2}-\d{2}$/.test((v || '').trim()) ? v.trim() : '';
  return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
};
const isoToDdmmyyyy = (iso: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
};

export function IdenticalBoxesForm({
  token, language, palletNumber, sample, onBack, onCreated, onDone,
}: IdenticalBoxesFormProps) {
  const tr = useT();
  const { toast, showToast } = useToast();

  const [quantity, setQuantity] = useState('');
  const [weight, setWeight] = useState(sample.weight > 0 ? String(sample.weight) : '');
  const [productionDate, setProductionDate] = useState(ddmmyyyyToIso(sample.production_date));
  const [expiryDate, setExpiryDate] = useState(ddmmyyyyToIso(sample.expiry));
  const [calendarFor, setCalendarFor] = useState<DateField | null>(null);
  const [saving, setSaving] = useState(false);
  const [created, setCreated] = useState<CartonLabel[] | null>(null);

  const count = Math.min(Math.max(parseInt(quantity, 10) || 0, 0), 500);
  const weightKg = Number(weight);
  const weightOk = Number.isFinite(weightKg) && weightKg > 0 && weightKg <= 2000;
  const canCreate = !saving && count >= 1 && weightOk;
  const name = sample.item_name_hebrew || sample.item_name;

  const previewLabel: CartonLabel = {
    id: 'preview',
    batch_id: 'preview',
    barcode: '2800000000000000',
    serial: 'C-000000-0000',
    session_token: null,
    document_number: null,
    item_code: sample.item_code ?? null,
    item_name_hebrew: sample.item_name_hebrew || null,
    item_name_english: sample.item_name || null,
    weight_kg: weightOk ? weightKg : null,
    quantity: count || 1,
    production_date: productionDate || null,
    expiry_date: expiryDate || null,
    notes: null,
    print_barcode: true,
    label_size: '10x15',
    status: 'created',
    print_count: 0,
    printed_at: null,
    created_at: new Date().toISOString(),
    origin: 'identical',
    source_barcode: sample.barcode,
    pallet_number: palletNumber,
  };

  async function handleCreate() {
    if (!canCreate) return;
    setSaving(true);
    try {
      const res = await fetch('/api/carton-labels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          origin: 'identical',
          source_barcode: sample.barcode,
          pallet_number: palletNumber,
          item_code: sample.item_code ?? null,
          item_name_hebrew: sample.item_name_hebrew || null,
          item_name_english: sample.item_name || null,
          weight_kg: weightKg,
          quantity: count,
          production_date: productionDate || null,
          expiry_date: expiryDate || null,
          print_barcode: true,
        }),
      });
      const data = await res.json();
      if (res.status === 401) {
        showToast(tr('carton.sessionExpired'), 'error', '#ef8a8a');
        return;
      }
      const labels: CartonLabel[] = Array.isArray(data?.labels) ? data.labels : [];
      if (!data?.success || labels.length === 0) {
        showToast(tr('identical.error'), 'error', '#ef8a8a');
        return;
      }
      setCreated(labels);
      onCreated(labels, {
        weight: weightKg,
        expiry: expiryDate ? isoToDdmmyyyy(expiryDate) : '',
        production_date: productionDate || '',
      });
    } catch {
      showToast(tr('identical.error'), 'error', '#ef8a8a');
    } finally {
      setSaving(false);
    }
  }

  function handlePrint() {
    if (!created?.length) return;
    const batchId = created[0].batch_id;
    // Opened synchronously inside the click — a window.open after an awaited
    // fetch is what pop-up blockers kill.
    const url =
      `/labels/print?token=${encodeURIComponent(token)}` +
      `&batches=${encodeURIComponent(batchId)}&size=10x15&lang=${encodeURIComponent(language)}`;
    const win = window.open(url, '_blank');
    if (!win) {
      showToast(tr('labels.printBlocked'), 'error', '#ef8a8a');
      return;
    }
    fetch('/api/carton-labels/print', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, batch_ids: [batchId], label_size: '10x15' }),
    })
      .then((r) => r.json())
      .then((data) => { if (data?.success) showToast(tr('labels.printSent', { count: created.length }), 'print'); })
      .catch(() => { /* the sheet is already open; the ledger just missed the flag */ });
  }

  const fieldLabel = 'text-[10px] font-extrabold tracking-[1px] text-brand-weak-ink mb-[7px] mx-[2px]';
  const tile = 'bg-tile border border-line rounded-[12px]';

  if (created) {
    return (
      <ScreenOverlay title={tr('identical.title')} onBack={onDone}>
        <div className="flex-1 min-h-0 overflow-y-auto px-3 py-4 flex flex-col gap-[13px]">
          <div className={`${tile} px-[14px] py-[14px] flex items-start gap-3`}>
            <MI name="check_circle" size={24} className="text-[#22c55e] mt-[1px]" />
            <span className="flex-1 min-w-0">
              <span className="block text-[15px] font-extrabold text-ink-inverse">
                {tr('identical.createdTitle', { count: created.length })}
              </span>
              <span className="block text-[11px] font-semibold text-ink-muted mt-[4px] leading-[1.45]">
                {tr('identical.createdHint', { name })}
              </span>
            </span>
          </div>
          <div>
            <div className={fieldLabel}>{tr('carton.preview')}</div>
            <div className="rounded-[12px] overflow-hidden border border-line" style={{ height: 190 }}>
              <CartonSticker label={created[0]} fontSize="9px" />
            </div>
          </div>
        </div>
        <div className="flex-none px-3 py-[11px] border-t border-line bg-header safe-bottom flex flex-col gap-2">
          <button
            onClick={handlePrint}
            className="w-full h-[50px] rounded-[12px] bg-brand text-white text-[14px] font-black flex items-center justify-center gap-2"
          >
            <MI name="print" size={20} />
            {tr('identical.print', { count: created.length })}
          </button>
          <button
            onClick={onDone}
            className={`${tile} w-full h-[46px] text-[13px] font-extrabold text-ink-inverse flex items-center justify-center gap-2`}
          >
            <MI name="done" size={18} />
            {tr('common.done')}
          </button>
        </div>
        <Toast toast={toast} />
      </ScreenOverlay>
    );
  }

  return (
    <ScreenOverlay title={tr('identical.title')} onBack={onBack}>
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3 flex flex-col gap-[13px]">
        <div className={`${tile} px-3 py-[12px]`}>
          <span className="block text-[15px] font-extrabold text-ink-inverse truncate">{name}</span>
          <span dir="ltr" className="block text-[10.5px] font-bold text-ink-muted mt-[2px] font-mono text-start">
            {sample.barcode}
          </span>
          <span className="block text-[11px] font-semibold text-ink-muted mt-[6px] leading-[1.45]">
            {tr('identical.intro')}
          </span>
        </div>

        {/* Count */}
        <div>
          <div className={fieldLabel}>{tr('identical.quantity')}</div>
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
              onChange={(e) => setQuantity(e.target.value.replace(/\D/g, '').slice(0, 3))}
              inputMode="numeric"
              placeholder="0"
              autoFocus
              className={`${tile} flex-1 h-[52px] text-center bg-tile outline-none text-[20px] font-extrabold text-ink-inverse font-mono placeholder:text-search-ink`}
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
            {tr('identical.quantityHint')}
          </p>
        </div>

        {/* Weight */}
        <div>
          <div className={fieldLabel}>{tr('carton.weight')}</div>
          <input
            value={weight}
            onChange={(e) => setWeight(e.target.value.replace(/[^\d.]/g, '').slice(0, 7))}
            inputMode="decimal"
            dir="ltr"
            placeholder="0.00"
            className={`${tile} w-full h-[52px] px-3 bg-tile outline-none text-[18px] font-extrabold text-ink-inverse font-mono placeholder:text-search-ink`}
          />
          {!weightOk && weight !== '' && (
            <p className="text-[10.5px] font-semibold text-danger-weak-ink mt-[6px] mx-[2px]">{tr('identical.weightInvalid')}</p>
          )}
        </div>

        {/* Dates */}
        <div className="flex gap-2">
          {([
            { field: 'production' as DateField, label: tr('carton.production'), value: productionDate },
            { field: 'expiry' as DateField, label: tr('carton.expiry'), value: expiryDate },
          ]).map((d) => (
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
                  {d.value ? isoToDdmmyyyy(d.value) : '—'}
                </span>
              </button>
            </div>
          ))}
        </div>

        {/* Preview of the physical sticker */}
        <div>
          <div className={fieldLabel}>{tr('carton.preview')}</div>
          <div className="rounded-[12px] overflow-hidden border border-line" style={{ height: 190 }}>
            <CartonSticker label={previewLabel} fontSize="9px" />
          </div>
          <p className="text-[10.5px] font-semibold text-ink-muted mt-[8px] mx-[2px] leading-[1.45]">
            {tr('identical.printedNote')}
          </p>
        </div>
      </div>

      <div className="flex-none px-3 py-[11px] border-t border-line bg-header safe-bottom">
        <button
          onClick={handleCreate}
          disabled={!canCreate}
          className="w-full h-[50px] rounded-[12px] bg-brand text-white text-[14px] font-black flex items-center justify-center gap-2 disabled:opacity-50"
        >
          <MI name="label" size={20} />
          {saving ? tr('carton.creating') : tr('identical.create', { count })}
        </button>
      </div>

      {calendarFor ? (
        <CalendarPicker
          value={calendarFor === 'production' ? productionDate : expiryDate}
          fieldTitle={calendarFor === 'production' ? tr('carton.production') : tr('carton.expiry')}
          onPick={(iso) => {
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
