'use client';

/**
 * The receive form's shared pieces (/receive/[id]): icons, field labels and
 * errors, chips, input classes and the line status colours. Moved out of
 * ReceiptForm.tsx unchanged (28/10) so the redesign's compact card and
 * expiry walk (components/receive/*) draw exactly the same controls.
 */
import type { TranslationKey } from '@/lib/i18n';
import type { LineError } from '@/lib/receipt-form';

export type Tr = (key: TranslationKey, vars?: Record<string, string | number>) => string;

export const LINE_ERROR_KEY: Record<LineError, TranslationKey> = {
  qty_invalid: 'receive.err.qty',
  cartons_invalid: 'receive.err.cartons',
  packaging_invalid: 'receive.err.packaging',
  expiry_missing: 'receive.err.expiryMissing',
  expiry_invalid: 'receive.err.expiryInvalid',
  expiry_not_future: 'receive.err.expiryNotFuture',
  expiry_too_far: 'receive.err.expiryTooFar',
  expiry_conflict: 'receive.err.expiryConflict',
  gap_missing: 'receive.err.gapMissing',
  gap_invalid: 'receive.err.gapMissing',
  gap_note_missing: 'receive.err.gapNoteMissing',
  gap_note_too_long: 'receive.err.gapNoteTooLong',
};

/**
 * "Still to fill in" (amber) vs "this value is wrong" (red). A fresh form
 * has every food line missing its expiry — that is the job, not a mistake,
 * so it must not open as a wall of red.
 */
export const TODO_ERRORS: ReadonlySet<LineError> = new Set(['expiry_missing', 'gap_missing', 'gap_note_missing']);

export type LineStatus = 'ready' | 'todo' | 'fix';

export function lineStatus(errors: LineError[]): LineStatus {
  if (!errors.length) return 'ready';
  return errors.every((e) => TODO_ERRORS.has(e)) ? 'todo' : 'fix';
}

export const INPUT =
  'w-full min-w-0 min-h-12 rounded-xl border-2 bg-sunken px-3 text-base text-ink placeholder:text-ink-muted ' +
  'transition-colors focus:outline-none focus:border-brand focus:ring-4 focus:ring-brand-ring [color-scheme:dark]';
export const OK_BORDER = 'border-line-strong';
export const DONE_BORDER = 'border-ok/70';
export const TODO_BORDER = 'border-warn';
export const BAD_BORDER = 'border-danger';
/** A date field + its calendar button: grows, but never so narrow that "dd.mm.yyyy" is cut — the row's next control wraps instead. */
export const DATE_ROW = 'min-w-[13rem] flex-1';
export const CALENDAR_BTN =
  'grid h-12 w-12 shrink-0 place-items-center rounded-xl border-2 border-line-strong bg-tile text-ink active:scale-95 disabled:opacity-35';

export function Icon({ name, size = 20, className = '' }: { name: string; size?: number; className?: string }) {
  return (
    <span aria-hidden className={`mi shrink-0 ${className}`} style={{ fontSize: size }}>
      {name}
    </span>
  );
}

export function FieldError({ text, tone = 'danger' }: { text: string | null; tone?: 'danger' | 'warn' }) {
  if (!text) return null;
  return (
    <p
      className={`mt-1.5 flex items-start gap-1 text-sm font-bold ${
        tone === 'warn' ? 'text-warn-weak-ink' : 'text-danger-weak-ink'
      }`}
    >
      <Icon name={tone === 'warn' ? 'edit' : 'error'} size={17} className="mt-px" />
      <span>{text}</span>
    </p>
  );
}

export function FieldLabel({ htmlFor, icon, children }: { htmlFor?: string; icon: string; children: React.ReactNode }) {
  return (
    <label className="mb-1.5 flex items-center gap-1.5 text-sm font-bold text-ink-body" htmlFor={htmlFor}>
      <Icon name={icon} size={18} className="text-brand-weak-ink" />
      {children}
    </label>
  );
}

export function Chip({
  active,
  onClick,
  children,
  icon,
  tone = 'brand',
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  icon?: string;
  tone?: 'brand' | 'warn' | 'ok' | 'danger';
}) {
  const on = {
    brand: 'bg-brand border-brand text-white shadow-[0_0_0_3px_var(--brand-ring)]',
    warn: 'bg-warn border-warn text-[#1a1100] shadow-[0_0_0_3px_rgba(245,158,11,0.3)]',
    ok: 'bg-ok border-ok text-[#04210f] shadow-[0_0_0_3px_rgba(34,197,94,0.3)]',
    danger: 'bg-danger border-danger text-white shadow-[0_0_0_3px_rgba(239,68,68,0.3)]',
  }[tone];
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`inline-flex min-h-11 items-center justify-center gap-1.5 rounded-full border-2 px-4 text-sm font-extrabold whitespace-nowrap transition-all active:scale-95 ${
        active ? on : 'border-line-strong bg-tile text-ink-body hover:border-ink-muted'
      }`}
    >
      {icon && <Icon name={active ? 'check' : icon} size={18} />}
      {children}
    </button>
  );
}

export const STATUS_STYLE: Record<LineStatus, { card: string; badge: string; pill: string; icon: string }> = {
  ready: {
    card: 'border-ok/45 border-s-ok bg-[linear-gradient(180deg,rgba(34,197,94,0.10),rgba(16,28,34,1)_55%)]',
    badge: 'bg-ok text-[#04210f]',
    pill: 'bg-ok-weak text-ok-weak-ink border-ok/40',
    icon: 'check_circle',
  },
  todo: {
    card: 'border-warn/60 border-s-warn bg-[linear-gradient(180deg,rgba(245,158,11,0.12),rgba(16,28,34,1)_55%)]',
    badge: 'bg-warn text-[#1a1100]',
    pill: 'bg-warn-weak text-warn-weak-ink border-warn/50',
    icon: 'edit_calendar',
  },
  fix: {
    card: 'border-danger/70 border-s-danger bg-[linear-gradient(180deg,rgba(239,68,68,0.13),rgba(16,28,34,1)_55%)]',
    badge: 'bg-danger text-white',
    pill: 'bg-danger-weak text-danger-weak-ink border-danger/50',
    icon: 'error',
  },
};
