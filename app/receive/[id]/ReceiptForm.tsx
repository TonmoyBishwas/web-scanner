'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { t, useLangDir, type TranslationKey } from '@/lib/i18n';
import { DateEntry } from '@/components/shared/DateEntry';
import {
  EXTRA_UNITS,
  EXTRA_UNIT_LABELS,
  MAX_EXTRAS,
  PACKAGING,
  PACKAGING_LABELS,
  addDaysIso,
  applySameDateToAll,
  countWantingExpiry,
  draftStorageKey,
  draftToAnswers,
  expiryError,
  fmtQty,
  formatDdMmYyyy,
  initialDraft,
  isOver,
  isShort,
  markRestNoExpiry,
  maxExpiryIso,
  parseDecimal,
  remainingCount,
  restoreDraft,
  serializeDraft,
  todayInJerusalem,
  validateAnswers,
  type ExtraDraft,
  type ExtraError,
  type FormDraft,
  type FormHeader,
  type FormLanguage,
  type FormLine,
  type Gap,
  type LineDraft,
  type LineError,
  type Packaging,
} from '@/lib/receipt-form';
import { isFinalStatus, isInFlightStatus } from '@/lib/receipt-form-submit';

type Tr = (key: TranslationKey, vars?: Record<string, string | number>) => string;

type Phase =
  | { kind: 'editing' }
  | { kind: 'submitting' }
  | { kind: 'error'; message: string }
  | { kind: 'saved'; savedLines: number | null }
  | { kind: 'already' }
  | { kind: 'inflight' }
  | { kind: 'failed' };

