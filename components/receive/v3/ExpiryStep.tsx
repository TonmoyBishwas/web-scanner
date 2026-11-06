'use client';

/**
 * Receive form v3, rubric 2 "תוקף" (states 9, 10, 18): the big date field
 * (digits only, dots added, 6 digits → 20yy), the calendar button over a
 * hidden native date input, "אין תוקף", "פיצול לפי תוקף"; or, when split,
 * 2–3 rows of quantity + date with the running balance.
 */
import { useRef, type ChangeEvent, type FocusEvent } from 'react';
import { fmtQty, type FormLine } from '@/lib/receipt-form';
import { V3, dateCheck, splitState, type V3LineDraft } from '@/lib/receive-v3';
import { V3Icon } from './icons';
import { BARE, I, P, UNDERLINE, font, numInput } from './tokens';
import { dateErrorText, num, splitAmountText, type Lang, type Tr } from './texts';

const digitsOf = (v: string) => (v || '').replace(/\D/g, '');

export interface ExpiryStepProps {
  line: FormLine;
  d: V3LineDraft;
  today: string;
  lang: Lang;
  tr: Tr;
  /** Typed into the single field (raw value + caret), or picked in the calendar (`dd.mm.yyyy`). */
  onType: (raw: string, caret: number | null) => void;
  onPick: (dotted: string) => void;
  onFocus: (e: FocusEvent<HTMLInputElement>) => void;
  onBlur: () => void;
  onToggleNoExpiry: () => void;
  onStartSplit: () => void;
  onSplitQty: (row: number, value: string) => void;
  onSplitType: (row: number, raw: string, caret: number | null) => void;
  onSplitBlur: (row: number) => void;
  onSplitRemove: (row: number) => void;
  onSplitAdd: () => void;
}

