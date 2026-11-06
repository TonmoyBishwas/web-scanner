'use client';

/**
 * Receive form v3, the list's bottom bar (5.18): "לא מולאו {k} שורות ←" (to the
 * first unfilled line) until every line is ready, then the green
 * "אישור ושליחה" (to the confirmation). Hidden while a number field has focus.
 */
import { ForwardIcon } from './icons';
import { I, P, font } from './tokens';
import type { Tr } from './texts';

export function BottomBar({
  remaining,
  rtl,
  tr,
  onNext,
  onConfirm,
}: {
  remaining: number;
  rtl: boolean;
  tr: Tr;
  onNext: () => void;
  onConfirm: () => void;
}) {
  return (
    <footer
      data-part="bar"
      style={{
        flex: 'none',
        paddingTop: 8,
        paddingInline: 12,
        paddingBottom: 'max(12px, env(safe-area-inset-bottom))',
        borderTop: `1px solid ${P.line}`,
      }}
    >
      {remaining > 0 ? (
        <button
          type="button"
          onClick={onNext}
          style={{
            width: '100%',
            height: 60,
            border: `1px solid ${P.line2}`,
            borderRadius: 6,
            background: P.bg,
            color: P.ink,
            font: font(500, 17),
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
          }}
        >
          {remaining === 1 ? tr('receive.v3.remainingOne') : tr('receive.v3.remaining', { k: I(remaining) })}
          <ForwardIcon rtl={rtl} size={20} />
        </button>
      ) : (
        <button
          type="button"
          onClick={onConfirm}
          style={{ width: '100%', height: 60, border: 'none', borderRadius: 6, background: P.okFill, color: P.okInk, font: font(600, 19) }}
        >
          {tr('receive.v3.submit')}
        </button>
      )}
    </footer>
  );
}
