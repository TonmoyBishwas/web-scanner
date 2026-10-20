'use client';

/**
 * כל הקרטונים זהים — "All boxes identical → save labels".
 *
 * Opened from a captured row on pallet-verify (pallet or loose phase) when
 * the WORKER says every carton of this product is the same: same supplier
 * barcode, same name, same weight, same dates. Nothing in the system offers
 * this from the barcode's shape.
 *
 * The sample's OCR prefills weight / dates; the worker corrects them and
 * types the count. "Save N labels" → POST /api/carton-labels mints N unique
 * barcodes (origin `identical`) and the page turns the sample row into N rows
 * via lib/identical-boxes.ts — those rows ARE the stock; no scanning back in.
 * The form then closes straight back to the scanner. Printing is a separate,
 * later step from the Labels chip (amber badge until it happens): the floor
 * saves several products and prints them together, any time before the
 * pallet is closed.
 *
 * Also opened from "Another carton — add it" on an already-on-the-list
 * notice (`anotherOf`): the carton in hand carries a label byte-identical to
 * a carton already on the list. Same form and same save, worded for that
 * case; the page adds the new rows and keeps the counted one.
 *
 * Both ask for the TOTAL when cartons of this kind are already on the list
 * (`listed`, 19/10): "How many cartons with this label are there in total?",
 * with a live "19 will be added · 1 already on the list". It used to ask how
 * many MORE, and the invoice's 20 typed there made 21 (IN264191356). What is
 * saved is the difference (lib/identical-boxes.ts labelsToSave).
 *
 * Label printing off (LABEL_PRINTING_ENABLED, lib/label-printing.ts — the
 * default since 20/10): the intro (it promises a printed label) and the
 * sticker preview with its "Print the labels from Labels" note are hidden.
 */

import { useRef, useState } from 'react';
import { MI } from './MI';
import { ScreenOverlay } from './ScreenOverlay';
import { CalendarPicker } from './CalendarPicker';
import { CartonSticker } from './CartonSticker';
import { Toast, useToast } from './Toast';
import { useT } from '@/lib/i18n';
import { identicalLabelPayload, labelsToSave, postIdenticalLabels, type IdenticalForm } from '@/lib/identical-boxes';
import { toIsoDate, isoToDdmmyyyy } from '@/lib/expiry';
import { labelPrintingEnabled } from '@/lib/label-printing';
import { validateCartonDates } from '@/lib/date-validation';
import { localIsoDate } from '@/lib/edit-panel-state';
import { batchIdForPayload } from '@/lib/label-batches';
import type { CartonLabel } from '@/types';

export interface IdenticalSample {
  barcode: string;
  item_code?: string | null;
  item_name: string;
  item_name_hebrew: string;
  weight: number;
  /** `YYYY-MM-DD` as the scan row stores it; `DD/MM/YYYY` tolerated ('' when unknown). */
  expiry: string;
  /** `YYYY-MM-DD` ('' when unknown). */
  production_date: string;
}

interface IdenticalBoxesFormProps {
  token: string;
  /** Pallet the batch is minted on; 0 = the loose pile. */
  palletNumber: number;
  sample: IdenticalSample;
  /**
   * "Different carton?": the list number of the counted carton this one's
   * label matches. Starts the count at 1 and says what is happening.
   */
  anotherOf?: number;
  /**
   * The sample's weight is doubted (lib/weight-sanity.ts): what looks odd
   * about it, shown by the weight field while it still holds that weight.
   * The form is never hidden for a doubt — saving the weight shown here
   * confirms it for every label (lib/identical-boxes.ts weight_confirmed).
   */
  weightDoubt?: string;
  /**
   * Cartons of this kind already on the list that stay on it: the form then
   * asks for the total and saves only the rest. A twin (`anotherOf`) counts
   * at least its original.
   */
  listed?: number;
  /** The invoice line's carton count, offered as one tap (null: not this list's to offer). */
  lineBoxes?: number | null;
  /**
   * This carton's own code differs from the other cartons with its name on
   * the list (lib/identical-boxes.ts groupSkuMismatch): a soft "make sure it
   * is the same product". Save stays available.
   */
  skuMismatch?: { own: string; other: string };
  /**
   * The carton's code and its read name point at two invoice lines: "which
   * product is it?" with both names. The first option (the code's line, as
   * the carton was booked) is picked until he taps the other.
   */
  productChoice?: {
    ocr: string;
    options: [ProductOption, ProductOption];
  };
  onBack: () => void;
  /**
   * The batch is saved in carton_labels (unprinted). The page expands the
   * sample row and closes this form — there is no second screen.
   */
  onCreated: (labels: CartonLabel[], form: IdenticalForm) => void;
}

