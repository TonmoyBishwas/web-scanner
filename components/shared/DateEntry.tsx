'use client';

/**
 * A date the worker can TYPE (numeric keypad, dd.mm.yyyy, dots added for him)
 * or PICK (calendar button → the phone's own date picker). Android Chrome
 * opens only the calendar for <input type="date">, never the keyboard
 * (David, 20/10/2026) — so the visible field is text and the native date
 * input is hidden behind the button.
 *
 * `value` / `onChange` speak the draft's format: ISO `YYYY-MM-DD` when the
 * date is whole, '' while empty or unfinished, the raw text when it is wrong
 * (the caller turns that into "Not a valid date"). Day first; a 2-digit year
 * is 20yy and is only judged once the field is left (lib/date-entry.ts).
 */
import { useRef, useState } from 'react';
import { isRealIsoDate } from '@/lib/receipt-form';
import { entryToValue, isoToDotted, maskDateInput } from '@/lib/date-entry';

/** What the field shows for a value set from outside. */
const shownFor = (value: string) => (isRealIsoDate(value) ? isoToDotted(value) : value);

export function DateEntry({
  id,
  value,
  onChange,
  disabled = false,
  invalid = false,
  min,
  max,
  placeholder,
  calendarLabel,
  className = 'flex-1',
  inputClassName,
  buttonClassName,
}: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  invalid?: boolean;
  /** ISO bounds for the calendar only; typed dates are judged by the caller. */
  min?: string;
  max?: string;
  placeholder: string;
  calendarLabel: string;
  /** Classes of the wrapper (field + button) — its share of the caller's row. */
  className?: string;
  inputClassName: string;
  buttonClassName: string;
}) {
  const [text, setText] = useState(() => shownFor(value));
  // The last value THIS field sent up (or took in). A different `value`
  // arriving means someone else set it ("same date for all", "no expiry", a
  // restored draft) — re-show it. Compared during render, not in an effect.
  const [sent, setSent] = useState(value);
  const [wasDisabled, setWasDisabled] = useState(disabled);
  if (value !== sent || disabled !== wasDisabled) {
    setSent(value);
    setWasDisabled(disabled);
    // "No expiry" greys the field out: a half-typed date (which sent '')
    // goes with it, though the value itself did not change.
    if (value !== sent || disabled) setText(shownFor(value));
  }
  const picker = useRef<HTMLInputElement>(null);

  const send = (v: string) => {
    setSent(v);
    if (v !== value) onChange(v);
  };

  const commit = () => {
    const v = entryToValue(text, true);
    if (isRealIsoDate(v)) setText(isoToDotted(v)); // 1.5.27 → 01.05.2027
    send(v);
  };

  const openCalendar = () => {
    const el = picker.current;
    if (!el || disabled) return;
    el.value = isRealIsoDate(value) ? value : '';
    try {
      el.showPicker(); // Chrome 99+, Safari 16+
    } catch {
      el.focus();
      el.click();
    }
  };

  return (
    <div className={`relative flex min-w-0 gap-2 ${className}`}>
      <input
        id={id}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        enterKeyHint="done"
        dir="ltr"
        maxLength={10}
        placeholder={placeholder}
        aria-invalid={invalid}
        disabled={disabled}
        value={text}
        onChange={(e) => {
          const shown = maskDateInput(e.target.value);
          setText(shown);
          send(entryToValue(shown, false));
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur(); // "done" on the keypad closes the date
        }}
        onBlur={commit}
        className={inputClassName}
      />
      <button
        type="button"
        aria-label={calendarLabel}
        title={calendarLabel}
        disabled={disabled}
        onClick={openCalendar}
        className={buttonClassName}
      >
        <span aria-hidden className="mi" style={{ fontSize: 22 }}>
          calendar_month
        </span>
      </button>
      {/* The phone's own date picker. Rendered (showPicker refuses display:none) but invisible and out of the tab order. */}
      <input
        ref={picker}
        type="date"
        tabIndex={-1}
        aria-hidden
        min={min}
        max={max}
        className="pointer-events-none absolute bottom-0 end-0 h-px w-px opacity-0 [color-scheme:dark]"
        onChange={(e) => {
          const iso = e.target.value;
          if (!isRealIsoDate(iso)) return;
          setText(isoToDotted(iso));
          send(iso);
        }}
      />
    </div>
  );
}
