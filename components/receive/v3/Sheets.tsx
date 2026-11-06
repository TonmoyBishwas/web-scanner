'use client';

/**
 * Receive form v3, the bottom sheets: pallets (5.7), pallet list (5.11),
 * packaging list (5.12), item not on the note (5.16) and the save error
 * (5.24). Each lies on a dimmed overlay (tap outside = close/cancel) and has
 * a visible ×; Android back is handled by the root's back stack.
 */
import { useState, type CSSProperties, type ReactNode } from 'react';
import {
  EXTRA_UNITS,
  EXTRA_UNIT_LABELS,
  MAX_EXTRAS,
  PACKAGING_LABELS,
  type ExtraUnit,
  type Packaging,
} from '@/lib/receipt-form';
import { packagingOrder } from '@/lib/receive-v3';
import { CloseButton, V3Icon } from './icons';
import { SearchField } from './ListHeader';
import { LooseCheck, PalletStepper } from './StepPallets';
import type { PalletPick } from './PalletStep';
import { BARE, I, P, UNDERLINE, Z, font } from './tokens';
import { num, type Lang, type Tr } from './texts';
import css from './v3.module.css';

const SAFE_BOTTOM = 'max(12px, env(safe-area-inset-bottom))';

/** The dimmed overlay + the bottom sheet; a tap on the overlay calls `onDismiss`. */
function Sheet({
  z,
  onDismiss,
  style,
  children,
  label,
  role,
  dataSheet,
}: {
  z: number;
  onDismiss: () => void;
  style: CSSProperties;
  children: ReactNode;
  label?: string;
  role?: string;
  dataSheet: string;
}) {
  return (
    <div
      onClick={onDismiss}
      data-overlay={dataSheet}
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: z,
        background: P.overlay,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'flex-end',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        data-sheet={dataSheet}
        role={role ?? 'dialog'}
        aria-label={label}
        aria-modal={role ? undefined : true}
        style={{ position: 'relative', background: P.bg, borderRadius: '8px 8px 0 0', ...style }}
      >
        {children}
      </div>
    </div>
  );
}

const cornerX: CSSProperties = { position: 'absolute', top: 6, insetInlineEnd: 6 };

// ── 5.7 Pallets sheet ────────────────────────────────────────────────────

export function PalletsSheet({
  pallets,
  looseOn,
  looseCount,
  tr,
  onPallets,
  onToggleLoose,
  onEditLoose,
  onConfirm,
  onCancel,
}: {
  pallets: number;
  looseOn: boolean;
  looseCount: number;
  tr: Tr;
  onPallets: (n: number) => void;
  onToggleLoose: () => void;
  onEditLoose: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Sheet
      z={Z.sheet}
      onDismiss={onCancel}
      dataSheet="pallets"
      label={tr('receive.v3.palletsQ')}
      style={{
        borderTop: `1px solid ${P.line2}`,
        paddingTop: 20,
        paddingInline: 20,
        paddingBottom: 'max(16px, env(safe-area-inset-bottom))',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 18,
      }}
    >
      <CloseButton label={tr('receive.v3.close')} onClick={onCancel} style={cornerX} />
      <div style={{ font: font(600, 24), color: P.ink }}>{tr('receive.v3.palletsQ')}</div>
      <PalletStepper size="sheet" pallets={pallets} onChange={onPallets} tr={tr} />
      <LooseCheck on={looseOn} count={looseCount} onToggle={onToggleLoose} onEdit={onEditLoose} tr={tr} />
      <button
        type="button"
        onClick={onConfirm}
        style={{ width: '100%', height: 56, border: 'none', borderRadius: 6, background: P.acc, color: P.accInk, font: font(600, 18) }}
      >
        {tr('receive.v3.confirmBtn')}
      </button>
    </Sheet>
  );
}

// ── 5.11 Pallet list sheet (fewer than 2 pallets) ────────────────────────

