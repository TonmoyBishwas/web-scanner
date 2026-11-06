'use client';

/**
 * Receive form v3, rubric 3 "משטח" (states 11, 12): the label row ("בחירה",
 * or "משטח 2 · שנה", or × while the list is open) and the inline listbox
 * `משטח 1 … משטח n`, `מחוץ למשטח` — one tap picks. The highlighted option is
 * the current value, else the last pallet used, else 1.
 */
import { CloseButton } from './icons';
import { Rubric, RubricLabel, type RubricState } from './Rail';
import { BARE, I, P, UNDERLINE, font } from './tokens';
import type { Tr } from './texts';

export type PalletPick = number | 'loose';

export interface PalletStepProps {
  state: RubricState;
  /** The pallet is set (a number, loose, or "nothing arrived"). */
  isSet: boolean;
  /**
   * Nothing arrived (quantity 0): no pallet is needed [INFERRED], so the step
   * shows its label only — no "בחירה", no list.
   */
  none?: boolean;
  /** `משטח 2` / `מחוץ למשטח` / `1 מחוץ למשטח`; '' when not set. */
  name: string;
  /** The inline list is open. */
  open: boolean;
  pallets: number;
  /** The current value (a number or 'loose'), else null. */
  value: PalletPick | null;
  lastPallet: number | null;
  tr: Tr;
  onChange: () => void;
  onClose: () => void;
  onPick: (v: PalletPick) => void;
}

export function PalletStep(p: PalletStepProps) {
  const { tr } = p;
  const hi: PalletPick = p.value ?? p.lastPallet ?? 1;
  const opts: { v: PalletPick; t: string }[] = [];
  for (let n = 1; n <= p.pallets; n += 1) opts.push({ v: n, t: tr('receive.v3.palletN', { n: I(n) }) });
  opts.push({ v: 'loose', t: tr('receive.v3.loose') });
  const link = { ...BARE, height: 36, margin: '-7px 0', padding: '0 2px', whiteSpace: 'nowrap' as const, font: font(400, 15) };

  const labelRow = (
    <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '4px 10px', minHeight: 22 }}>
      <RubricLabel state={p.state}>{tr('receive.v3.stepPallet')}</RubricLabel>
      {p.open && !p.none && (
        <CloseButton
          label={tr('receive.v3.close')}
          onClick={p.onClose}
          style={{ marginBlock: -11, marginInlineStart: 'auto', marginInlineEnd: 0 }}
        />
      )}
      {!p.open && !p.none && !p.isSet && (
        <button type="button" onClick={p.onChange} style={{ ...link, ...UNDERLINE }}>
          {tr('receive.v3.choose')}
        </button>
      )}
      {!p.open && !p.none && p.isSet && (
        <button type="button" onClick={p.onChange} style={link}>
          {p.name ? `${p.name} · ` : ''}
          <span style={UNDERLINE}>{tr('receive.v3.change')}</span>
        </button>
      )}
    </div>
  );

  return (
    <Rubric n={3} state={p.state} label={labelRow} connector={false} gap={2}>
      {p.open && !p.none && (
        <div role="listbox" aria-label={tr('receive.v3.stepPallet')} style={{ display: 'flex', flexDirection: 'column', borderTop: `1px solid ${P.line}` }}>
          {opts.map((o) => {
            const on = p.value === o.v;
            const h = hi === o.v;
            return (
              <button
                key={String(o.v)}
                type="button"
                role="option"
                aria-selected={on}
                onClick={() => p.onPick(o.v)}
                style={{
                  minHeight: 40,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '0 8px',
                  background: h ? P.surf : 'transparent',
                  border: 'none',
                  borderBottom: `1px solid ${P.line}`,
                  color: P.ink,
                  textAlign: 'start',
                  font: font(h ? 500 : 400, 16),
                }}
              >
                <span style={{ flex: 1, minWidth: 0 }}>{o.t}</span>
              </button>
            );
          })}
        </div>
      )}
    </Rubric>
  );
}
