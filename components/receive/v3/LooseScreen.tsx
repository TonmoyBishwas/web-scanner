'use client';

/**
 * Receive form v3, the loose sub-screen (states 2–3): "מה הגיע מחוץ למשטח?",
 * a search, one checkbox row per note line (checked → a stepper of how many
 * of its packages came loose, "מתוך 3 דליים"), and "אישור".
 */
import type { CSSProperties } from 'react';
import type { FormLine } from '@/lib/receipt-form';
import { searchLines } from '@/lib/receipt-form-search';
import { CloseButton, V3Icon } from './icons';
import { SearchField } from './ListHeader';
import { BARE, P, font } from './tokens';
import { lineName, notePackages, type Lang, type Tr } from './texts';
import css from './v3.module.css';

export interface LooseScreenProps {
  lines: FormLine[];
  loose: Record<number, number>;
  /** Per line: its package count now (cartons, or 1 when blank) and that count in words ("3 דליים"). */
  packs: Record<number, { n: number; text: string }>;
  query: string;
  lang: Lang;
  rtl: boolean;
  tr: Tr;
  onQuery: (q: string) => void;
  onToggle: (index: number) => void;
  onStep: (index: number, delta: 1 | -1) => void;
  onConfirm: () => void;
  onClose: () => void;
}

const stepBtn: CSSProperties = {
  width: 44,
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

export function LooseScreen(p: LooseScreenProps) {
  const { tr, lang } = p;
  const found = searchLines(p.lines, p.query, { allNames: true });
  const count = Object.keys(p.loose).length;
  return (
    <div data-screen="loose" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ height: 56, flex: 'none', display: 'flex', alignItems: 'center', gap: 8, paddingInline: '16px 6px' }}>
        <span style={{ flex: 1, minWidth: 0, font: font(600, 19), color: P.ink }}>{tr('receive.v3.looseTitle')}</span>
        <CloseButton label={tr('receive.v3.close')} onClick={p.onClose} />
      </div>
      <div style={{ flex: 'none', padding: '0 12px 8px', display: 'flex' }}>
        <SearchField
          value={p.query}
          onChange={p.onQuery}
          placeholder={tr('receive.v3.search')}
          clearLabel={tr('receive.v3.clear')}
          rtl={p.rtl}
        />
      </div>
      <div
        className={css.scroll}
        style={{ flex: 1, minHeight: 0, overflowY: 'auto', borderTop: `1px solid ${P.line}`, display: 'flex', flexDirection: 'column' }}
      >
        {found.lines.map((line) => {
          const on = line.index in p.loose;
          const pk = p.packs[line.index] ?? { n: line.cartons || 1, text: notePackages(line, lang) };
          const tot = pk.n;
          const n = on ? p.loose[line.index] : tot;
          return (
            <div
              key={line.index}
              data-loose-row={line.index}
              style={{ flex: 'none', padding: '0 16px', borderBottom: `1px solid ${P.line}`, background: on ? P.surf : 'transparent' }}
            >
              <button
                type="button"
                onClick={() => p.onToggle(line.index)}
                role="checkbox"
                aria-checked={on}
                style={{ ...BARE, width: '100%', minHeight: 60, display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', textAlign: 'start' }}
              >
                <span style={{ flex: 'none', display: 'flex' }}>
                  <V3Icon name={on ? 'check_box' : 'check_box_outline_blank'} size={24} />
                </span>
                <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ font: font(500, 16, 1.3) }}>{lineName(line, lang)}</span>
                  <span style={{ font: font(400, 14), color: P.ink2 }}>
                    {tr('receive.v3.looseSub', { code: `\u2068${line.code}\u2069`, packs: pk.text })}
                  </span>
                </span>
              </button>
              {on && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingInlineStart: 34, paddingBottom: 10 }}>
                  <button type="button" aria-label="-1" onClick={() => p.onStep(line.index, -1)} style={stepBtn}>
                    <V3Icon name="remove" size={24} />
                  </button>
                  <bdi style={{ minWidth: 36, textAlign: 'center', font: font(600, 20), color: P.ink }}>{n}</bdi>
                  <button type="button" aria-label="+1" onClick={() => p.onStep(line.index, 1)} style={stepBtn}>
                    <V3Icon name="add" size={24} />
                  </button>
                  <span style={{ font: font(400, 16), color: P.ink }}>
                    {tr('receive.v3.looseOf', { packs: pk.text })}
                  </span>
                </div>
              )}
            </div>
          );
        })}
        {found.active && found.lines.length === 0 && (
          <div style={{ padding: '20px 16px', font: font(600, 18), color: P.ink }}>{tr('receive.v3.notFound')}</div>
        )}
      </div>
      <div style={{ flex: 'none', paddingTop: 8, paddingInline: 12, paddingBottom: 'max(12px, env(safe-area-inset-bottom))', borderTop: `1px solid ${P.line}` }}>
        <button
          type="button"
          onClick={p.onConfirm}
          disabled={count === 0}
          style={{
            width: '100%',
            height: 60,
            border: count ? 'none' : `1px solid ${P.line}`,
            borderRadius: 6,
            background: count ? P.acc : P.surf,
            color: count ? P.accInk : P.line2,
            font: font(600, 19),
          }}
        >
          {tr('receive.v3.confirmBtn')}
        </button>
      </div>
    </div>
  );
}
