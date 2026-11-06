'use client';

/**
 * Receive form v3, rubric 1 "אריזה וכמות" (states 13–16): one layout per line
 * mode — `same` (one packages stepper), `pack` (packages + the units total
 * as a link that turns into a field), `kg` (weight + packages) — then
 * the info row: short by …, the reason chips or the chosen reason, and
 * "כמו בתעודה" when anything differs from the note.
 */
import type { CSSProperties } from 'react';
import type { FormLine, Gap } from '@/lib/receipt-form';
import { differsFromNote, lineMode, pkgWord, shortBy, type V3LineDraft } from '@/lib/receive-v3';
import { V3Icon } from './icons';
import { BARE, I, P, UNDERLINE, font, numInput, type KbHandlers } from './tokens';
import { GAP_KEY, amountText, num, type Lang, type Tr } from './texts';

const GAPS: Gap[] = ['will', 'wont', 'other'];

export interface QtyStepProps {
  line: FormLine;
  d: V3LineDraft;
  lang: Lang;
  tr: Tr;
  kb: KbHandlers;
  /** The units-total editor (pack mode) is open. */
  qtyEdit: boolean;
  onQtyEdit: (open: boolean) => void;
  onCartons: (value: string) => void;
  onQty: (value: string) => void;
  onOpenPackaging: () => void;
  onReset: () => void;
  onGap: (g: Gap | null) => void;
  onGapNote: (v: string) => void;
  onGapNoteBlur: () => void;
}

const stepBtn: CSSProperties = {
  width: 48,
  height: 44,
  flex: 'none',
  border: `1px solid ${P.line2}`,
  borderRadius: 6,
  background: P.bg,
  color: P.ink,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0,
};

