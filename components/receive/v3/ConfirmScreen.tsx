'use client';

/**
 * Receive form v3, "אישור קליטה" (state 19): the same cards read-only (values,
 * expiry + pallet), the items not on the note, "חזרה לרשימה" and
 * "אישור ושליחה". A tap on a card goes back to the list with it open.
 */
import { EXTRA_UNIT_LABELS, type FormLine } from '@/lib/receipt-form';
import type { V3Draft } from '@/lib/receive-v3';
import { NumberBox } from './LineCard';
import { BARE, I, P, UNDERLINE, font } from './tokens';
import { confirmExpiryText, lineName, valuesText, type Lang, type Tr } from './texts';
import css from './v3.module.css';

export function ConfirmScreen({
  lines,
  draft,
  lang,
  tr,
  onGo,
  onBack,
  onSubmit,
}: {
  lines: FormLine[];
  draft: V3Draft;
  lang: Lang;
  tr: Tr;
  onGo: (index: number) => void;
  onBack: () => void;
  onSubmit: () => void;
}) {
  const byIndex = new Map(draft.lines.map((d) => [d.index, d]));
  return (
    <>
      <div
        data-screen="confirm"
        style={{ flex: 'none', padding: '4px 16px 12px', borderBottom: `1px solid ${P.line}`, display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}
      >
        <h1 style={{ margin: 0, font: font(600, 22), color: P.ink }}>{tr('receive.v3.confirmTitle')}</h1>
      </div>
      <div
        className={css.scroll}
        style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '8px 10px 12px', background: P.surf, display: 'flex', flexDirection: 'column', gap: 8 }}
      >
        {lines.map((line) => {
          const d = byIndex.get(line.index);
          if (!d) return null;
          return (
            <button
              key={line.index}
              type="button"
              onClick={() => onGo(line.index)}
              data-confirm-row={line.index}
              style={{
                width: '100%',
                flex: 'none',
                display: 'flex',
                alignItems: 'flex-start',
                gap: 12,
                padding: '10px 12px',
                background: P.bg,
                border: `1px solid ${P.line}`,
                borderRadius: 6,
                textAlign: 'start',
                color: P.ink,
              }}
            >
              <NumberBox n={line.index} />
              <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                <span style={{ font: font(500, 17, 1.3), paddingTop: 2 }}>{lineName(line, lang)}</span>
                <span style={{ font: font(400, 15, 1.4), color: P.ink2 }}>{valuesText(line, d, lang, tr)}</span>
                <span style={{ font: font(400, 15, 1.4), color: P.ink2 }}>{confirmExpiryText(line, d, draft, tr)}</span>
              </span>
            </button>
          );
        })}
        {draft.extras.length > 0 && (
          <>
            <div style={{ flex: 'none', padding: '16px 0 4px', font: font(600, 15), color: P.ink }}>{tr('receive.v3.extrasTitle')}</div>
            {draft.extras.map((x) => (
              <div
                key={x.key}
                style={{ minHeight: 56, flex: 'none', display: 'flex', flexDirection: 'column', justifyContent: 'center', borderBottom: `1px solid ${P.line}` }}
              >
                <span style={{ font: font(500, 17), color: P.ink }}>{x.name}</span>
                <span style={{ font: font(400, 15), color: P.ink2 }}>{`${I(x.quantity)} ${EXTRA_UNIT_LABELS[x.unit][lang]}`}</span>
              </div>
            ))}
          </>
        )}
      </div>
      <div
        style={{
          flex: 'none',
          paddingTop: 8,
          paddingInline: 12,
          paddingBottom: 'max(12px, env(safe-area-inset-bottom))',
          borderTop: `1px solid ${P.line}`,
          display: 'flex',
          gap: 8,
        }}
      >
        <button
          type="button"
          onClick={onBack}
          style={{ ...BARE, ...UNDERLINE, flex: 'none', height: 60, padding: '0 4px', whiteSpace: 'nowrap', font: font(400, 15) }}
        >
          {tr('receive.v3.backToList')}
        </button>
        <button
          type="button"
          onClick={onSubmit}
          style={{ flex: 1, height: 60, border: 'none', borderRadius: 6, background: P.okFill, color: P.okInk, font: font(600, 19) }}
        >
          {tr('receive.v3.submit')}
        </button>
      </div>
    </>
  );
}