export function PalletListSheet({
  pallets,
  value,
  tr,
  onPick,
  onClose,
}: {
  pallets: number;
  value: PalletPick | null;
  tr: Tr;
  onPick: (v: PalletPick) => void;
  onClose: () => void;
}) {
  const opts: { v: PalletPick; t: string }[] = [];
  for (let n = 1; n <= pallets; n += 1) opts.push({ v: n, t: tr('receive.v3.palletN', { n: I(n) }) });
  opts.push({ v: 'loose', t: tr('receive.v3.loose') });
  return (
    <Sheet
      z={Z.list}
      onDismiss={onClose}
      dataSheet="pallet-list"
      role="listbox"
      label={tr('receive.v3.stepPallet')}
      style={{ maxHeight: '70%', display: 'flex', flexDirection: 'column' }}
    >
      <div
        style={{ flex: 'none', height: 52, display: 'flex', alignItems: 'center', paddingInline: '16px 6px', borderBottom: `1px solid ${P.line}` }}
      >
        <span style={{ flex: 1, font: font(600, 17), color: P.ink }}>{tr('receive.v3.stepPallet')}</span>
        <CloseButton label={tr('receive.v3.close')} onClick={onClose} />
      </div>
      <div className={css.scroll} style={{ flex: 1, minHeight: 0, overflowY: 'auto', paddingTop: 4, paddingInline: 16, paddingBottom: SAFE_BOTTOM }}>
        {opts.map((o) => {
          const on = value === o.v;
          return (
            <button
              key={String(o.v)}
              type="button"
              role="option"
              aria-selected={on}
              onClick={() => onPick(o.v)}
              style={{
                ...BARE,
                width: '100%',
                minHeight: 52,
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                borderBottom: `1px solid ${P.line}`,
                textAlign: 'start',
              }}
            >
              <span style={{ flex: 1, minWidth: 0, font: font(on ? 500 : 400, 17) }}>{o.t}</span>
              <span style={{ width: 24, flex: 'none', display: 'flex', justifyContent: 'center', color: P.ink }}>
                {on && <V3Icon name="check" size={22} />}
              </span>
            </button>
          );
        })}
      </div>
    </Sheet>
  );
}

// ── 5.12 Packaging list ──────────────────────────────────────────────────