export function QtyStep(p: QtyStepProps) {
  const { line, d, lang, tr, kb } = p;
  const mode = lineMode(line);
  const weighed = line.weighed;
  const kbMode = weighed ? 'decimal' : 'numeric';
  const kbPattern = weighed ? '[0-9]*[.,]?[0-9]*' : '[0-9]*';
  const qtyLabel = weighed ? tr('receive.v3.weight') : tr('receive.v3.qtyUnit', { unit: line.unit_label });
  const cartonsLabel = mode === 'same' ? tr('receive.v3.qtyIn', { pkgs: pkgWord(2, d.packaging || null, lang) }) : tr('receive.v3.pkgCount');
  const c = num(d.cartons) ?? 0;
  const pkgNow = pkgWord(c, d.packaging || null, lang);
  const short = shortBy(line, d);
  const differs = differsFromNote(line, d);
  const showInfo = mode === 'pack' || short > 0 || differs;

  const cartonsInput = (
    <input
      value={d.cartons}
      onChange={(e) => p.onCartons(e.target.value.replace(/\D/g, '').slice(0, 6))}
      onFocus={kb.onFocus}
      onBlur={kb.onBlur}
      inputMode="numeric"
      pattern="[0-9]*"
      data-keyboard="numeric"
      dir="ltr"
      autoComplete="off"
      aria-label={cartonsLabel}
      style={numInput(60, 44, 20)}
    />
  );
  const pkgButton = (
    <button
      type="button"
      onClick={p.onOpenPackaging}
      aria-haspopup="listbox"
      aria-label={tr('receive.v3.pkgType')}
      style={{
        flex: 1,
        minWidth: 0,
        height: 44,
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        paddingInline: '8px 2px',
        border: `1px solid ${P.line2}`,
        borderRadius: 6,
        background: P.bg,
        color: P.ink,
        font: font(400, 16),
        textAlign: 'start',
      }}
    >
      <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{pkgNow}</span>
      <V3Icon name="expand_more" size={22} />
    </button>
  );
  const stepper = (
    <>
      <button type="button" aria-label="-1" onClick={() => p.onCartons(String(Math.max(0, c - 1)))} style={stepBtn}>
        <V3Icon name="remove" size={26} />
      </button>
      {cartonsInput}
      <button type="button" aria-label="+1" onClick={() => p.onCartons(String(c + 1))} style={stepBtn}>
        <V3Icon name="add" size={26} />
      </button>
    </>
  );
  const qtyInput = (w: number, h: number, size: number, onBlur: () => void, autoFocus = false) => (
    <input
      value={d.qty}
      onChange={(e) => p.onQty(e.target.value.replace(/[^\d.,]/g, ''))}
      onFocus={kb.onFocus}
      onBlur={onBlur}
      inputMode={kbMode}
      pattern={kbPattern}
      data-keyboard={kbMode}
      dir="ltr"
      autoComplete="off"
      aria-label={qtyLabel}
      autoFocus={autoFocus}
      style={numInput(w, h, size)}
    />
  );

  return (
    <div data-group="1-quantity" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {mode !== 'kg' ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {stepper}
          {pkgButton}
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {qtyInput(76, 44, 20, kb.onBlur)}
          <span style={{ flex: 'none', font: font(500, 16), color: P.ink }}>{line.unit_label}</span>
          <span style={{ width: 1, height: 32, flex: 'none', margin: '0 6px', background: P.line }} />
          {cartonsInput}
          {pkgButton}
        </div>
      )}
      {showInfo && (
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '4px 8px', minHeight: 36 }}>
          {differs && (
            <button
              type="button"
              onClick={p.onReset}
              style={{
                ...BARE,
                ...UNDERLINE,
                order: 9,
                marginInlineStart: 'auto',
                height: 36,
                padding: '0 2px',
                color: P.ink2,
                whiteSpace: 'nowrap',
                font: font(400, 14),
              }}
            >
              {tr('receive.v3.asOnNote')}
            </button>
          )}
          {mode === 'pack' && !p.qtyEdit && (
            <button
              type="button"
              onClick={() => p.onQtyEdit(true)}
              aria-label={qtyLabel}
              style={{ ...BARE, ...UNDERLINE, height: 36, padding: '0 2px', whiteSpace: 'nowrap', font: font(400, 15) }}
            >
              {`${I(d.qty)} ${line.unit_label}`}
            </button>
          )}
          {mode === 'pack' && p.qtyEdit && (
            <>
              {qtyInput(84, 40, 18, () => {
                kb.onBlur();
                p.onQtyEdit(false);
              }, true)}
              <span style={{ font: font(500, 16), color: P.ink }}>{line.unit_label}</span>
            </>
          )}
          {short > 0 && (
            <span style={{ font: font(600, 15), color: P.ink }}>
              {tr('receive.v3.short', { amount: amountText(line, d, short, lang) })}
            </span>
          )}
          {short > 0 && !d.gap && (
            <span role="group" aria-label={tr('receive.v3.gapQ')} style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {GAPS.map((g) => (
                <button
                  key={g}
                  type="button"
                  onClick={() => p.onGap(g)}
                  style={{
                    height: 36,
                    padding: '0 10px',
                    borderRadius: 6,
                    border: `1px solid ${P.line2}`,
                    background: P.bg,
                    color: P.ink,
                    font: font(400, 14),
                    whiteSpace: 'nowrap',
                  }}
                >
                  {tr(GAP_KEY[g])}
                </button>
              ))}
            </span>
          )}
          {short > 0 && d.gap && (
            <button
              type="button"
              onClick={() => p.onGap(null)}
              aria-label={tr(GAP_KEY[d.gap])}
              style={{
                height: 36,
                display: 'flex',
                alignItems: 'center',
                gap: 2,
                padding: '0 8px',
                border: 'none',
                borderRadius: 6,
                background: P.ink,
                color: P.bg,
                font: font(500, 14),
              }}
            >
              {tr(GAP_KEY[d.gap])}
              <V3Icon name="close" size={16} />
            </button>
          )}
        </div>
      )}
      {short > 0 && d.gap === 'other' && (
        <input
          value={d.gapNote}
          onChange={(e) => p.onGapNote(e.target.value.slice(0, 500))}
          onBlur={p.onGapNoteBlur}
          placeholder={tr('receive.v3.gapNote')}
          aria-label={tr('receive.v3.gapNote')}
          maxLength={500}
          type="text"
          dir={lang === 'he' ? 'rtl' : 'ltr'}
          style={{
            height: 44,
            background: P.bg,
            border: `2px solid ${P.line2}`,
            borderRadius: 6,
            color: P.ink,
            font: font(400, 16),
            padding: '0 10px',
            outline: 'none',
            textAlign: 'start',
          }}
        />
      )}
    </div>
  );
}
