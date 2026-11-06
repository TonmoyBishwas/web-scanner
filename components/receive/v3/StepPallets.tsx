'use client';

/**
 * Receive form v3, step 1 (states 1, 4): "כמה משטחים?" with the big stepper,
 * the "items outside the pallet" checkbox and its summary, and "המשך".
 * `PalletStepper` and `LooseCheck` are shared with the pallets sheet (5.7).
 */
import type { ChangeEvent, CSSProperties, FocusEvent } from 'react';
import { V3 } from '@/lib/receive-v3';
import type { FormHeader } from '@/lib/receipt-form';
import { ForwardIcon, V3Icon } from './icons';
import { BARE, I, P, UNDERLINE, font } from './tokens';
import type { Tr } from './texts';

/** Typed pallet count: digits only, no leading zeros, ≤ 2 digits, 0..50 (bot limit). */
export function parsePalletInput(raw: string): number {
  const d = raw.replace(/\D/g, '').replace(/^0+(?=\d)/, '').slice(0, 2);
  const n = Number(d) || 0;
  return Math.max(0, Math.min(V3.MAX_PALLETS, n));
}

const selectAll = (e: FocusEvent<HTMLInputElement>) => {
  const el = e.target;
  try {
    el.select();
  } catch {
    /* ignore */
  }
};

export function PalletStepper({
  size,
  pallets,
  onChange,
  tr,
}: {
  size: 'page' | 'sheet';
  pallets: number;
  onChange: (n: number) => void;
  tr: Tr;
}) {
  const big = size === 'page';
  const btn: CSSProperties = {
    width: big ? 84 : 72,
    height: big ? 84 : 72,
    flex: 'none',
    border: `1px solid ${P.line}`,
    borderRadius: 6,
    background: P.surf,
    color: P.ink,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
  };
  const icon = big ? 44 : 38;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
      <button type="button" aria-label={tr('receive.v3.palletLess')} onClick={() => onChange(Math.max(0, pallets - 1))} style={btn}>
        <V3Icon name="remove" size={icon} />
      </button>
      <input
        value={String(pallets)}
        onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(parsePalletInput(e.target.value))}
        onFocus={selectAll}
        inputMode="numeric"
        pattern="[0-9]*"
        data-keyboard="numeric"
        aria-label={tr('receive.v3.palletsQ')}
        dir="ltr"
        autoComplete="off"
        style={{
          width: big ? 120 : 104,
          height: big ? 96 : 76,
          padding: 0,
          textAlign: 'center',
          font: font(600, big ? 64 : 52),
          background: P.surf,
          border: `2px solid ${P.line2}`,
          borderRadius: 6,
          color: P.ink,
          outline: 'none',
        }}
      />
      <button
        type="button"
        aria-label={tr('receive.v3.palletMore')}
        onClick={() => onChange(Math.min(V3.MAX_PALLETS, pallets + 1))}
        style={btn}
      >
        <V3Icon name="add" size={icon} />
      </button>
    </div>
  );
}

/** "יש גם פריטים מחוץ למשטח" + (when lines are loose) "מחוץ למשטח: N פריטים · ערוך". */
export function LooseCheck({
  on,
  count,
  onToggle,
  onEdit,
  tr,
}: {
  on: boolean;
  count: number;
  onToggle: () => void;
  onEdit: () => void;
  tr: Tr;
}) {
  return (
    <>
      <button
        type="button"
        onClick={onToggle}
        role="checkbox"
        aria-checked={on}
        style={{
          ...BARE,
          minHeight: 48,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '0 4px',
          font: font(400, 16),
        }}
      >
        <V3Icon name={on ? 'check_box' : 'check_box_outline_blank'} size={24} />
        {tr('receive.v3.looseCheck')}
      </button>
      {on && count > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, font: font(400, 16), color: P.ink }}>
          <span>{count === 1 ? tr('receive.v3.looseSummaryOne') : tr('receive.v3.looseSummary', { n: I(count) })}</span>
          <button
            type="button"
            onClick={onEdit}
            style={{ ...BARE, ...UNDERLINE, height: 44, padding: '0 2px', whiteSpace: 'nowrap', font: font(500, 16) }}
          >
            {tr('receive.v3.edit')}
          </button>
        </div>
      )}
    </>
  );
}

export interface StepPalletsProps {
  header: FormHeader;
  lineCount: number;
  pallets: number;
  looseOn: boolean;
  looseCount: number;
  rtl: boolean;
  tr: Tr;
  onPallets: (n: number) => void;
  onToggleLoose: () => void;
  onEditLoose: () => void;
  onContinue: () => void;
}

export function StepPallets(p: StepPalletsProps) {
  const { tr } = p;
  const can = p.pallets > 0 || p.looseCount > 0;
  return (
    <div data-screen="pallets" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: '24px 20px 20px' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, paddingBottom: 16, borderBottom: `1px solid ${P.line}` }}>
        <div style={{ font: font(500, 15), color: P.ink2 }}>{tr('receive.v3.receiving')}</div>
        <div style={{ font: font(600, 24), color: P.ink }}>{p.header.supplier}</div>
        <div style={{ font: font(400, 16), color: P.ink2 }}>
          {tr('receive.v3.noteLines', { n: I(p.header.invoice_number), k: I(p.lineCount) })}
        </div>
      </div>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', gap: 24 }}>
        <div style={{ font: font(600, 32), color: P.ink }}>{tr('receive.v3.palletsQ')}</div>
        <PalletStepper size="page" pallets={p.pallets} onChange={p.onPallets} tr={tr} />
        <LooseCheck on={p.looseOn} count={p.looseCount} onToggle={p.onToggleLoose} onEdit={p.onEditLoose} tr={tr} />
      </div>
      <button
        type="button"
        onClick={p.onContinue}
        disabled={!can}
        style={{
          height: 64,
          flex: 'none',
          border: 'none',
          borderRadius: 6,
          background: can ? P.acc : P.surf,
          color: can ? P.accInk : P.line2,
          font: font(600, 20),
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          padding: 0,
        }}
      >
        {can ? tr('receive.v3.continue') : tr('receive.v3.enterPallets')}
        <ForwardIcon rtl={p.rtl} size={24} />
      </button>
    </div>
  );
}