export function PackagingSheet({
  notePkg,
  value,
  lang,
  rtl,
  tr,
  onPick,
  onClose,
}: {
  notePkg: Packaging | null;
  value: Packaging | '';
  lang: Lang;
  rtl: boolean;
  tr: Tr;
  onPick: (k: Packaging) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const order = packagingOrder(notePkg, q.trim());
  return (
    <Sheet
      z={Z.list}
      onDismiss={onClose}
      dataSheet="packaging"
      role="listbox"
      label={tr('receive.v3.pkgType')}
      style={{ maxHeight: '78%', display: 'flex', flexDirection: 'column' }}
    >
      <div style={{ flex: 'none', paddingTop: 12, paddingBottom: 8, paddingInline: '6px 12px', display: 'flex', alignItems: 'center', gap: 4 }}>
        <SearchField value={q} onChange={setQ} placeholder={tr('receive.v3.pkgSearch')} rtl={rtl} inputMode="text" />
        <CloseButton label={tr('receive.v3.close')} onClick={onClose} />
      </div>
      <div
        className={css.scroll}
        style={{ flex: 1, minHeight: 0, overflowY: 'auto', paddingInline: 16, paddingBottom: SAFE_BOTTOM, borderTop: `1px solid ${P.line}` }}
      >
        {order.map((k) => {
          const on = value === k;
          return (
            <button
              key={k}
              type="button"
              role="option"
              aria-selected={on}
              onClick={() => onPick(k)}
              style={{
                ...BARE,
                width: '100%',
                minHeight: 52,
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                borderBottom: `1px solid ${P.line}`,
                textAlign: 'start',
              }}
            >
              <span style={{ flex: 1, minWidth: 0, font: font(on ? 500 : 400, 17) }}>{PACKAGING_LABELS[k][lang]}</span>
              {k === notePkg && <span style={{ font: font(400, 14), color: P.ink2 }}>{tr('receive.v3.onNote')}</span>}
              <span style={{ width: 24, flex: 'none', display: 'flex', justifyContent: 'center', color: P.ink }}>
                {on && <V3Icon name="check" size={22} />}
              </span>
            </button>
          );
        })}
      </div>
    </Sheet>
  );
}

// ── 5.16 Item not on the note ────────────────────────────────────────────

export function ExtraSheet({
  initialName,
  extrasCount,
  lang,
  rtl,
  tr,
  onAdd,
  onClose,
}: {
  initialName: string;
  extrasCount: number;
  lang: Lang;
  rtl: boolean;
  tr: Tr;
  onAdd: (x: { name: string; quantity: string; unit: ExtraUnit }) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [qty, setQty] = useState('');
  const [unit, setUnit] = useState<ExtraUnit>('units');
  const [tried, setTried] = useState(false);
  const [max, setMax] = useState(false);
  const nameErr = tried && !name.trim();
  const qtyErr = tried && !((num(qty) ?? 0) > 0);
  const add = () => {
    if (!name.trim() || !((num(qty) ?? 0) > 0)) return setTried(true);
    if (extrasCount >= MAX_EXTRAS) return setMax(true);
    onAdd({ name: name.trim(), quantity: qty, unit });
  };
  const label: CSSProperties = { font: font(500, 15), color: P.ink };
  const field = (bad: boolean): CSSProperties => ({
    height: 52,
    padding: '0 12px',
    background: P.surf,
    border: `2px solid ${bad ? P.errFill : P.line2}`,
    borderRadius: 6,
    color: P.ink,
    outline: 'none',
    textAlign: 'start',
  });
  const err = (t: string) => <div style={{ font: font(500, 15), color: P.errText }}>{t}</div>;
  return (
    <Sheet
      z={Z.sheet}
      onDismiss={onClose}
      dataSheet="extra"
      label={tr('receive.v3.addExtra')}
      style={{
        borderTop: `1px solid ${P.line2}`,
        paddingTop: 18,
        paddingInline: 16,
        paddingBottom: 'max(14px, env(safe-area-inset-bottom))',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <CloseButton label={tr('receive.v3.close')} onClick={onClose} style={cornerX} />
      <div style={{ font: font(600, 19), color: P.ink, paddingBottom: 8, borderBottom: `1px solid ${P.line}` }}>
        {tr('receive.v3.addExtra')}
      </div>
      <label htmlFor="v3-extra-name" style={label}>
        {tr('receive.v3.extraName')}
      </label>
      <input
        id="v3-extra-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        type="text"
        dir={rtl ? 'rtl' : 'ltr'}
        maxLength={200}
        autoComplete="off"
        style={{ ...field(nameErr), font: font(400, 17) }}
      />
      {nameErr && err(tr('receive.v3.err.name'))}
      <label htmlFor="v3-extra-qty" style={label}>
        {tr('receive.v3.extraQty')}
      </label>
      <input
        id="v3-extra-qty"
        value={qty}
        onChange={(e) => setQty(e.target.value.replace(/[^\d.,]/g, ''))}
        inputMode="decimal"
        pattern="[0-9]*[.,]?[0-9]*"
        data-keyboard="decimal"
        dir="ltr"
        autoComplete="off"
        style={{ ...field(qtyErr), font: font(600, 22), textAlign: rtl ? 'right' : 'left' }}
      />
      {qtyErr && err(tr('receive.v3.err.qty'))}
      <span style={label}>{tr('receive.v3.extraUnit')}</span>
      <div role="radiogroup" aria-label={tr('receive.v3.extraUnit')} style={{ display: 'grid', gridTemplateColumns: 'repeat(5,minmax(0,1fr))', gap: 6 }}>
        {EXTRA_UNITS.map((u) => {
          const on = unit === u;
          return (
            <button
              key={u}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => setUnit(u)}
              style={{
                height: 48,
                borderRadius: 6,
                font: font(500, 15),
                background: on ? P.ink : P.surf,
                color: on ? P.bg : P.ink,
                border: `1px solid ${on ? P.ink : P.line}`,
                padding: 0,
              }}
            >
              {EXTRA_UNIT_LABELS[u][lang]}
            </button>
          );
        })}
      </div>
      {max && err(tr('receive.v3.err.maxExtras'))}
      <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
        <button
          type="button"
          onClick={onClose}
          style={{ ...BARE, ...UNDERLINE, flex: 'none', height: 56, padding: '0 4px', whiteSpace: 'nowrap', font: font(400, 15) }}
        >
          {tr('receive.v3.closeLink')}
        </button>
        <button
          type="button"
          onClick={add}
          style={{ flex: 2, height: 56, border: 'none', borderRadius: 6, background: P.acc, color: P.accInk, font: font(600, 17) }}
        >
          {tr('receive.v3.add')}
        </button>
      </div>
    </Sheet>
  );
}

// ── 5.24 Save error ──────────────────────────────────────────────────────

export function ErrorSheet({ text, tr, onRetry, onClose }: { text: string; tr: Tr; onRetry: () => void; onClose: () => void }) {
  return (
    <Sheet
      z={Z.error}
      onDismiss={onClose}
      dataSheet="error"
      label={text}
      style={{
        borderTop: `4px solid ${P.errFill}`,
        paddingTop: 20,
        paddingInline: 16,
        paddingBottom: 'max(14px, env(safe-area-inset-bottom))',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <CloseButton label={tr('receive.v3.close')} onClick={onClose} style={cornerX} />
      <div role="alert" style={{ font: font(600, 20, 1.4), color: P.ink, paddingInlineEnd: 40 }}>
        {text}
      </div>
      <button
        type="button"
        onClick={onRetry}
        style={{ height: 58, marginTop: 4, border: 'none', borderRadius: 6, background: P.acc, color: P.accInk, font: font(600, 18) }}
      >
        {tr('receive.v3.retry')}
      </button>
      <button
        type="button"
        onClick={onClose}
        style={{ ...BARE, ...UNDERLINE, alignSelf: 'center', height: 44, padding: '0 4px', whiteSpace: 'nowrap', font: font(400, 15) }}
      >
        {tr('receive.v3.closeLink')}
      </button>
    </Sheet>
  );
}