export function ExpiryStep(p: ExpiryStepProps) {
  const { d, today, lang, tr } = p;
  const cal = useRef<HTMLInputElement>(null);

  if (d.split) return <SplitRows {...p} />;

  const dg = digitsOf(d.expiry);
  const dc = dg.length === 8 ? dateCheck(d.expiry, today) : null;
  const err = dg.length === 8 ? dateErrorText(d.expiry, today, tr) : null;
  const valid = dc === 'ok';
  const border = err ? P.errFill : valid ? P.okFill : P.line2;

  const openCalendar = () => {
    const el = cal.current as (HTMLInputElement & { showPicker?: () => void }) | null;
    if (!el) return;
    if (typeof el.showPicker === 'function') {
      try {
        el.showPicker();
        return;
      } catch {
        /* not allowed here: fall back to a click */
      }
    }
    el.click();
  };
  const onCal = (e: ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    if (!v) return;
    const [y, mo, dd] = v.split('-');
    p.onPick(`${dd}.${mo}.${y}`);
  };

  return (
    <div data-group="2-expiry" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', gap: 8, position: 'relative' }}>
        <input
          dir="ltr"
          inputMode="numeric"
          pattern="[0-9]*"
          data-keyboard="numeric"
          autoComplete="off"
          value={d.expiry}
          onChange={(e) => p.onType(e.target.value, e.target.selectionStart)}
          onFocus={p.onFocus}
          onBlur={p.onBlur}
          disabled={d.noExpiry}
          placeholder={tr('receive.v3.datePlaceholder')}
          aria-label={tr('receive.v3.expiryDate')}
          aria-invalid={err ? true : undefined}
          style={{
            flex: 1,
            minWidth: 0,
            height: 64,
            padding: '0 14px',
            textAlign: lang === 'he' ? 'right' : 'left',
            font: font(600, 30),
            background: P.bg,
            border: `2px solid ${border}`,
            borderRadius: 6,
            color: P.ink,
            opacity: d.noExpiry ? 0.3 : 1,
            outline: 'none',
          }}
        />
        <button
          type="button"
          onClick={openCalendar}
          disabled={d.noExpiry}
          aria-label={tr('receive.v3.openCalendar')}
          title={tr('receive.v3.openCalendar')}
          style={{ ...BARE, width: 40, height: 64, flex: 'none', color: P.ink2, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <V3Icon name="calendar_month" size={22} />
        </button>
        <input
          type="date"
          ref={cal}
          onChange={onCal}
          tabIndex={-1}
          aria-hidden="true"
          style={{ position: 'absolute', insetInlineEnd: 0, bottom: 0, width: 1, height: 1, opacity: 0, pointerEvents: 'none' }}
        />
      </div>
      {err && <div style={{ font: font(500, 15), color: P.errText }}>{err}</div>}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          type="button"
          onClick={p.onToggleNoExpiry}
          role="checkbox"
          aria-checked={d.noExpiry}
          style={{
            ...BARE,
            height: 44,
            padding: '0 2px',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            font: font(400, 15),
            opacity: valid ? 0.4 : 1,
          }}
        >
          <V3Icon name={d.noExpiry ? 'check_box' : 'check_box_outline_blank'} size={24} />
          {tr('receive.v3.noExpiry')}
        </button>
        {!d.noExpiry && (
          <button
            type="button"
            onClick={p.onStartSplit}
            style={{ ...BARE, ...UNDERLINE, marginInlineStart: 'auto', height: 44, padding: '0 2px', whiteSpace: 'nowrap', font: font(400, 15) }}
          >
            {tr('receive.v3.split')}
          </button>
        )}
      </div>
    </div>
  );
}

function SplitRows(p: ExpiryStepProps) {
  const { line, d, today, lang, tr } = p;
  const rows = d.split ?? [];
  const s = splitState(line, d, today);
  const weighed = line.weighed;
  const kbMode = weighed ? 'decimal' : 'numeric';
  const kbPattern = weighed ? '[0-9]*[.,]?[0-9]*' : '[0-9]*';
  const errText = s.over
    ? tr('receive.v3.splitOver', { sum: I(fmtQty(s.sum)), n: I(fmtQty(s.total)) })
    : s.bad === 'invalid'
      ? tr('receive.v3.err.dateInvalid')
      : s.bad === 'past'
        ? tr('receive.v3.err.datePast')
        : s.bad === 'far'
          ? tr('receive.v3.err.dateFar')
          : '';
  const amount = splitAmountText(line, d, s.total, lang);
  const exact = !s.over && Math.abs(s.left) < 0.0005;
  const balance = s.over
    ? ''
    : exact
      ? tr('receive.v3.splitAll', { n: I(fmtQty(s.total)), amount })
      : tr('receive.v3.splitLeft', { left: I(fmtQty(s.left)), amount });
  const balanceColor = exact && !s.missing && !s.bad ? P.okText : P.ink;

  return (
    <div data-group="2-expiry" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {rows.map((r, k) => {
        const q = num(r.qty);
        const dg = digitsOf(r.date);
        const dc = dg.length === 8 ? dateCheck(r.date, today) : null;
        const dBorder = dc && dc !== 'ok' ? P.errFill : dc === 'ok' ? P.okFill : P.ink;
        return (
          <div key={k} data-split-row={k} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <input
              value={r.qty}
              onChange={(e) => p.onSplitQty(k, e.target.value.replace(/[^\d.,]/g, ''))}
              onFocus={p.onFocus}
              onBlur={p.onBlur}
              inputMode={kbMode}
              pattern={kbPattern}
              data-keyboard={kbMode}
              dir="ltr"
              autoComplete="off"
              placeholder={tr('receive.v3.splitQty')}
              aria-label={tr('receive.v3.splitQty')}
              style={numInput(56, 44, 22, s.over && (q ?? 0) > 0 ? P.errFill : P.line2)}
            />
            <input
              value={r.date}
              onChange={(e) => p.onSplitType(k, e.target.value, e.target.selectionStart)}
              onFocus={p.onFocus}
              onBlur={() => p.onSplitBlur(k)}
              inputMode="numeric"
              pattern="[0-9]*"
              data-keyboard="numeric"
              dir="ltr"
              autoComplete="off"
              placeholder={dg.length ? tr('receive.v3.datePlaceholder') : tr('receive.v3.splitNoDate')}
              aria-label={tr('receive.v3.expiryDate')}
              style={{
                flex: 1,
                minWidth: 0,
                height: 44,
                padding: '0 10px',
                textAlign: lang === 'he' ? 'right' : 'left',
                font: font(600, 22),
                background: P.bg,
                border: `2px solid ${dBorder}`,
                borderRadius: 6,
                color: P.ink,
                outline: 'none',
              }}
            />
            <button
              type="button"
              onClick={() => p.onSplitRemove(k)}
              aria-label={tr('receive.v3.remove')}
              title={tr('receive.v3.remove')}
              style={{ ...BARE, width: 32, height: 44, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              <V3Icon name="close" size={22} />
            </button>
          </div>
        );
      })}
      {errText && <div style={{ font: font(500, 15), color: P.errText }}>{errText}</div>}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 36 }}>
        {rows.length < V3.MAX_SPLIT_ROWS && (
          <button
            type="button"
            onClick={p.onSplitAdd}
            style={{ ...BARE, ...UNDERLINE, height: 36, padding: '0 2px', whiteSpace: 'nowrap', font: font(500, 16) }}
          >
            {tr('receive.v3.splitAdd')}
          </button>
        )}
        <span style={{ marginInlineStart: 'auto', font: font(600, 16), color: balanceColor }}>{balance}</span>
      </div>
    </div>
  );
}
