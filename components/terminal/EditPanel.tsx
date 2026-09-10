'use client';

import { useState } from 'react';
import Image from 'next/image';
import { MI } from './MI';
import { Keypad } from './Keypad';
import { CalendarPicker } from './CalendarPicker';
import { useT } from '@/lib/i18n';

export interface EditItemChip {
  label: string;
  active: boolean;
  onPick: () => void;
}

interface EditPanelProps {
  cartonNumber: number | string;
  name: string;
  /** Weight as the raw editable string, e.g. "18.45" */
  weight: string;
  /** Expiry as free text (DD/MM/YYYY) */
  expiry: string;
  /** Supplier's own batch/lot code, free text. Often blank — see below. */
  batch: string;
  /**
   * What the carton's own 31-digit barcode says, when it disagrees with the
   * OCR. Offered as a one-tap correction, never applied automatically: the
   * barcode has won every disagreement we have measured, but on 67 cartons
   * from two suppliers that is a hint, not authority. Undefined = agree, or
   * the format carries nothing.
   */
  barcodeWeight?: string;
  barcodeExpiry?: string;
  onUseBarcodeWeight?: () => void;
  onUseBarcodeExpiry?: () => void;
  barcode: string;
  /**
   * This carton has NO identity yet — a manual capture whose printed digits
   * the OCR could not read. The barcode row becomes an input and moves to the
   * top of the panel, because it is the reason the worker is here.
   */
  barcodeEditable?: boolean;
  /** Digits typed so far (only meaningful when `barcodeEditable`). */
  barcodeInput?: string;
  onBarcodeChange?: (v: string) => void;
  /** "There is no readable barcode on this carton" — the escape hatch. */
  onNoBarcode?: () => void;
  /** Invoice item chips for name snapping (design's iField) */
  itemChips?: EditItemChip[];
  imageData?: string;
  onViewImage?: () => void;
  onNameChange: (v: string) => void;
  onWeightChange: (v: string) => void;
  onExpiryChange: (v: string) => void;
  onBatchChange: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
}

type Field = 'weight' | 'name' | 'expiry';

/** A real carton barcode is at least a 13-digit GS1 prefix. */
const MIN_BARCODE_DIGITS = 13;

const ddmmyyyyToIso = (v: string): string => {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v.trim());
  if (!m) return '';
  return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
};
const isoToDdmmyyyy = (iso: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  return `${m[3]}/${m[2]}/${m[1]}`;
};

/**
 * Full-screen carton editor.
 *
 * Layout rule, from the floor: the worker is editing BECAUSE the OCR misread
 * the sticker, so they have to read the sticker and type at the same time. The
 * panel used to live inside the bottom sheet with the live camera above it,
 * which left the photo a 112×86 thumbnail — big enough to prove a photo exists,
 * too small to read Hebrew off a label. So the editor now takes the whole
 * screen (the caller pauses the camera while it is open) and spends everything
 * above the controls on the photo: sticker at the top, values and keypad at the
 * bottom, both visible at once, no alternating between them.
 */