const LINE_ERROR_KEY: Record<LineError, TranslationKey> = {
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

const EXTRA_ERROR_KEY: Record<ExtraError, TranslationKey> = {
  extra_name_missing: 'receive.err.extraName',
  extra_name_too_long: 'receive.err.gapNoteTooLong',
  extra_qty_invalid: 'receive.err.extraQty',
  extra_unit_invalid: 'receive.err.extraQty',
};

/**
 * "Still to fill in" (amber) vs "this value is wrong" (red). A fresh form
 * has every food line missing its expiry — that is the job, not a mistake,
 * so it must not open as a wall of red.
 */
const TODO_ERRORS: ReadonlySet<LineError> = new Set(['expiry_missing', 'gap_missing', 'gap_note_missing']);

type LineStatus = 'ready' | 'todo' | 'fix';

function lineStatus(errors: LineError[]): LineStatus {
  if (!errors.length) return 'ready';
  return errors.every((e) => TODO_ERRORS.has(e)) ? 'todo' : 'fix';
}

const INPUT =
  'w-full min-w-0 min-h-12 rounded-xl border-2 bg-sunken px-3 text-base text-ink placeholder:text-ink-muted ' +
  'transition-colors focus:outline-none focus:border-brand focus:ring-4 focus:ring-brand-ring [color-scheme:dark]';
const OK_BORDER = 'border-line-strong';
const DONE_BORDER = 'border-ok/70';
const TODO_BORDER = 'border-warn';
const BAD_BORDER = 'border-danger';
/** A date field + its calendar button: grows, but never so narrow that "dd.mm.yyyy" is cut — the row's next control wraps instead. */
const DATE_ROW = 'min-w-[13rem] flex-1';
const CALENDAR_BTN =
  'grid h-12 w-12 shrink-0 place-items-center rounded-xl border-2 border-line-strong bg-tile text-ink active:scale-95 disabled:opacity-35';

function Icon({ name, size = 20, className = '' }: { name: string; size?: number; className?: string }) {
  return (
    <span aria-hidden className={`mi shrink-0 ${className}`} style={{ fontSize: size }}>
      {name}
    </span>
  );
}

function FieldError({ text, tone = 'danger' }: { text: string | null; tone?: 'danger' | 'warn' }) {
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

function FieldLabel({ htmlFor, icon, children }: { htmlFor?: string; icon: string; children: React.ReactNode }) {
  return (
    <label className="mb-1.5 flex items-center gap-1.5 text-sm font-bold text-ink-body" htmlFor={htmlFor}>
      <Icon name={icon} size={18} className="text-brand-weak-ink" />
      {children}
    </label>
  );
}

function Chip({
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

const STATUS_STYLE: Record<LineStatus, { card: string; badge: string; pill: string; icon: string }> = {
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

// ── One delivery-note line ───────────────────────────────────────────────

interface LineCardProps {
  line: FormLine;
  d: LineDraft;
  /** The line's error codes joined with ',' — a string, so memo compares cheaply. */
  errKey: string;
  language: FormLanguage;
  today: string;
  /** Briefly ringed after "next line to fill" scrolled to it. */
  flash: boolean;
  onChange: (index: number, patch: Partial<LineDraft>) => void;
}

const LineCard = memo(function LineCard({ line, d, errKey, language, today, flash, onChange }: LineCardProps) {
  const tr: Tr = (k, v) => t(language, k, v);
  const lang = language === 'Hebrew' ? 'he' : 'en';
  const errors = (errKey ? errKey.split(',') : []) as LineError[];
  const first = (codes: LineError[]) => {
    const hit = errors.find((e) => codes.includes(e));
    return hit ?? null;
  };
  const msg = (e: LineError | null) => (e ? tr(LINE_ERROR_KEY[e]) : null);
  const qtyErr = first(['qty_invalid']);
  const cartonsErr = first(['cartons_invalid']);
  const packErr = first(['packaging_invalid']);
  const expiryErr = first(['expiry_missing', 'expiry_invalid', 'expiry_not_future', 'expiry_too_far', 'expiry_conflict']);
  const gapErr = first(['gap_missing', 'gap_invalid', 'gap_note_missing', 'gap_note_too_long']);
  const borderFor = (e: LineError | null, done = false) =>
    e ? (TODO_ERRORS.has(e) ? TODO_BORDER : BAD_BORDER) : done ? DONE_BORDER : OK_BORDER;
  const toneFor = (e: LineError | null): 'warn' | 'danger' => (e && TODO_ERRORS.has(e) ? 'warn' : 'danger');

  const status = lineStatus(errors);
  const st = STATUS_STYLE[status];
  const statusText =
    status === 'ready'
      ? tr('receive.status.ready')
      : status === 'fix'
        ? tr('receive.status.fix')
        : errors.includes('expiry_missing')
          ? tr('receive.status.expiry')
          : tr('receive.status.gap');

  const received = parseDecimal(d.qty);
  const short = isShort(line, received);
  const over = isOver(line, received);
  const same = Number.isFinite(received) && !short && !over;
  const notArrived = received === 0;

  const name = line.name_he || line.name_en;
  const sub = language === 'English' && line.name_he && line.name_en ? line.name_en : '';
  const qtyLabel = line.weighed
    ? tr('receive.qtyWeighed')
    : line.unit_label
      ? tr('receive.qtyUnit', { unit: line.unit_label })
      : tr('receive.qtyPlain');
  const packWord = line.packaging ? PACKAGING_LABELS[line.packaging][lang] : tr('receive.packsWord');
  // Each figure+word is a bidi isolate, so a Hebrew unit on an English page
  // (or the reverse) cannot swap places with its number.
  const iso = (v: string) => `⁨${v}⁩`;
  const noteQty = iso(`${fmtQty(line.qty)} ${line.unit_label || ''}`.trim());
  const notePacks = line.cartons !== null ? iso(tr('receive.onNotePacks', { n: line.cartons, pack: packWord })) : null;

  const set = (patch: Partial<LineDraft>) => onChange(line.index, patch);
  const gapChoice = (g: Gap) => set({ gap: d.gap === g ? null : g });
  const expiryDone = d.noExpiry || (!!d.expiry && !expiryErr);

  return (
    <section
      id={`line-${line.index}`}
      className={`relative scroll-mt-4 overflow-hidden rounded-3xl border-2 border-s-[6px] p-4 space-y-4 shadow-lg shadow-black/30 transition-shadow ${st.card} ${
        flash ? 'ring-4 ring-brand' : ''
      }`}
      aria-label={`#${line.index} ${name}`}
    >
      {/* Title row */}
      <div className="flex items-start gap-3">
        <span
          className={`mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full text-sm font-black ${st.badge}`}
          aria-hidden
        >
          {status === 'ready' ? <Icon name="check" size={20} /> : line.index}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[17px] font-extrabold leading-snug break-words" dir="auto">
            {name}
          </h2>
          {sub && (
            <p className="text-xs text-ink-muted break-words" dir="auto">
              {sub}
            </p>
          )}
          <span
            className={`mt-1.5 inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-extrabold ${st.pill}`}
          >
            <Icon name={status === 'todo' && !errors.includes('expiry_missing') ? 'help' : st.icon} size={14} />
            {statusText}
          </span>
        </div>
      </div>

      {/* What the note says */}
      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-brand/30 bg-brand-weak px-3 py-2 text-sm">
        <Icon name="receipt_long" size={18} className="text-brand-weak-ink" />
        <span className="font-bold text-brand-weak-ink">{tr('receive.onNoteLabel')}</span>
        <span className="font-extrabold text-ink">{noteQty}</span>
        {notePacks && (
          <>
            <span className="text-ink-muted">·</span>
            <span className="font-extrabold text-ink">{notePacks}</span>
          </>
        )}
      </div>

      {/* Received quantity */}
      <div>
        <FieldLabel htmlFor={`q-${line.index}`} icon={line.weighed ? 'scale' : 'tag'}>
          {qtyLabel}
        </FieldLabel>
        <div className="flex gap-2">
          <input
            id={`q-${line.index}`}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            dir="ltr"
            aria-invalid={!!qtyErr}
            value={d.qty}
            onChange={(e) => set({ qty: e.target.value })}
            className={`${INPUT} flex-1 font-mono text-xl font-bold ${
              qtyErr ? BAD_BORDER : short && gapErr ? TODO_BORDER : over ? 'border-info' : same ? DONE_BORDER : OK_BORDER
            }`}
          />
          <button
            type="button"
            onClick={() => set({ qty: '0' })}
            className={`shrink-0 min-h-12 rounded-xl border-2 px-3 text-sm font-extrabold transition-all active:scale-95 ${
              notArrived
                ? 'border-danger bg-danger text-white'
                : 'border-danger/40 bg-danger-weak text-danger-weak-ink'
            }`}
          >
            {tr('receive.notArrived')}
          </button>
        </div>
        <FieldError text={msg(qtyErr)} />
        {same && !qtyErr && (
          <p className="mt-1.5 flex items-center gap-1 text-sm font-bold text-ok-weak-ink">
            <Icon name="check_circle" size={17} />
            {tr('receive.matchesNote')}
          </p>
        )}
        {short && (
          <p className="mt-1.5 inline-flex items-center gap-1 rounded-full bg-warn px-3 py-1 text-sm font-extrabold text-[#1a1100]">
            <Icon name="trending_down" size={17} />
            {tr('receive.shortBy', { x: fmtQty(line.qty - received) })}
          </p>
        )}
        {over && (
          <p className="mt-1.5 inline-flex items-center gap-1 rounded-full bg-info px-3 py-1 text-sm font-extrabold text-[#160a33]">
            <Icon name="trending_up" size={17} />
            {tr('receive.over', { x: `⁦+${fmtQty(received - line.qty)}⁩` })}
          </p>
        )}
      </div>

      {/* Why short */}
      {short && (
        <div className="rounded-2xl border-2 border-warn/50 bg-amber-card p-3">
          <p className="mb-2 flex items-center gap-1.5 text-sm font-extrabold text-warn-weak-ink">
            <Icon name="help" size={18} />
            {tr('receive.gapQuestion')}
          </p>
          <div className="flex flex-wrap gap-2">
            <Chip tone="warn" icon="schedule" active={d.gap === 'will'} onClick={() => gapChoice('will')}>
              {tr('receive.gapWill')}
            </Chip>
            <Chip tone="warn" icon="block" active={d.gap === 'wont'} onClick={() => gapChoice('wont')}>
              {tr('receive.gapWont')}
            </Chip>
            <Chip tone="warn" icon="edit_note" active={d.gap === 'other'} onClick={() => gapChoice('other')}>
              {tr('receive.gapOther')}
            </Chip>
          </div>
          {d.gap === 'other' && (
            <input
              type="text"
              dir="auto"
              maxLength={500}
              value={d.gapNote}
              placeholder={tr('receive.gapNotePlaceholder')}
              onChange={(e) => set({ gapNote: e.target.value })}
              className={`${INPUT} mt-2 ${
                errors.includes('gap_note_too_long') ? BAD_BORDER : errors.includes('gap_note_missing') ? TODO_BORDER : OK_BORDER
              }`}
            />
          )}
          <FieldError text={msg(gapErr)} tone={toneFor(gapErr)} />
        </div>
      )}

      {/* Cartons + packaging */}
      <div className="grid grid-cols-2 gap-2">
        <div className="min-w-0">
          <FieldLabel htmlFor={`c-${line.index}`} icon="inventory_2">
            {tr('receive.cartons')}
          </FieldLabel>
          <input
            id={`c-${line.index}`}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            dir="ltr"
            aria-invalid={!!cartonsErr}
            value={d.cartons}
            onChange={(e) => set({ cartons: e.target.value })}
            className={`${INPUT} font-mono text-lg font-bold ${cartonsErr ? BAD_BORDER : OK_BORDER}`}
          />
          <FieldError text={msg(cartonsErr)} />
        </div>
        <div className="min-w-0">
          <FieldLabel htmlFor={`p-${line.index}`} icon="category">
            {tr('receive.packaging')}
          </FieldLabel>
          <select
            id={`p-${line.index}`}
            value={d.packaging}
            aria-invalid={!!packErr}
            onChange={(e) => set({ packaging: e.target.value as Packaging | '' })}
            className={`${INPUT} font-bold ${packErr ? BAD_BORDER : OK_BORDER}`}
          >
            <option value="">{tr('receive.packagingNone')}</option>
            {PACKAGING.map((p) => (
              <option key={p} value={p}>
                {PACKAGING_LABELS[p][lang]}
              </option>
            ))}
          </select>
          <FieldError text={msg(packErr)} />
        </div>
      </div>

      {/* Expiry */}
      {line.needs_expiry && (
        <div>
          <FieldLabel htmlFor={`e-${line.index}`} icon="event">
            {tr('receive.expiry')}
          </FieldLabel>
          {/* Typed (numeric keypad) or picked (calendar button) — Android opens no keyboard for a date input (20/10). Wraps "No expiry" to its own line on a narrow phone. */}
          <div className="flex flex-wrap gap-2">
            <DateEntry
              id={`e-${line.index}`}
              value={d.noExpiry ? '' : d.expiry}
              disabled={d.noExpiry}
              invalid={!!expiryErr}
              min={addDaysIso(today, 1)}
              max={maxExpiryIso(today)}
              placeholder={tr('receive.expiryPlaceholder')}
              calendarLabel={tr('receive.openCalendar')}
              onChange={(v) => set({ expiry: v, noExpiry: false })}
              className={DATE_ROW}
              inputClassName={`${INPUT} flex-1 font-mono text-lg font-bold disabled:opacity-35 ${borderFor(expiryErr, expiryDone)}`}
              buttonClassName={CALENDAR_BTN}
            />
            <Chip
              tone="ok"
              icon="block"
              active={d.noExpiry}
              onClick={() => set(d.noExpiry ? { noExpiry: false } : { noExpiry: true, expiry: '' })}
            >
              {tr('receive.noExpiry')}
            </Chip>
          </div>
          <FieldError text={msg(expiryErr)} tone={toneFor(expiryErr)} />
        </div>
      )}
    </section>
  );
});

// ── An item that is not on the note ──────────────────────────────────────

function ExtraCard({
  x,
  errors,
  language,
  onChange,
  onRemove,
}: {
  x: ExtraDraft;
  errors: ExtraError[];
  language: FormLanguage;
  onChange: (key: string, patch: Partial<ExtraDraft>) => void;
  onRemove: (key: string) => void;
}) {
  const tr: Tr = (k, v) => t(language, k, v);
  const lang = language === 'Hebrew' ? 'he' : 'en';
  const nameErr = errors.find((e) => e === 'extra_name_missing' || e === 'extra_name_too_long');
  const qtyErr = errors.find((e) => e === 'extra_qty_invalid' || e === 'extra_unit_invalid');
  return (
    <section
      className={`relative overflow-hidden rounded-3xl border-2 border-s-[6px] border-s-info p-4 space-y-3 bg-[linear-gradient(180deg,rgba(167,139,250,0.14),rgba(16,28,34,1)_60%)] ${
        errors.length ? 'border-info' : 'border-info/50'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-sm font-extrabold text-info-weak-ink">
          <Icon name="add_box" size={20} />
          {tr('receive.extraTitle')}
        </h2>
        <button
          type="button"
          onClick={() => onRemove(x.key)}
          className="inline-flex min-h-11 items-center gap-1 rounded-xl border-2 border-danger/40 bg-danger-weak px-3 text-sm font-bold text-danger-weak-ink active:scale-95"
        >
          <Icon name="delete" size={18} />
          {tr('receive.remove')}
        </button>
      </div>
      <div>
        <input
          type="text"
          dir="auto"
          maxLength={200}
          value={x.name}
          placeholder={tr('receive.extraName')}
          aria-label={tr('receive.extraName')}
          onChange={(e) => onChange(x.key, { name: e.target.value })}
          className={`${INPUT} ${nameErr ? TODO_BORDER : OK_BORDER}`}
        />
        <FieldError text={nameErr ? tr(EXTRA_ERROR_KEY[nameErr]) : null} tone="warn" />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <input
          type="text"
          inputMode="decimal"
          dir="ltr"
          autoComplete="off"
          value={x.quantity}
          placeholder={tr('receive.extraQty')}
          aria-label={tr('receive.extraQty')}
          onChange={(e) => onChange(x.key, { quantity: e.target.value })}
          className={`${INPUT} font-mono text-lg font-bold ${qtyErr ? TODO_BORDER : OK_BORDER}`}
        />
        <select
          value={x.unit}
          aria-label={tr('receive.extraUnit')}
          onChange={(e) => onChange(x.key, { unit: e.target.value as ExtraDraft['unit'] })}
          className={`${INPUT} font-bold ${OK_BORDER}`}
        >
          {EXTRA_UNITS.map((u) => (
            <option key={u} value={u}>
              {EXTRA_UNIT_LABELS[u][lang]}
            </option>
          ))}
        </select>
      </div>
      <FieldError text={qtyErr ? tr(EXTRA_ERROR_KEY[qtyErr]) : null} tone="warn" />
    </section>
  );
}

// ── Full-screen outcomes ─────────────────────────────────────────────────

const OUTCOME_TONE = {
  ok: { ring: 'bg-ok text-[#04210f] shadow-[0_0_60px_rgba(34,197,94,0.55)]', glow: 'rgba(34,197,94,0.22)' },
  warn: { ring: 'bg-warn text-[#1a1100] shadow-[0_0_60px_rgba(245,158,11,0.5)]', glow: 'rgba(245,158,11,0.2)' },
  info: { ring: 'bg-info text-[#160a33] shadow-[0_0_60px_rgba(167,139,250,0.5)]', glow: 'rgba(167,139,250,0.2)' },
} as const;

function Outcome({ dir, icon, tone, title, body, action }: {
  dir: 'rtl' | 'ltr';
  icon: string;
  tone: keyof typeof OUTCOME_TONE;
  title: string;
  body?: string;
  action?: React.ReactNode;
}) {
  const o = OUTCOME_TONE[tone];
  return (
    <main
      dir={dir}
      className="min-h-dvh text-ink flex items-center justify-center px-4"
      style={{ background: `radial-gradient(circle at 50% 30%, ${o.glow}, var(--surface-canvas) 65%)` }}
    >
      <div className="w-full max-w-md rounded-3xl border-2 border-line bg-raised/90 p-7 text-center space-y-4 shadow-2xl shadow-black/40">
        <span className={`mx-auto grid h-24 w-24 place-items-center rounded-full ${o.ring}`}>
          <Icon name={icon} size={60} />
        </span>
        <h1 className="text-xl font-extrabold leading-snug">{title}</h1>
        {body && <p className="text-lg font-bold text-ink-body">{body}</p>}
        {action}
      </div>
    </main>
  );
}

let extraSeq = 0;
function newExtraKey(): string {
  extraSeq += 1;
  return `x${Date.now().toString(36)}${extraSeq}`;
}

// ── The form ─────────────────────────────────────────────────────────────

export function ReceiptForm({
  formId,
  exp,
  sig,
  language,
  header,
  lines,
}: {
  formId: string;
  exp: string;
  sig: string;
  language: FormLanguage;
  header: FormHeader;
  lines: FormLine[];
}) {
  useLangDir(language);
  const tr: Tr = useCallback((k, v) => t(language, k, v), [language]);
  const dir = language === 'Hebrew' ? 'rtl' : 'ltr';
  const lineByIndex = useMemo(() => new Map(lines.map((l) => [l.index, l])), [lines]);

  const [draft, setDraft] = useState<FormDraft>(() => initialDraft(lines));
  const [restored, setRestored] = useState(false);
  const [onlyMissing, setOnlyMissing] = useState(lines.length > 8);
  /** Lines edited since "only missing" was switched on — they stay put while typed into. */
  const [touched, setTouched] = useState<Set<number>>(() => new Set());
  const [sameDate, setSameDate] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'editing' });
  const [flashLine, setFlashLine] = useState<number | null>(null);
  const sending = useRef(false);

  const today = todayInJerusalem();

  // Restore a draft typed before a reload (after mount, so SSR and the
  // first client render agree).
  useEffect(() => {
    try {
      const saved = restoreDraft(window.localStorage.getItem(draftStorageKey(formId)), lines);
      if (saved) setDraft(saved);
    } catch {
      /* storage blocked — start from the note */
    }
    setRestored(true);
  }, [formId, lines]);

  useEffect(() => {
    if (!restored || phase.kind === 'saved' || phase.kind === 'already') return;
    try {
      window.localStorage.setItem(draftStorageKey(formId), serializeDraft(draft));
    } catch {
      /* quota / private mode — the form still works */
    }
  }, [draft, restored, formId, phase.kind]);

  useEffect(() => {
    if (flashLine === null) return;
    const id = window.setTimeout(() => setFlashLine(null), 1400);
    return () => window.clearTimeout(id);
  }, [flashLine]);

  const clearStoredDraft = useCallback(() => {
    try {
      window.localStorage.removeItem(draftStorageKey(formId));
    } catch {
      /* ignore */
    }
  }, [formId]);

  const answers = useMemo(() => draftToAnswers(lines, draft), [lines, draft]);
  const check = useMemo(() => validateAnswers(lines, answers, today), [lines, answers, today]);
  const remaining = remainingCount(check);
  const wantingExpiry = countWantingExpiry(lines, draft.lines);
  const anyNeedsExpiry = lines.some((l) => l.needs_expiry);
  const linesWithIssues = Object.keys(check.lines).length;
  const readyLines = lines.length - linesWithIssues;
  const pct = lines.length ? Math.round((readyLines / lines.length) * 100) : 100;

  const onLineChange = useCallback((index: number, patch: Partial<LineDraft>) => {
    setDraft((d) => ({ ...d, lines: d.lines.map((l) => (l.index === index ? { ...l, ...patch } : l)) }));
    setTouched((s) => (s.has(index) ? s : new Set(s).add(index)));
    setPhase((p) => (p.kind === 'error' ? { kind: 'editing' } : p));
  }, []);

  const onExtraChange = useCallback((key: string, patch: Partial<ExtraDraft>) => {
    setDraft((d) => ({ ...d, extras: d.extras.map((x) => (x.key === key ? { ...x, ...patch } : x)) }));
  }, []);
  const onExtraRemove = useCallback((key: string) => {
    setDraft((d) => ({ ...d, extras: d.extras.filter((x) => x.key !== key) }));
  }, []);
  const addExtra = () =>
    setDraft((d) =>
      d.extras.length >= MAX_EXTRAS
        ? d
        : { ...d, extras: [...d.extras, { key: newExtraKey(), name: '', quantity: '', unit: 'units' }] },
    );

  const sameDateErr = sameDate ? expiryError(sameDate, today) : null;
  const applySameDate = () => {
    if (!sameDate || sameDateErr) return;
    setDraft((d) => ({ ...d, lines: applySameDateToAll(lines, d.lines, sameDate) }));
  };
  const restNoExpiry = () => setDraft((d) => ({ ...d, lines: markRestNoExpiry(lines, d.lines) }));

  const showOnlyMissing = (v: boolean) => {
    setOnlyMissing(v);
    setTouched(new Set());
  };

  const pallets = draft.pallets.trim();
  const palletsN = /^\d{1,3}$/.test(pallets) ? Number(pallets) : null;
  const stepPallets = (delta: number) =>
    setDraft((d) => {
      const cur = /^\d{1,3}$/.test(d.pallets.trim()) ? Number(d.pallets.trim()) : 0;
      const next = Math.min(999, Math.max(0, cur + delta));
      return { ...d, pallets: delta < 0 && cur === 0 ? d.pallets : String(next) };
    });

  /** The first thing that still blocks approval, in page order. */
  const goToNext = () => {
    const nextLine = draft.lines.find((d) => check.lines[d.index]);
    if (nextLine) {
      const el = document.getElementById(`line-${nextLine.index}`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setFlashLine(nextLine.index);
      return;
    }
    const target = check.form.includes('pallets_invalid')
      ? document.getElementById('pallets')
      : document.getElementById('extras');
    target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const visible = draft.lines.filter((d) => !onlyMissing || check.lines[d.index] || touched.has(d.index));

  const submit = async () => {
    if (sending.current || remaining > 0) return;
    sending.current = true;
    setPhase({ kind: 'submitting' });
    try {
      const res = await fetch(`/api/receipt-form/${encodeURIComponent(formId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ exp, sig, answers }),
        cache: 'no-store',
      });
      const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (res.ok && data?.ok === true) {
        clearStoredDraft();
        const n = Number(data.saved_lines);
        setPhase({ kind: 'saved', savedLines: Number.isFinite(n) ? n : null });
        return;
      }
      const status = data?.status;
      if (isFinalStatus(status)) {
        clearStoredDraft();
        setPhase({ kind: 'already' });
        return;
      }
      if (isInFlightStatus(status)) {
        setPhase({ kind: 'inflight' });
        return;
      }
      if (status === 'failed') {
        setPhase({ kind: 'failed' });
        return;
      }
      const err = typeof data?.error === 'string' ? data.error : '';
      const botMessage = typeof data?.message === 'string' && data.message ? data.message : null;
      const key: TranslationKey =
        err === 'link_invalid' || err === 'expired' || err === 'not_found'
          ? 'receive.linkInvalidTitle'
          : err === 'invalid'
            ? 'receive.errorInvalid'
            : err === 'bot_unreachable' || err === 'bot_not_configured'
              ? 'receive.errorBotUnreachable'
              : 'receive.errorGeneric';
      setPhase({ kind: 'error', message: botMessage ?? tr(key) });
    } catch {
      setPhase({ kind: 'error', message: tr('receive.errorNetwork') });
    } finally {
      sending.current = false;
    }
  };

  // ── Outcome screens ──
  if (phase.kind === 'saved') {
    return (
      <Outcome
        dir={dir}
        icon="check"
        tone="ok"
        title={tr('receive.saved')}
        body={phase.savedLines !== null ? tr('receive.savedLines', { n: phase.savedLines }) : undefined}
      />
    );
  }
  if (phase.kind === 'already') {
    return <Outcome dir={dir} icon="check" tone="ok" title={tr('receive.alreadySavedTitle')} body={tr('receive.alreadySavedBody')} />;
  }
  if (phase.kind === 'failed') {
    return <Outcome dir={dir} icon="info" tone="info" title={tr('receive.failedTitle')} body={tr('receive.failedBody')} />;
  }
  if (phase.kind === 'inflight') {
    return (
      <Outcome
        dir={dir}
        icon="hourglass_top"
        tone="warn"
        title={tr('receive.beingSavedTitle')}
        body={tr('receive.beingSavedBody')}
        action={
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="inline-flex min-h-12 items-center justify-center gap-2 rounded-2xl bg-brand px-6 font-extrabold text-white active:scale-95"
          >
            <Icon name="refresh" />
            {tr('receive.refresh')}
          </button>
        }
      />
    );
  }

  const submitting = phase.kind === 'submitting';
  const palletsBad = check.form.includes('pallets_invalid');
  const allReady = remaining === 0;

  return (
    <main
      dir={dir}
      lang={language === 'Hebrew' ? 'he' : 'en'}
      className="min-h-dvh text-ink bg-[radial-gradient(120%_60%_at_50%_0%,rgba(19,164,236,0.16),var(--surface-canvas)_60%)]"
    >
      <div className="mx-auto max-w-xl px-3 pt-4 pb-48 space-y-4">
        {/* Header */}
        <header className="relative overflow-hidden rounded-3xl p-4 text-white shadow-xl shadow-[rgba(79,70,229,0.35)] bg-[linear-gradient(135deg,#0ea5e9_0%,#6366f1_55%,#a855f7_100%)] space-y-3">
          <span aria-hidden className="pointer-events-none absolute -top-10 -end-10 h-40 w-40 rounded-full bg-white/15 blur-2xl" />
          <div className="flex items-start gap-3">
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-white/20 backdrop-blur">
              <Icon name="local_shipping" size={28} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-extrabold uppercase tracking-wide text-white/80">{tr('receive.title')}</p>
              <h1 className="text-xl font-black leading-snug break-words" dir="auto">
                {header.supplier || tr('receive.title')}
              </h1>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 text-sm font-bold">
            {header.invoice_number && (
              <span className="inline-flex items-center gap-1 rounded-full bg-white/20 px-3 py-1">
                <Icon name="receipt_long" size={16} />
                {tr('receive.invoice', { n: header.invoice_number })}
              </span>
            )}
            {header.invoice_date && (
              <span className="inline-flex items-center gap-1 rounded-full bg-white/20 px-3 py-1 font-mono">
                <Icon name="calendar_today" size={16} />
                {formatDdMmYyyy(header.invoice_date)}
              </span>
            )}
            <span className="inline-flex items-center gap-1 rounded-full bg-white/20 px-3 py-1">
              <Icon name="format_list_numbered" size={16} />
              {tr('receive.lineCount', { n: lines.length })}
            </span>
          </div>

          {/* Progress */}
          <div className="rounded-2xl bg-black/20 p-3">
            <div className="mb-2 flex items-center justify-between text-sm font-extrabold">
              <span>{tr('receive.progress', { done: readyLines, n: lines.length })}</span>
              <span className="font-mono">{pct}%</span>
            </div>
            <div className="h-3 overflow-hidden rounded-full bg-white/25">
              <div
                className={`h-full rounded-full transition-[width] duration-500 ${
                  pct === 100 ? 'bg-[#4ade80]' : 'bg-[linear-gradient(90deg,#fde047,#fb923c)]'
                }`}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        </header>

        {/* How it works */}
        <p className="flex items-start gap-2 rounded-2xl border border-brand/30 bg-brand-weak px-3 py-2.5 text-sm font-bold text-brand-weak-ink">
          <Icon name="lightbulb" size={20} className="text-[#fde047]" />
          <span>{tr('receive.hint')}</span>
        </p>

        {/* Pallets */}
        <div className="flex items-center gap-3 rounded-3xl border-2 border-line bg-raised p-3">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-[#0ea5e9]/20 text-[#7dd3fc]">
            <Icon name="view_in_ar" size={24} />
          </span>
          <label htmlFor="pallets" className="min-w-0 flex-1 text-[15px] font-extrabold">
            {tr('receive.pallets')}
            <span className="block text-xs font-bold text-ink-muted">{tr('receive.optional')}</span>
          </label>
          <div className="flex shrink-0 items-center gap-1.5" dir="ltr">
            <button
              type="button"
              aria-label={tr('receive.palletsLess')}
              onClick={() => stepPallets(-1)}
              disabled={!palletsN}
              className="grid h-12 w-12 place-items-center rounded-xl border-2 border-line-strong bg-tile text-ink active:scale-95 disabled:opacity-35"
            >
              <Icon name="remove" size={24} />
            </button>
            <input
              id="pallets"
              type="text"
              inputMode="numeric"
              dir="ltr"
              autoComplete="off"
              value={draft.pallets}
              placeholder="0"
              onChange={(e) => setDraft((d) => ({ ...d, pallets: e.target.value }))}
              className={`${INPUT.replace('w-full ', '')} w-16 flex-none px-1 text-center font-mono text-xl font-black ${
                palletsBad ? BAD_BORDER : palletsN ? DONE_BORDER : OK_BORDER
              }`}
            />
            <button
              type="button"
              aria-label={tr('receive.palletsMore')}
              onClick={() => stepPallets(1)}
              className="grid h-12 w-12 place-items-center rounded-xl bg-brand text-white active:scale-95"
            >
              <Icon name="add" size={24} />
            </button>
          </div>
        </div>
        <FieldError text={palletsBad ? tr('receive.err.pallets') : null} />

        {/* Expiry shortcuts */}
        {anyNeedsExpiry && (
          <div className="relative overflow-hidden rounded-3xl border-2 border-warn/45 bg-[linear-gradient(160deg,rgba(245,158,11,0.16),rgba(16,28,34,1)_65%)] p-4 space-y-3">
            <div className="flex items-center gap-2">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-warn text-[#1a1100]">
                <Icon name="event_available" size={22} />
              </span>
              <div className="min-w-0">
                <h2 className="text-[15px] font-extrabold">{tr('receive.expiryTools')}</h2>
                <p className="text-xs font-bold text-warn-weak-ink">
                  {wantingExpiry > 0 ? tr('receive.sameDateHint', { n: wantingExpiry }) : tr('receive.expiryAllSet')}
                </p>
              </div>
            </div>
            <div>
              <label htmlFor="same-date" className="mb-1.5 block text-sm font-bold text-ink-body">
                {tr('receive.sameDate')}
              </label>
              <div className="flex flex-wrap gap-2">
                <DateEntry
                  id="same-date"
                  value={sameDate}
                  onChange={setSameDate}
                  invalid={!!sameDateErr}
                  min={addDaysIso(today, 1)}
                  max={maxExpiryIso(today)}
                  placeholder={tr('receive.expiryPlaceholder')}
                  calendarLabel={tr('receive.openCalendar')}
                  className={DATE_ROW}
                  inputClassName={`${INPUT} flex-1 font-mono text-lg font-bold ${sameDateErr ? BAD_BORDER : OK_BORDER}`}
                  buttonClassName={CALENDAR_BTN}
                />
                <button
                  type="button"
                  onClick={applySameDate}
                  disabled={!sameDate || !!sameDateErr || wantingExpiry === 0}
                  className="inline-flex shrink-0 min-h-12 items-center gap-1 rounded-xl bg-warn px-4 font-extrabold text-[#1a1100] shadow-[0_6px_18px_rgba(245,158,11,0.35)] active:scale-95 disabled:opacity-35 disabled:shadow-none"
                >
                  <Icon name="done_all" size={20} />
                  {tr('receive.sameDateApply')}
                </button>
              </div>
              <FieldError text={sameDateErr ? tr(LINE_ERROR_KEY[sameDateErr]) : null} />
            </div>
            <button
              type="button"
              onClick={restNoExpiry}
              disabled={wantingExpiry === 0}
              className="inline-flex w-full min-h-12 items-center justify-center gap-2 rounded-xl border-2 border-line-strong bg-tile px-4 font-extrabold text-ink active:scale-95 disabled:opacity-35"
            >
              <Icon name="event_busy" size={20} className="text-ink-muted" />
              {tr('receive.restNoExpiry')}
            </button>
          </div>
        )}

        {/* Which lines to show */}
        <div role="tablist" className="grid grid-cols-2 gap-1 rounded-2xl border-2 border-line bg-sunken p-1">
          <button
            type="button"
            role="tab"
            aria-selected={onlyMissing}
            onClick={() => showOnlyMissing(true)}
            className={`inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl px-2 text-sm font-extrabold transition-colors ${
              onlyMissing ? 'bg-warn text-[#1a1100] shadow' : 'text-ink-body'
            }`}
          >
            <Icon name="pending_actions" size={18} />
            {tr('receive.tabNeed', { n: linesWithIssues })}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={!onlyMissing}
            onClick={() => showOnlyMissing(false)}
            className={`inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl px-2 text-sm font-extrabold transition-colors ${
              !onlyMissing ? 'bg-brand text-white shadow' : 'text-ink-body'
            }`}
          >
            <Icon name="list" size={18} />
            {tr('receive.tabAll', { n: lines.length })}
          </button>
        </div>

        {/* Lines */}
        {visible.map((d) => {
          const line = lineByIndex.get(d.index);
          if (!line) return null;
          return (
            <LineCard
              key={d.index}
              line={line}
              d={d}
              errKey={(check.lines[d.index] ?? []).join(',')}
              language={language}
              today={today}
              flash={flashLine === d.index}
              onChange={onLineChange}
            />
          );
        })}
        {onlyMissing && visible.length === 0 && (
          <div className="rounded-3xl border-2 border-ok/50 bg-[linear-gradient(180deg,rgba(34,197,94,0.14),rgba(16,28,34,1))] p-5 text-center space-y-2">
            <span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-ok text-[#04210f] shadow-[0_0_30px_rgba(34,197,94,0.45)]">
              <Icon name="done_all" size={32} />
            </span>
            <p className="text-lg font-extrabold text-ok-weak-ink">{tr('receive.nothingMissing')}</p>
            <button
              type="button"
              onClick={() => showOnlyMissing(false)}
              className="min-h-11 px-4 font-bold text-brand-weak-ink underline"
            >
              {tr('receive.showAll')}
            </button>
          </div>
        )}

        {/* Items not on the note */}
        <div id="extras" className="space-y-4">
          {draft.extras.map((x, i) => (
            <ExtraCard
              key={x.key}
              x={x}
              errors={check.extras[i] ?? []}
              language={language}
              onChange={onExtraChange}
              onRemove={onExtraRemove}
            />
          ))}
        </div>
        {check.form.includes('too_many_extras') && <FieldError text={tr('receive.err.tooManyExtras')} />}
        <button
          type="button"
          onClick={addExtra}
          disabled={draft.extras.length >= MAX_EXTRAS}
          className="inline-flex w-full min-h-14 items-center justify-center gap-2 rounded-3xl border-2 border-dashed border-info/60 bg-info-weak px-4 font-extrabold text-info-weak-ink active:scale-[0.98] disabled:opacity-40"
        >
          <Icon name="add_circle" size={22} />
          {tr('receive.addExtra')}
        </button>
      </div>

      {/* Sticky footer */}
      <footer
        className="fixed inset-x-0 bottom-0 border-t border-line bg-header/95 backdrop-blur px-3 pt-2.5 shadow-[0_-10px_30px_rgba(0,0,0,0.45)]"
        style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
      >
        <div className="mx-auto max-w-xl space-y-2">
          {phase.kind === 'error' && (
            <div role="alert" className="rounded-2xl border-2 border-danger bg-danger-weak p-2 text-sm font-bold text-danger-weak-ink flex items-center gap-2">
              <Icon name="error" size={20} />
              <span className="flex-1" dir="auto">
                {phase.message}
              </span>
              <button
                type="button"
                onClick={submit}
                disabled={remaining > 0}
                className="shrink-0 min-h-10 rounded-xl bg-danger px-3 font-extrabold text-white disabled:opacity-40"
              >
                {tr('receive.retry')}
              </button>
            </div>
          )}
          <p className={`flex items-center justify-center gap-1.5 text-sm font-extrabold ${allReady ? 'text-ok-weak-ink' : 'text-warn-weak-ink'}`}>
            <Icon name={allReady ? 'check_circle' : 'pending'} size={18} />
            {allReady
              ? tr('receive.allReady')
              : remaining === 1
                ? tr('receive.remainingOne')
                : tr('receive.remaining', { k: remaining })}
          </p>
          {allReady || submitting ? (
            <button
              type="button"
              onClick={submit}
              disabled={submitting}
              aria-busy={submitting}
              className="w-full min-h-14 rounded-2xl px-4 text-lg font-black text-[#04210f] bg-[linear-gradient(135deg,#4ade80,#22c55e_50%,#16a34a)] shadow-[0_8px_28px_rgba(34,197,94,0.45)] active:scale-[0.98] disabled:opacity-80 flex items-center justify-center gap-2"
            >
              {submitting ? (
                <span aria-hidden className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent" />
              ) : (
                <Icon name="send" size={22} className="rtl:-scale-x-100" />
              )}
              {submitting ? tr('receive.submitting') : tr('receive.submit')}
            </button>
          ) : (
            <button
              type="button"
              onClick={goToNext}
              className="w-full min-h-14 rounded-2xl px-4 text-lg font-black text-[#1a1100] bg-[linear-gradient(135deg,#fde047,#f59e0b)] shadow-[0_8px_28px_rgba(245,158,11,0.35)] active:scale-[0.98] flex items-center justify-center gap-2"
            >
              <Icon name="south" size={22} />
              {tr('receive.goNext')}
            </button>
          )}
        </div>
      </footer>
    </main>
  );
}