export interface ProductOption {
  item_code: string;
  item_name_hebrew: string;
  item_name_english: string;
}

type DateField = 'production' | 'expiry';

const PRINTING = labelPrintingEnabled();

export function IdenticalBoxesForm({
  token, palletNumber, sample, anotherOf, weightDoubt, listed: listedProp, lineBoxes, skuMismatch, productChoice, onBack, onCreated,
}: IdenticalBoxesFormProps) {
  const tr = useT();
  const { toast, showToast } = useToast();

  // Cartons of this kind already on the list. A twin's original always is.
  const listed = Math.max(anotherOf ? 1 : 0, listedProp ?? 0);
  // The number typed is the TOTAL whenever something is already listed.
  const totalMode = listed > 0;
  const [quantity, setQuantity] = useState(anotherOf ? String(listed + 1) : '');
  // "Which product?" — 0 = the code's line (as booked), 1 = the read name's.
  const [pick, setPick] = useState<0 | 1>(0);
  const chosen: ProductOption | null = productChoice ? productChoice.options[pick] : null;
  const [weight, setWeight] = useState(sample.weight > 0 ? String(sample.weight) : '');
  const [productionDate, setProductionDate] = useState(toIsoDate(sample.production_date));
  const [expiryDate, setExpiryDate] = useState(toIsoDate(sample.expiry));
  const [calendarFor, setCalendarFor] = useState<DateField | null>(null);
  const [saving, setSaving] = useState(false);
  // One batch id per distinct save content (lib/label-batches.ts): a retry
  // of the same save after a lost response gets the batch the first attempt
  // saved, never a second set of labels — and a save whose count, weight or
  // dates changed meanwhile is never answered with the old labels.
  const batchIdsRef = useRef(new Map<string, string>());

  const typed = Math.min(Math.max(parseInt(quantity, 10) || 0, 0), 500);
  // What is saved: the total less what is already listed (or the count as typed).
  const count = totalMode ? labelsToSave(typed, listed) : typed;
  const minTyped = totalMode ? listed + 1 : 1;
  const weightKg = Number(weight);
  const weightOk = Number.isFinite(weightKg) && weightKg > 0 && weightKg <= 2000;
  // Every carton this saves carries these dates: a refused expiry (on/before
  // today or on/before the production date) blocks Save; a blank one never does.
  const dateError = validateCartonDates({ production: productionDate, expiry: expiryDate, receiptDate: localIsoDate() }).expiryError;
  const canSave = !saving && count >= 1 && weightOk && !dateError;
  const itemCode = chosen ? chosen.item_code || null : sample.item_code ?? null;
  const nameHe = chosen ? chosen.item_name_hebrew : sample.item_name_hebrew;
  const nameEn = chosen ? chosen.item_name_english : sample.item_name;
  const name = nameHe || nameEn;
  // The doubt is about the weight that was read; once the worker types
  // another one it no longer applies.
  const showDoubt = !!weightDoubt && weightOk && Math.abs(weightKg - sample.weight) < 0.001;

  const previewLabel: CartonLabel = {
    id: 'preview',
    batch_id: 'preview',
    barcode: '2800000000000000',
    serial: 'C-000000-0000',
    session_token: null,
    document_number: null,
    item_code: itemCode,
    item_name_hebrew: nameHe || null,
    item_name_english: nameEn || null,
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

  async function handleSave() {
    if (!canSave) return;
    setSaving(true);
    try {
      // The same save the page's one-tap "Another carton, same label" uses
      // (lib/identical-boxes.ts).
      const payload = identicalLabelPayload({
        sourceBarcode: sample.barcode,
        palletNumber,
        itemCode,
        itemNameHebrew: nameHe,
        itemNameEnglish: nameEn,
        weightKg,
        quantity: count,
        productionDate,
        expiryDate,
      });
      const result = await postIdenticalLabels(token, batchIdForPayload(batchIdsRef.current, payload), payload);
      if (!result.ok) {
        showToast(tr(result.reason === 'session' ? 'carton.sessionExpired' : 'identical.error'), 'error', '#ef8a8a');
        return;
      }
      onCreated(result.labels, {
        weight: weightKg,
        // ISO, like every scan row. This line used to write DD/MM/YYYY, which
        // the bot stored as box_expiry NULL — see lib/expiry.ts.
        expiry: expiryDate || '',
        production_date: productionDate || '',
        // The weight was on screen and the worker saved it: one decision for
        // the whole batch, never a Save per label.
        weight_confirmed: true,
        // He picked the other product in "which product?".
        item: chosen && pick === 1 ? chosen : undefined,
      });
    } finally {
      setSaving(false);
    }
  }

  const fieldLabel = 'text-[10px] font-extrabold tracking-[1px] text-brand-weak-ink mb-[7px] mx-[2px]';
  const tile = 'bg-tile border border-line rounded-[12px]';

  return (
    <ScreenOverlay title={anotherOf ? tr('identical.anotherTitle') : tr('identical.title')} onBack={onBack}>
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3 flex flex-col gap-[13px]">
        <div className={`${tile} px-3 py-[12px]`}>
          <span className="block text-[15px] font-extrabold text-ink-inverse truncate">{name}</span>
          <span dir="ltr" className="block text-[10.5px] font-bold text-ink-muted mt-[2px] font-mono text-start">
            {sample.barcode}
          </span>
          {PRINTING && (
            <span className="block text-[11px] font-semibold text-ink-muted mt-[6px] leading-[1.45]">
              {anotherOf ? tr('identical.anotherIntro', { n: anotherOf }) : tr('identical.intro')}
            </span>
          )}
        </div>

        {/* The code and the read name are two products: ask, never block. */}
        {productChoice && (
          <div role="status" className="rounded-[12px] border border-warn/60 bg-tile px-3 py-[10px]">
            <p className="flex items-start gap-[6px] text-[11.5px] font-bold text-warn-weak-ink leading-[1.45]">
              <MI name="report_problem" size={15} className="flex-none mt-[1px]" />
              <span className="min-w-0">
                {tr('identical.whichProduct', {
                  code: productChoice.options[0].item_name_hebrew || productChoice.options[0].item_name_english,
                  ocr: productChoice.ocr,
                })}
              </span>
            </p>
            <div className="flex gap-2 mt-[8px]">
              {productChoice.options.map((o, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setPick(i as 0 | 1)}
                  aria-pressed={pick === i}
                  className={`flex-1 min-w-0 min-h-[44px] px-2 py-2 rounded-[11px] text-[12px] font-extrabold leading-tight text-center ${
                    pick === i ? 'bg-brand text-white' : 'bg-tile border border-line-strong text-ink-inverse'
                  }`}
                >
                  {o.item_name_hebrew || o.item_name_english || '—'}
                </button>
              ))}
            </div>
          </div>
        )}

        {skuMismatch && !productChoice && (
          <p role="status" className="flex items-start gap-[6px] rounded-[12px] border border-warn/60 bg-tile px-3 py-[9px] text-[11.5px] font-bold text-warn-weak-ink leading-[1.45]">
            <MI name="report_problem" size={15} className="flex-none mt-[1px]" />
            <span dir="auto" className="min-w-0">{tr('identical.skuMismatch', skuMismatch)}</span>
          </p>
        )}

        {/* Count */}
        <div>
          <div className={fieldLabel}>{anotherOf ? tr('identical.anotherQuantity') : tr('identical.quantity')}</div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setQuantity(String(Math.max(minTyped, typed - 1)))}
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
              className={`${tile} flex-1 min-w-0 h-[52px] text-center bg-tile outline-none text-[20px] font-extrabold text-ink-inverse font-mono placeholder:text-search-ink`}
            />
            <button
              onClick={() => setQuantity(String(Math.min(500, Math.max(minTyped, typed + 1))))}
              className={`${tile} w-[52px] h-[52px] flex items-center justify-center text-ink-inverse`}
              aria-label="+"
            >
              <MI name="add" size={22} />
            </button>
          </div>
          {totalMode ? (
            // What the total does, live: added vs already on the list.
            <p role="status" className={`text-[11px] font-bold mt-[6px] mx-[2px] leading-[1.45] ${typed > 0 && count === 0 ? 'text-warn-weak-ink' : typed === 0 ? 'text-ink-muted' : 'text-brand-weak-ink'}`}>
              {typed === 0
                ? tr('identical.totalHint', { listed })
                : count === 0
                ? tr('identical.allListed', { listed })
                : tr(anotherOf ? 'identical.willAdd' : 'identical.willSave', { add: count, listed })}
            </p>
          ) : (
            <p className="text-[10.5px] font-semibold text-ink-muted mt-[6px] mx-[2px] leading-[1.45]">
              {tr('identical.quantityHint')}
            </p>
          )}
          {!!lineBoxes && lineBoxes > listed && typed !== lineBoxes && (
            // The note's figure, one tap — never filled in for him.
            <button
              type="button"
              onClick={() => setQuantity(String(lineBoxes))}
              className="mt-[6px] mx-[2px] inline-flex items-center gap-[4px] min-h-[34px] px-3 rounded-full border border-brand/50 bg-brand-weak text-brand-weak-ink text-[11.5px] font-extrabold"
            >
              <MI name="receipt_long" size={15} />
              {tr('identical.invoiceCount', { count: lineBoxes })}
            </button>
          )}
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
          {showDoubt && (
            <p role="status" className="flex items-start gap-[5px] text-[11px] font-bold text-warn-weak-ink mt-[6px] mx-[2px] leading-[1.45]">
              <MI name="report_problem" size={15} className="flex-none mt-[1px]" />
              <span className="min-w-0">{weightDoubt} {tr('identical.weightDoubtSave')}</span>
            </p>
          )}
        </div>

        {/* Dates */}
        <div className="flex gap-2">
          {([
            { field: 'production' as DateField, label: tr('carton.production'), value: productionDate, clear: () => setProductionDate(''), clearLabel: tr('terminal.clearProduction') },
            { field: 'expiry' as DateField, label: tr('carton.expiry'), value: expiryDate, clear: () => setExpiryDate(''), clearLabel: tr('terminal.clearExpiry') },
          ]).map((d) => {
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
                      {d.value ? isoToDdmmyyyy(d.value) : '—'}
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

        {/* Preview of the physical sticker (printing on only) */}
        {PRINTING && (
          <div>
            <div className={fieldLabel}>{tr('carton.preview')}</div>
            <div className="rounded-[12px] overflow-hidden border border-line" style={{ height: 190 }}>
              <CartonSticker label={previewLabel} fontSize="9px" />
            </div>
            <p className="text-[10.5px] font-semibold text-ink-muted mt-[8px] mx-[2px] leading-[1.45]">
              {tr('identical.saveNote')}
            </p>
          </div>
        )}
      </div>

      <div className="flex-none px-3 py-[11px] border-t border-line bg-header safe-bottom">
        <button
          onClick={handleSave}
          disabled={!canSave}
          className="w-full h-[50px] rounded-[12px] bg-brand text-white text-[14px] font-black flex items-center justify-center gap-2 disabled:opacity-50"
        >
          <MI name="save" size={20} />
          {saving ? tr('carton.saving') : count === 1 ? tr('identical.saveOne') : tr('identical.save', { count })}
        </button>
      </div>

      {calendarFor ? (
        <CalendarPicker
          value={calendarFor === 'production' ? productionDate : expiryDate}
          fieldTitle={calendarFor === 'production' ? tr('carton.production') : tr('carton.expiry')}
          // Never a silent "today": an empty date opens with no day chosen
          // and OK disabled until the worker picks one off the sticker.
          requirePick
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