export function EditPanel({
  cartonNumber, name, weight, expiry, batch, barcode, itemChips,
  imageData, onViewImage,
  barcodeWeight, barcodeExpiry, onUseBarcodeWeight, onUseBarcodeExpiry,
  barcodeEditable, barcodeInput = '', onBarcodeChange, onNoBarcode,
  onNameChange, onWeightChange, onExpiryChange, onBatchChange, onSave, onCancel,
}: EditPanelProps) {
  const tr = useT();
  const [field, setField] = useState<Field>('weight');
  const [calOpen, setCalOpen] = useState(false);

  const digits = barcodeInput.replace(/\D/g, '');
  const barcodeReady = digits.length >= MIN_BARCODE_DIGITS;

  const tabStyle = (sel: boolean): React.CSSProperties =>
    sel
      ? { background: 'rgba(19,164,236,.18)', border: '2px solid #13a4ec', boxShadow: '0 0 16px rgba(19,164,236,.5)' }
      : { background: 'rgba(19,164,236,.05)', border: '1.5px solid rgba(19,164,236,.32)' };

  const handleKey = (k: string) => {
    if (k === 'back') { onWeightChange(weight.slice(0, -1)); return; }
    if (k === '.' && weight.includes('.')) return;
    if (weight.replace('.', '').length >= 5) return;
    onWeightChange(weight + k);
  };

  const tab = (f: Field, label: string, value: string, mono: boolean, grow: string) => (
    <button
      onClick={() => setField(f)}
      className={`${grow} min-w-0 text-start rounded-[11px] px-[10px] py-[7px] transition-all`}
      style={tabStyle(field === f)}
    >
      <div className="text-[8px] font-extrabold text-[#e8eef2] tracking-[.5px] whitespace-nowrap overflow-hidden text-ellipsis">
        {label}
      </div>
      <div
        className={`${mono ? 'font-mono' : ''} text-[14px] font-black text-ink-inverse mt-[2px] whitespace-nowrap overflow-hidden text-ellipsis`}
        dir={mono ? 'ltr' : undefined}
      >
        {value}
      </div>
    </button>
  );

  // The barcode's version of a value the OCR read differently. Amber, not red:
  // nothing is wrong yet and nothing is blocked — the worker decides.
  const suggestion = (value: string, onUse: () => void) => (
    <button
      onClick={onUse}
      className="w-full flex items-center justify-between gap-2 rounded-[9px] px-[10px] py-[7px] mb-[10px] border"
      style={{ background: 'rgba(245,158,11,.10)', borderColor: 'rgba(245,158,11,.42)' }}
    >
      <span className="flex items-center gap-[6px] min-w-0">
        <MI name="qr_code_scanner" size={15} style={{ color: '#fbbf5c' }} className="flex-none" />
        <span className="text-[11px] font-extrabold truncate" style={{ color: '#e8d3a8' }}>
          {tr('terminal.barcodeSays', { value })}
        </span>
      </span>
      <span className="flex-none text-[11px] font-black px-[9px] py-[3px] rounded-full"
            style={{ background: '#fbbf5c', color: '#1a1408' }}>
        {tr('terminal.useBarcodeValue')}
      </span>
    </button>
  );

  return (
    <div className="fixed inset-0 z-[80] flex flex-col bg-canvas">
      {/* Top bar */}
      <div className="flex-none flex justify-between items-center gap-2 px-[13px] py-[11px] bg-brand-weak border-b border-[rgba(19,164,236,.2)]">
        <button onClick={onCancel} className="flex-none flex items-center p-1 text-ink-inverse" aria-label="back">
          <MI name="arrow_forward_ios" size={20} />
        </button>
        <div className="flex items-center gap-[7px] min-w-0 flex-1">
          <MI name="document_scanner" size={19} className="text-brand" />
          <div className="text-[12px] font-extrabold text-ink-inverse">
            {tr('terminal.editCarton', { n: cartonNumber })}
          </div>
        </div>
        <button
          onClick={onSave}
          className="flex-none flex items-center gap-[5px] text-[12px] font-extrabold text-ink-inverse bg-brand rounded-full px-[15px] py-[9px]"
        >
          <MI name="check" size={16} />
          {tr('terminal.save')}
        </button>
      </div>

      {/* Sticker photo — everything the controls don't need. `min-h-0` lets it
          shrink on a short screen; the floor stops it collapsing to nothing. */}
      <div className="flex-1 min-h-0 relative bg-black" style={{ minHeight: 132 }}>
        {imageData ? (
          <button
            onClick={onViewImage}
            className="absolute inset-0 w-full h-full"
            aria-label={tr('terminal.viewSticker')}
          >
            <Image src={imageData} alt="" fill sizes="100vw" className="object-contain" unoptimized />
            {onViewImage && (
              <span className="absolute bottom-2 end-2 flex items-center justify-center w-[30px] h-[30px] rounded-[8px] bg-black/65 text-ink-inverse">
                <MI name="zoom_in" size={18} />
              </span>
            )}
          </button>
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-ink-muted">
            <MI name="no_photography" size={30} />
            <span className="text-[11px] font-bold">{tr('terminal.noStickerPhoto')}</span>
          </div>
        )}
      </div>

      {/* Controls — scroll on their own so the photo never gets pushed away. */}
      <div className="flex-none overflow-y-auto" style={{ maxHeight: '62vh' }}>
        {/* Missing identity comes FIRST when it applies: it is why the worker
            is in here, and it is the one value nothing else can supply. */}
        {barcodeEditable && (
          <div
            className="px-[13px] py-3 border-b"
            style={{ background: 'rgba(245,158,11,.08)', borderColor: 'rgba(245,158,11,.42)' }}
          >
            <div className="flex items-center gap-[6px] mb-[7px]">
              <MI name="qr_code_scanner" size={16} style={{ color: '#fbbf5c' }} />
              <span className="text-[11px] font-black" style={{ color: '#e8d3a8' }}>
                {tr('terminal.barcodeMissingTitle')}
              </span>
            </div>
            <p className="text-[11px] font-semibold text-ink-muted mb-[7px]">
              {tr('terminal.barcodeMissingHelp')}
            </p>
            <input
              dir="ltr"
              type="text"
              inputMode="numeric"
              autoFocus
              value={barcodeInput}
              maxLength={40}
              onChange={e => onBarcodeChange?.(e.target.value.replace(/\D/g, ''))}
              className="w-full box-border bg-line border-2 rounded-[10px] px-[12px] py-[10px] font-mono text-[15px] font-bold text-ink-inverse tracking-[1px] outline-none"
              style={{ borderColor: barcodeReady ? '#22c55e' : '#fbbf5c' }}
            />
            <div className="flex items-center justify-between gap-2 mt-[7px]">
              <span
                className="font-mono text-[10px] font-bold"
                style={{ color: barcodeReady ? '#7ee2a8' : '#e8d3a8' }}
              >
                {barcodeReady
                  ? `${digits.length} ✓`
                  : tr('terminal.barcodeDigitsCount', { n: digits.length })}
              </span>
              {onNoBarcode && (
                <button
                  onClick={onNoBarcode}
                  className="text-[11px] font-extrabold underline text-ink-muted"
                >
                  {tr('terminal.barcodeNoneBtn')}
                </button>
              )}
            </div>
          </div>
        )}

        {/* Product data — all three values at a glance, one tap switches field. */}
        <div className="px-[13px] pt-3 pb-[10px]">
          <div className="text-[9px] font-black text-ink-inverse tracking-[.5px] mb-[7px]">
            {tr('terminal.productData')}
          </div>
          <div className="flex gap-[7px]">
            {tab('weight', tr('terminal.netWeight'), `${weight || '0'} ${tr('common.kg')}`, true, 'flex-[1.15]')}
            {tab('name', tr('terminal.itemName'), name || '—', false, 'flex-1')}
            {tab('expiry', tr('terminal.expiryDate'), expiry || '—', true, 'flex-1')}
          </div>
        </div>

        {/* Context input — swaps per selected field. The photo is no longer
            duplicated in here: it is permanently on screen above. */}
        <div className="px-[13px] py-3 border-t border-line" style={{ background: 'linear-gradient(180deg,#0d171d,#0a1015)' }}>
          {field === 'weight' && (
            <>
              {barcodeWeight && onUseBarcodeWeight
                && suggestion(`${barcodeWeight} ${tr('common.kg')}`, onUseBarcodeWeight)}
              <div
                className="flex items-center justify-end gap-[6px] bg-overlay-card border border-line rounded-[10px] px-[14px] py-[8px] mb-[10px]"
                dir="ltr"
              >
                <span className="font-mono font-black text-[30px] text-ink-inverse truncate">{weight || '0'}</span>
                <span className="text-[12px] font-extrabold text-brand-weak-ink">{tr('common.kg')}</span>
              </div>
              <Keypad onKey={handleKey} />
            </>
          )}
          {field === 'name' && (
            <div className="flex flex-col gap-[10px]">
              {itemChips && itemChips.length > 0 && (
                <div className="flex flex-wrap gap-[7px]">
                  {itemChips.map((chip, i) => (
                    <button
                      key={i}
                      onClick={chip.onPick}
                      className="px-3 py-2 rounded-[9px] text-[12px] font-bold border transition-colors"
                      style={chip.active
                        ? { background: 'rgba(19,164,236,.18)', borderColor: '#13a4ec', color: '#7cc9f2' }
                        : { background: '#101821', borderColor: '#1e2a35', color: '#e8eef2' }}
                    >
                      {chip.label}
                    </button>
                  ))}
                </div>
              )}
              <input
                dir="rtl"
                type="text"
                value={name}
                onChange={e => onNameChange(e.target.value)}
                className="w-full box-border bg-line border-2 border-brand rounded-[10px] p-3 text-[13px] font-bold text-ink-inverse outline-none"
              />
            </div>
          )}
          {field === 'expiry' && (
            <>
              {barcodeExpiry && onUseBarcodeExpiry
                && suggestion(barcodeExpiry, onUseBarcodeExpiry)}
              <button
                onClick={() => setCalOpen(true)}
                className="w-full flex flex-col justify-center gap-1 bg-line border-2 border-brand rounded-[12px] px-[13px] py-[11px] text-start"
              >
                <span className="flex items-center gap-2">
                  <MI name="calendar_month" size={19} className="text-brand" />
                  <span className="text-[9px] font-bold text-[#e8eef2] tracking-[.5px]">{tr('terminal.expiryDate')}</span>
                </span>
                <span className="block text-[17px] font-extrabold text-ink-inverse font-mono" dir="ltr">
                  {expiry || 'DD/MM/YYYY'}
                </span>
                <span className="block text-[10px] font-extrabold text-brand-weak-ink">{tr('terminal.openCalendar')}</span>
              </button>
            </>
          )}
        </div>

        {/* Supplier batch / lot.
            Deliberately NOT a fourth tab: the three tabs above are the hot path
            (OCR misreads weight and name constantly, and the worker fixes them
            on nearly every problem carton), and a fourth would push all four
            below a legible width on a 360px phone. Batch is the opposite — the
            OCR only fills it when the label carries an explicit מנה/Batch
            heading, so this row is usually where it gets entered at all, and it
            is fine for it to sit quietly at the bottom. Blank is a valid answer;
            nothing gates on it. */}
        <div className="px-[13px] pt-[10px] pb-[2px] border-t border-line flex items-center gap-2">
          <span className="flex-none bg-brand-weak text-brand-weak-ink font-mono font-extrabold text-[7px] px-[6px] py-[3px] rounded-[4px] tracking-[.5px]">
            {tr('terminal.batchTag')}
          </span>
          <input
            dir="ltr"
            type="text"
            value={batch}
            maxLength={24}
            placeholder={tr('terminal.batchHint')}
            onChange={e => onBatchChange(e.target.value)}
            className="flex-1 min-w-0 bg-line border border-line rounded-[8px] px-[10px] py-[7px] font-mono text-[11px] font-bold text-ink-inverse outline-none focus:border-brand"
          />
        </div>

        {/* Barcode. Read-only once the carton HAS an identity — it is the dedup
            key, and retyping a scanned code can only introduce an error. */}
        {!barcodeEditable && (
          <div className="px-[13px] pt-[10px] pb-3 border-t border-line flex items-center gap-2">
            <span className="flex-none bg-brand text-[#04222f] font-mono font-extrabold text-[7px] px-[6px] py-[2px] rounded-[4px] tracking-[.5px]">
              BC_SCAN
            </span>
            <span
              className="flex-1 min-w-0 font-mono text-[10px] font-bold text-ink-inverse text-center tracking-[1.5px] whitespace-nowrap overflow-hidden text-ellipsis"
              dir="ltr"
            >
              {barcode}
            </span>
          </div>
        )}
      </div>

      {calOpen && (
        <CalendarPicker
          value={ddmmyyyyToIso(expiry)}
          fieldTitle={tr('terminal.expiryDate')}
          onPick={iso => { onExpiryChange(isoToDdmmyyyy(iso)); setCalOpen(false); }}
          onClose={() => setCalOpen(false)}
        />
      )}
    </div>
  );
}
