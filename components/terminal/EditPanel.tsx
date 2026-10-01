'use client';

import { useContext, useState, type ReactNode } from 'react';
import Image from 'next/image';
import { MI } from './MI';
import { Keypad } from './Keypad';
import { CalendarPicker } from './CalendarPicker';
import { LanguageContext, useT, type TranslationKey } from '@/lib/i18n';
import { toIsoDate, isoToDdmmyyyy } from '@/lib/expiry';
import {
  weightState, nameState, expiryState, localIsoDate,
  firstField, fieldAfterItemPick, fieldAfterExpiryPick,
  missingList, gateMissing, saveMode, tileState,
  type EditField, type MissingField, type TileState,
} from '@/lib/edit-panel-state';

export interface EditItemChip {
  label: string;
  /** The invoice line's item code, shown under the name so look-alike lines can be told apart. */
  code?: string;
  active: boolean;
  onPick: () => void;
}

interface EditPanelProps {
  cartonNumber: number | string;
  name: string;
  /** Weight as the raw editable string, e.g. "18.45" */
  weight: string;
  /** Expiry as ISO `YYYY-MM-DD` ('' when unknown). Shown as DD/MM/YYYY. */
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
  /**
   * Mint a replacement sticker for this carton — the same warehouse-minted
   * label the "New carton" screen creates, printed from Labels and stuck on
   * the box. Preferred over booking with no code: a minted barcode can be
   * scanned again on the way out.
   */
  onCreateBarcode?: () => void;
  minting?: boolean;
  /**
   * "Book it without a barcode." Shown ONLY once minting has actually failed —
   * it is a worse outcome than a real sticker, so it must not sit next to the
   * good option as an equal choice. It exists so a network problem can never
   * leave a worker unable to finish the pallet.
   */
  onNoBarcode?: () => void;
  showNoBarcode?: boolean;
  /**
   * The carton carries a warning. Save stays enabled even with nothing
   * changed: saving is how the worker confirms what is there, and a disabled
   * Save would leave the carton stuck behind "Fix N warnings".
   */
  needsReview?: boolean;
  /**
   * Why the last Save (or barcode mint) did not go through. Drawn INSIDE the
   * panel: the page's own error line sits under this full-screen overlay,
   * where a worker never saw "5 digits — need at least 13".
   */
  saveError?: string | null;
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

/** A real carton barcode is at least a 13-digit GS1 prefix. */
const MIN_BARCODE_DIGITS = 13;

const MISSING_KEY: Record<MissingField, TranslationKey> = {
  barcode: 'terminal.missingBarcode',
  name: 'terminal.missingItem',
  weight: 'terminal.missingWeight',
  expiry: 'terminal.missingExpiry',
};

// One colour per meaning, each with its icon (lib/edit-panel-state.ts):
// blue + pencil = being edited, amber + "!" = missing / needs you,
// red + "!" = wrong, green + check = changed and valid, grey pencil = untouched.
const TILE_FRAME: Record<TileState, string> = {
  missing: 'bg-amber-card border-2 border-dashed border-warn',
  offInvoice: 'bg-amber-card border-2 border-warn',
  invalid: 'bg-danger-weak border-2 border-danger',
  changed: 'bg-tile border-2 border-ok/70',
  idle: 'bg-tile border-2 border-line-strong',
};
const TILE_LABEL: Record<TileState, string> = {
  missing: 'text-warn-weak-ink',
  offInvoice: 'text-warn-weak-ink',
  invalid: 'text-danger-weak-ink',
  changed: 'text-ok-weak-ink',
  idle: 'text-ink-muted',
};
const TILE_VALUE: Record<TileState, string> = {
  missing: 'text-warn-weak-ink',
  offInvoice: 'text-warn-weak-ink',
  invalid: 'text-danger-weak-ink',
  changed: 'text-ink-inverse',
  idle: 'text-ink-inverse',
};
const TILE_BADGE: Record<TileState, { cls: string; icon: string }> = {
  missing: { cls: 'bg-warn text-canvas', icon: 'priority_high' },
  offInvoice: { cls: 'bg-warn text-canvas', icon: 'priority_high' },
  invalid: { cls: 'bg-danger text-ink-inverse', icon: 'priority_high' },
  changed: { cls: 'bg-ok text-canvas', icon: 'check' },
  idle: { cls: 'bg-tile text-ink-body', icon: 'edit' },
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
 *
 * Reading it, from the 2026-10 floor feedback ("which one is selected, which to
 * edit, there is no edit sign"): every tile wears a badge saying what it needs,
 * the header says what is still missing, the item list has exactly one green
 * choice, and Save shows whether it will clear the carton's warning. The
 * caller remounts this per carton (`key`), so "changed" is against the values
 * it opened with.
 */
export function EditPanel({
  cartonNumber, name, weight, expiry, batch, barcode, itemChips,
  imageData, onViewImage,
  barcodeWeight, barcodeExpiry, onUseBarcodeWeight, onUseBarcodeExpiry,
  barcodeEditable, barcodeInput = '', onBarcodeChange,
  onCreateBarcode, minting, onNoBarcode, showNoBarcode,
  needsReview, saveError,
  onNameChange, onWeightChange, onExpiryChange, onBatchChange, onSave, onCancel,
}: EditPanelProps) {
  const tr = useT();
  const isHe = useContext(LanguageContext) === 'Hebrew';
  // What the panel opened with — "changed" and Save's state compare against it.
  const [initial] = useState(() => ({ name, weight, expiry, batch, barcode, barcodeInput }));
  const [todayIso] = useState(() => localIsoDate());
  // Open on the first field that still needs the worker, not always Weight.
  const [field, setField] = useState<EditField>(() => firstField(name, weight, expiry));
  const [calOpen, setCalOpen] = useState(false);
  // "Different name — type it" was tapped: the free-text box replaces that row.
  const [typing, setTyping] = useState(false);

  const digits = barcodeInput.replace(/\D/g, '');
  const barcodeReady = digits.length >= MIN_BARCODE_DIGITS;
  const barcodeMissing = !!barcodeEditable && !barcodeReady;

  const chips = itemChips ?? [];
  // At most ONE row is ever selected, even if two invoice lines share a name.
  const activeIdx = chips.findIndex((c) => c.active);

  const states = {
    weight: weightState(weight),
    name: nameState(name, chips),
    expiry: expiryState(expiry, todayIso),
  };
  const changed: Record<EditField, boolean> = {
    name: name !== initial.name,
    weight: weight !== initial.weight,
    expiry: expiry !== initial.expiry,
  };
  const nChanged = [
    changed.name, changed.weight, changed.expiry,
    batch !== initial.batch,
    barcode !== initial.barcode || barcodeInput !== initial.barcodeInput,
  ].filter(Boolean).length;
  const dirty = nChanged > 0;
  const hasConflict = !!(barcodeWeight || barcodeExpiry);
  const missing = missingList({ name, weight, expiry, barcodeMissing });
  const mode = saveMode({
    dirty,
    hasConflict,
    needsReview: !!needsReview,
    gateMissing: gateMissing({ name, weight, barcodeMissing }),
  });

  const handleKey = (k: string) => {
    if (k === 'back') { onWeightChange(weight.slice(0, -1)); return; }
    if (k === '.' && weight.includes('.')) return;
    if (weight.replace('.', '').length >= 5) return;
    onWeightChange(weight + k);
  };

  // The header's one-line status: what is missing (or doubtful), else what
  // Save will do.
  let status: { icon: string; cls: string; text: string };
  if (missing.length) {
    const fields = missing.map((m) => tr(MISSING_KEY[m])).join(', ');
    status = { icon: 'warning', cls: 'text-warn-weak-ink', text: tr('terminal.missingList', { fields }) };
  } else if (states.expiry === 'past') {
    status = { icon: 'warning', cls: 'text-warn-weak-ink', text: tr('terminal.checkExpiry') };
  } else if (dirty) {
    const text = nChanged === 1 ? tr('terminal.changeReadyOne') : tr('terminal.changesReady', { n: nChanged });
    status = { icon: 'check_circle', cls: 'text-ok-weak-ink', text };
  } else if (mode !== 'disabled') {
    // Flagged or in conflict, nothing to fill in: Save confirms what is there.
    status = { icon: 'touch_app', cls: 'text-brand-weak-ink', text: tr('terminal.checkThenSave') };
  } else {
    status = { icon: 'touch_app', cls: 'text-ink-muted', text: tr('terminal.tapFieldToEdit') };
  }

  const saveCls = mode === 'disabled'
    ? 'bg-sunken text-ink-muted border border-line cursor-not-allowed'
    : mode === 'warn'
      ? 'bg-warn-weak text-warn-weak-ink border border-warn'
      : 'bg-brand text-ink-inverse border border-brand';

  const tile = (f: EditField, label: string, value: ReactNode, grow: string) => {
    const st = tileState(f, states, changed[f]);
    const editing = field === f;
    // The frame says which field is open; the badge says how its value is
    // doing — a value typed right now turns green (or red) at once.
    const badge = editing && st !== 'changed' && st !== 'invalid'
      ? { cls: 'bg-brand text-ink-inverse', icon: 'edit' }
      : TILE_BADGE[st];
    return (
      <button
        onClick={() => setField(f)}
        aria-pressed={editing}
        className={`${grow} relative min-w-0 text-start rounded-[12px] px-[8px] py-[7px] min-h-[56px] transition-colors ${
          editing ? 'bg-brand-weak border-2 border-brand' : TILE_FRAME[st]
        }`}
      >
        <div className={`text-[10px] font-extrabold tracking-[.3px] truncate ${editing ? 'text-brand-weak-ink' : TILE_LABEL[st]}`}>
          {label}
        </div>
        <div className={`mt-[3px] ${TILE_VALUE[st]}`}>
          {st === 'missing' ? (
            <>
              <div className="text-[13px] font-black leading-[1.2] truncate">{tr('terminal.missing')}</div>
              {!editing && (
                <div className="text-[9.5px] font-bold leading-[1.2] truncate">{tr('terminal.tapToEnter')}</div>
              )}
            </>
          ) : value}
        </div>
        <span
          className={`absolute -top-[7px] -end-[7px] w-[20px] h-[20px] rounded-full border-2 border-canvas flex items-center justify-center ${badge.cls}`}
        >
          <MI name={badge.icon} size={12} />
        </span>
        {/* Points from the tile being edited down into its editor. */}
        {editing && (
          <span
            aria-hidden
            className="absolute left-1/2 -translate-x-1/2 -bottom-[14px] w-0 h-0 border-x-[8px] border-x-transparent border-t-[12px] border-t-brand"
          />
        )}
      </button>
    );
  };

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

  // Text that may be Hebrew or English in either page direction: `dir="auto"`
  // keeps its FIRST words (the ones that tell items apart — every line on one
  // invoice can end in the same kashrut mark), aligned to the page's start.
  const alignStart = { textAlign: isHe ? 'right' : 'left' } as const;

  return (
    <div className="fixed inset-0 z-[80] flex flex-col bg-canvas">
      {/* Top bar */}
      <div className="flex-none flex justify-between items-center gap-2 ps-[3px] pe-[13px] py-[4px] bg-brand-weak border-b border-[rgba(19,164,236,.2)]">
        <button
          onClick={onCancel}
          className="tap-target flex-none flex items-center justify-center text-ink-inverse"
          aria-label={tr('common.back')}
        >
          {/* Points back in both directions: right in Hebrew, left in English. */}
          <MI name="arrow_forward_ios" size={20} flip={!isHe} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-extrabold text-ink-inverse truncate">
            {tr('terminal.editCarton', { n: cartonNumber })}
          </div>
          <div className={`flex items-center gap-[4px] min-w-0 text-[10.5px] font-extrabold ${status.cls}`}>
            <MI name={status.icon} size={13} className="flex-none" />
            <span className="truncate">{status.text}</span>
          </div>
        </div>
        <button
          onClick={onSave}
          disabled={mode === 'disabled'}
          className={`flex-none flex items-center gap-[5px] min-h-[40px] text-[12px] font-extrabold rounded-full px-[14px] ${saveCls}`}
        >
          <MI name={mode === 'warn' ? 'warning' : 'check'} size={16} />
          {tr('terminal.save')}
        </button>
      </div>

      {saveError && (
        <div
          role="alert"
          className="flex-none flex items-center gap-2 px-[13px] py-[8px] bg-danger-weak text-danger-weak-ink text-[12px] font-extrabold border-b border-danger/40"
        >
          <MI name="error" size={17} className="flex-none" />
          <span className="min-w-0">{saveError}</span>
        </div>
      )}

      {/* Sticker photo — everything the controls don't need. `min-h-0` lets it
          shrink on a short screen; the floor stops it collapsing to nothing. */}
      <div className="flex-1 min-h-0 relative bg-black" style={{ minHeight: 120 }}>
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
      <div className="flex-none overflow-y-auto overflow-x-hidden" style={{ maxHeight: '62vh' }}>
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
            <div className="mt-[7px]">
              <span
                className="font-mono text-[10px] font-bold"
                style={{ color: barcodeReady ? '#7ee2a8' : '#e8d3a8' }}
              >
                {barcodeReady
                  ? `${digits.length} ✓`
                  : tr('terminal.barcodeDigitsCount', { n: digits.length })}
              </span>
            </div>

            {/* Destroyed beyond reading: mint a sticker instead of typing.
                Full width and unmissable — it is the answer for the carton the
                typing path cannot serve. */}
            {onCreateBarcode && (
              <button
                onClick={onCreateBarcode}
                disabled={minting}
                className="mt-[10px] w-full flex items-center justify-center gap-[7px] rounded-[10px] py-[11px] text-[13px] font-extrabold border disabled:opacity-60"
                style={{ background: 'rgba(245,158,11,.16)', borderColor: '#fbbf5c', color: '#f5d9a4' }}
              >
                <MI name={minting ? 'hourglass_top' : 'add_box'} size={17} />
                {minting ? tr('terminal.barcodeCreating') : tr('terminal.barcodeCreateBtn')}
              </button>
            )}

            {/* Only after a mint has failed — see the prop comment. */}
            {showNoBarcode && onNoBarcode && (
              <button
                onClick={onNoBarcode}
                className="mt-[8px] w-full text-[11px] font-extrabold underline text-ink-muted"
              >
                {tr('terminal.barcodeNoneBtn')}
              </button>
            )}
          </div>
        )}

        {/* The three values at a glance; a tap opens that field's editor below. */}
        <div className="flex gap-[9px] px-[13px] pt-[10px] pb-[12px]">
          {tile(
            'name',
            tr('terminal.fieldItem'),
            <div
              dir="auto"
              style={alignStart}
              className="text-[12.5px] font-extrabold leading-[1.25] line-clamp-2 whitespace-normal break-words"
            >
              {name}
            </div>,
            'flex-[1.3]',
          )}
          {tile(
            'weight',
            tr('terminal.fieldWeight'),
            <span dir="ltr" className="inline-flex items-baseline gap-[3px] max-w-full whitespace-nowrap">
              <span className="font-mono text-[13px] min-[360px]:text-[14px] font-black truncate">{weight}</span>
              <span className="flex-none text-[10px] font-extrabold text-brand-weak-ink">{tr('common.kg')}</span>
            </span>,
            'flex-[0.95]',
          )}
          {tile(
            'expiry',
            tr('terminal.fieldExpiry'),
            <span dir="ltr" className="inline-block max-w-full align-top font-mono text-[12px] min-[360px]:text-[13px] font-black whitespace-nowrap overflow-hidden text-ellipsis">
              {isoToDdmmyyyy(expiry)}
            </span>,
            'flex-[1.15]',
          )}
        </div>

        {/* The editor for the selected tile; the caret above joins the two. */}
        <div className="px-[13px] pt-[9px] pb-3 border-t-2 border-brand" style={{ background: 'linear-gradient(180deg,#0d171d,#0a1015)' }}>
          {field === 'weight' && (
            <>
              {barcodeWeight && onUseBarcodeWeight
                && suggestion(`${barcodeWeight} ${tr('common.kg')}`, onUseBarcodeWeight)}
              <div
                className={`flex items-center justify-end gap-[6px] bg-overlay-card border rounded-[10px] px-[14px] py-[6px] ${
                  states.weight === 'invalid' ? 'border-danger' : 'border-line'
                }`}
                dir="ltr"
              >
                <span className="font-mono font-black text-[28px] leading-none text-ink-inverse truncate">
                  {weight || <span className="text-ink-muted">—</span>}
                </span>
                <span className="text-[12px] font-extrabold text-brand-weak-ink">{tr('common.kg')}</span>
              </div>
              {/* One line, always there, so the keypad never jumps while typing. */}
              {states.weight === 'invalid' ? (
                <div className="flex items-center gap-[5px] mt-[4px] mb-[7px] h-[16px] text-[11px] font-extrabold text-danger-weak-ink">
                  <MI name="error" size={14} className="flex-none" />
                  <span className="truncate">{tr('terminal.weightInvalid')}</span>
                </div>
              ) : (
                <div className="mt-[4px] mb-[7px] h-[16px] text-[11px] font-bold text-ink-muted truncate">
                  {tr('terminal.weightHint')}
                </div>
              )}
              <Keypad onKey={handleKey} />
            </>
          )}
          {field === 'name' && (
            <div className="flex flex-col gap-[7px]">
              <div className="flex items-center gap-[6px] text-[11px] font-extrabold text-ink-body">
                <MI name="inventory_2" size={15} className="flex-none text-brand-weak-ink" />
                <span className="min-w-0">{tr('terminal.whichItem')}</span>
              </div>
              <div role="radiogroup" aria-label={tr('terminal.whichItem')} className="flex flex-col gap-[7px]">
                {/* A name read off the sticker that matches no invoice line is
                    still the current answer: show it as the chosen row, amber. */}
                {states.name === 'offInvoice' && !typing && (
                  <div
                    role="radio"
                    aria-checked
                    className="w-full min-h-[48px] flex items-center gap-[10px] px-[12px] py-[9px] rounded-[11px] bg-warn-weak border-2 border-warn"
                  >
                    <MI name="check_circle" size={22} className="flex-none text-warn" />
                    <span className="min-w-0 flex-1">
                      <span dir="auto" style={alignStart} className="block text-[13px] leading-[1.3] font-black text-ink-inverse break-words">
                        {name}
                      </span>
                      <span className="flex items-center gap-[4px] mt-[2px] text-[10.5px] font-extrabold text-warn-weak-ink">
                        <MI name="warning" size={13} className="flex-none" />
                        <span className="min-w-0">{tr('terminal.notOnInvoice')}</span>
                      </span>
                    </span>
                  </div>
                )}
                {chips.map((chip, i) => {
                  const sel = i === activeIdx;
                  return (
                    <button
                      key={i}
                      role="radio"
                      aria-checked={sel}
                      onClick={() => {
                        chip.onPick();
                        setTyping(false);
                        // On to whatever is still missing.
                        setField(fieldAfterItemPick(weight, expiry));
                      }}
                      className={`w-full min-h-[48px] flex items-center gap-[10px] px-[12px] py-[9px] rounded-[11px] text-start transition-colors ${
                        sel ? 'bg-ok-weak border-2 border-ok' : 'bg-tile border border-line'
                      }`}
                    >
                      <MI
                        name={sel ? 'check_circle' : 'radio_button_unchecked'}
                        size={22}
                        className={`flex-none ${sel ? 'text-ok' : 'text-ink-muted'}`}
                      />
                      <span className="min-w-0 flex-1">
                        <span
                          dir="auto"
                          style={alignStart}
                          className={`block text-[13px] leading-[1.3] break-words ${sel ? 'font-black text-ink-inverse' : 'font-bold text-ink-body'}`}
                        >
                          {chip.label}
                        </span>
                        {chip.code && (
                          <span dir="ltr" style={alignStart} className="block mt-[1px] font-mono text-[10px] text-ink-muted truncate">
                            {chip.code}
                          </span>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
              {typing ? (
                <input
                  dir="auto"
                  type="text"
                  autoFocus
                  value={name}
                  placeholder={tr('terminal.typeName')}
                  onChange={e => onNameChange(e.target.value)}
                  className="w-full box-border bg-sunken border-2 border-line-strong focus:border-brand rounded-[11px] px-[12px] py-[11px] text-[13px] font-bold text-ink-inverse outline-none placeholder:text-ink-muted"
                />
              ) : (
                <button
                  onClick={() => setTyping(true)}
                  className="w-full min-h-[44px] flex items-center gap-[10px] px-[12px] py-[9px] rounded-[11px] border border-dashed border-line-strong text-ink-body text-start"
                >
                  <MI name="edit_note" size={22} className="flex-none text-ink-muted" />
                  <span className="min-w-0 text-[12.5px] font-bold">{tr('terminal.otherName')}</span>
                </button>
              )}
            </div>
          )}
          {field === 'expiry' && (
            <>
              {barcodeExpiry && onUseBarcodeExpiry
                && suggestion(barcodeExpiry, onUseBarcodeExpiry)}
              {!expiry ? (
                <button
                  onClick={() => setCalOpen(true)}
                  className="w-full min-h-[56px] flex items-center gap-[10px] bg-amber-card border-2 border-dashed border-warn rounded-[12px] px-[13px] py-[11px] text-start"
                >
                  <MI name="event" size={24} className="flex-none text-warn" />
                  <span className="min-w-0 text-[13px] font-extrabold text-warn-weak-ink">{tr('terminal.pickExpiry')}</span>
                </button>
              ) : (
                <button
                  onClick={() => setCalOpen(true)}
                  className={`w-full flex items-center justify-between gap-[10px] bg-sunken border-2 rounded-[12px] px-[13px] py-[11px] text-start ${
                    states.expiry === 'past' ? 'border-danger' : 'border-line-strong'
                  }`}
                >
                  <span
                    className={`text-[17px] font-extrabold font-mono ${states.expiry === 'past' ? 'text-danger-weak-ink' : 'text-ink-inverse'}`}
                    dir="ltr"
                  >
                    {isoToDdmmyyyy(expiry)}
                  </span>
                  <span className="flex-none flex items-center gap-[5px] text-[11.5px] font-extrabold text-brand-weak-ink">
                    <MI name="edit_calendar" size={18} />
                    {tr('terminal.changeDate')}
                  </span>
                </button>
              )}
              {states.expiry === 'past' && (
                <div role="alert" className="flex items-start gap-[5px] mt-[8px] text-[11.5px] font-extrabold text-danger-weak-ink">
                  <MI name="error" size={15} className="flex-none mt-[1px]" />
                  <span className="min-w-0">{tr('terminal.expiryPast')}</span>
                </div>
              )}
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
        <div className="px-[13px] pt-[10px] pb-[4px] border-t border-line">
          <label htmlFor="edit-panel-batch" className="flex items-center gap-[6px] mb-[6px] text-[11px] font-extrabold text-ink-body">
            <MI name="tag" size={14} className="flex-none text-ink-muted" />
            <span className="min-w-0 truncate">{tr('terminal.batchLabel')}</span>
          </label>
          <input
            id="edit-panel-batch"
            dir="ltr"
            type="text"
            value={batch}
            maxLength={24}
            onChange={e => onBatchChange(e.target.value)}
            className="w-full box-border bg-sunken border border-line-strong rounded-[9px] px-[10px] py-[9px] font-mono text-[13px] font-bold text-ink-inverse outline-none focus:border-brand"
          />
        </div>

        {/* Barcode. Read-only once the carton HAS an identity — it is the dedup
            key, and retyping a scanned code can only introduce an error. */}
        {!barcodeEditable && (
          <div className="px-[13px] pt-[10px] pb-3 flex items-center gap-2">
            <MI name="qr_code_2" size={16} className="flex-none text-ink-muted" />
            <span className="flex-none text-[11px] font-extrabold text-ink-body">{tr('terminal.scannedBarcode')}</span>
            <span
              className="flex-1 min-w-0 font-mono text-[12px] font-bold text-ink-body whitespace-nowrap overflow-hidden text-ellipsis"
              style={{ textAlign: isHe ? 'left' : 'right' }}
              dir="ltr"
            >
              {barcode}
            </span>
            <span role="img" aria-label={tr('terminal.readOnly')} title={tr('terminal.readOnly')} className="flex-none flex text-ink-muted">
              <MI name="lock" size={14} />
            </span>
          </div>
        )}
      </div>

      {calOpen && (
        <CalendarPicker
          value={toIsoDate(expiry)}
          // No silent "today": an empty expiry opens with no day chosen.
          requirePick
          fieldTitle={tr('terminal.expiryDate')}
          // Stored as ISO; only the tiles above show DD/MM/YYYY.
          onPick={iso => {
            onExpiryChange(iso);
            setCalOpen(false);
            setField(fieldAfterExpiryPick(name, weight));
          }}
          onClose={() => setCalOpen(false)}
        />
      )}
    </div>
  );
}
