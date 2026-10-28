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
  closedReasonOf,
  closedView,
  applySameDateToAll,
  countWantingExpiry,
  draftStorageKey,
  draftToAnswers,
  expiryError,
  fingerprints,
  fmtQty,
  formatDdMmYyyy,
  initialDraft,
  isOver,
  isShort,
  markRestNoExpiry,
  maxExpiryIso,
  mergeDraft,
  normalizeFormLines,
  packBadge,
  parseDecimal,
  remainingCount,
  restoreDraftMerged,
  serializeDraft,
  todayInJerusalem,
  validateAnswers,
  type ClosedView,
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
import { SEARCH_MIN_LINES, nextIncompleteLine, searchLines } from '@/lib/receipt-form-search';
import { errorCounts } from '@/lib/receive-trace';
import { useReceiveTrace } from './useReceiveTrace';

type Tr = (key: TranslationKey, vars?: Record<string, string | number>) => string;

type Phase =
  | { kind: 'editing' }
  | { kind: 'submitting' }
  | { kind: 'error'; message: string }
  | { kind: 'saved'; savedLines: number | null }
  | { kind: 'already' }
  | { kind: 'inflight' }
  | { kind: 'failed' }
  /** Closed elsewhere while open here (bot 20/10 closed_reason); 'replaced' with a newer link navigates instead. */
  | { kind: 'closed'; view: Exclude<ClosedView, 'saved'> };

/** How often the open page asks whether the bot added a page (only while the tab is visible). */
const POLL_MS = 15_000;

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
  /** Arrived with a page added while the form was open (or since the draft was saved). */
  isNew: boolean;
  onChange: (index: number, patch: Partial<LineDraft>) => void;
}

const LineCard = memo(function LineCard({ line, d, errKey, language, today, flash, isNew, onChange }: LineCardProps) {
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
  // The OUTER package's plural ("3 קרטונים" = 3 cartons), never the inner unit
  // ("3 בקבוק" = 3 bottle, client 20/10) — and what is in each one when the note says.
  const badge = packBadge(line, lang, tr('receive.packsWord'));
  // Each figure+word is a bidi isolate, so a Hebrew unit on an English page
  // (or the reverse) cannot swap places with its number.
  const iso = (v: string) => `⁨${v}⁩`;
  const noteQty = iso(`${fmtQty(line.qty)} ${line.unit_label || ''}`.trim());
  const notePacks = badge.packs ? iso(tr('receive.onNotePacks', badge.packs)) : null;
  const notePerPack = badge.perPack ? iso(tr('receive.perPack', badge.perPack)) : null;

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
          {isNew && (
            <span className="ms-1.5 mt-1.5 inline-flex items-center gap-1 rounded-full bg-info px-2.5 py-0.5 text-xs font-extrabold text-[#160a33]">
              <Icon name="fiber_new" size={14} />
              {tr('receive.newLineTag')}
            </span>
          )}
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
        {notePerPack && (
          <>
            <span className="text-ink-muted">·</span>
            <span className="font-bold text-ink-body">{notePerPack}</span>
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

/**
 * Copy this form's stored draft to the form that replaced it, unless that
 * one already has its own. The new form's restore fits it by index +
 * fingerprint (lib/receipt-form.ts mergeDraft), so page-1 answers carry over.
 */
function carryDraft(fromId: string, toId: string): void {
  try {
    const raw = window.localStorage.getItem(draftStorageKey(fromId));
    if (raw && !window.localStorage.getItem(draftStorageKey(toId))) {
      window.localStorage.setItem(draftStorageKey(toId), raw);
    }
  } catch {
    /* storage blocked — the new form starts from the note */
  }
}

/**
 * A replaced form opened from its old link (page.tsx): take the draft along
 * and go to the newer form; the button is the fallback if the redirect is
 * blocked.
 */
export function FormMoved({
  formId,
  language,
  newer,
}: {
  formId: string;
  language: FormLanguage;
  newer: { id: string; href: string };
}) {
  useLangDir(language);
  const dir = language === 'Hebrew' ? 'rtl' : 'ltr';
  useEffect(() => {
    carryDraft(formId, newer.id);
    window.location.replace(newer.href);
  }, [formId, newer.id, newer.href]);
  return (
    <Outcome
      dir={dir}
      icon="info"
      tone="info"
      title={t(language, 'receive.replacedTitle')}
      body={t(language, 'receive.replacedBody')}
      action={
        <a
          href={newer.href}
          onClick={() => carryDraft(formId, newer.id)}
          className="inline-flex min-h-12 items-center justify-center rounded-2xl bg-brand px-6 font-extrabold text-white"
        >
          {t(language, 'receive.openNewer')}
        </a>
      }
    />
  );
}

export function ReceiptForm({
  formId,
  exp,
  sig,
  language,
  header,
  lines: initialLines,
  previousFormIds = [],
}: {
  formId: string;
  exp: string;
  sig: string;
  language: FormLanguage;
  header: FormHeader;
  lines: FormLine[];
  /** Forms this one replaced, newest first (page.tsx): their stored draft is restored when this form has none yet. */
  previousFormIds?: string[];
}) {
  useLangDir(language);
  const tr: Tr = useCallback((k, v) => t(language, k, v), [language]);
  const dir = language === 'Hebrew' ? 'rtl' : 'ltr';
  /**
   * The note's lines and their revision, live: the bot appends a page to the
   * open form in place (20/10) and the poll below brings it in.
   */
  const [lines, setLines] = useState<FormLine[]>(initialLines);
  const [rev, setRev] = useState(header.rev);
  const lineByIndex = useMemo(() => new Map(lines.map((l) => [l.index, l])), [lines]);
  /** Lines that arrived after the worker started (a page added); tagged "New". */
  const [newLines, setNewLines] = useState<Set<number>>(() => new Set());
  /** The "a page was added — N new lines" banner. */
  const [pageAdded, setPageAdded] = useState<number | null>(null);

  const [draft, setDraft] = useState<FormDraft>(() => initialDraft(initialLines));
  const [restored, setRestored] = useState(false);
  const [onlyMissing, setOnlyMissing] = useState(initialLines.length > 8);
  /** Lines edited since "only missing" was switched on — they stay put while typed into. */
  const [touched, setTouched] = useState<Set<number>>(() => new Set());
  const [sameDate, setSameDate] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'editing' });
  const [flashLine, setFlashLine] = useState<number | null>(null);
  /** Item search (client 20/10) — a view filter only; validation, counts and submit see every line. */
  const [query, setQuery] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  /**
   * A line index, or an element id (`last`: its last child — a new extra item), to scroll
   * to once the render that clears the search has committed.
   */
  const [pendingScroll, setPendingScroll] = useState<number | { id: string; last?: boolean } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const sending = useRef(false);
  /** The latest lines / rev for callbacks that outlive a render (the poll). */
  const linesRef = useRef(lines);
  linesRef.current = lines;
  const revRef = useRef(rev);
  revRef.current = rev;
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  const today = todayInJerusalem();

  // Restore a draft typed before a reload (after mount, so SSR and the
  // first client render agree) — merged by index, so a draft typed on page 1
  // survives page 2 being added (20/10). Once per form: the live merge
  // handles later changes.
  const previousKey = previousFormIds.join(',');
  useEffect(() => {
    try {
      let raw = window.localStorage.getItem(draftStorageKey(formId));
      // No draft of its own yet: the one typed on the form this one replaced
      // (the worker came straight to the new WhatsApp link, review 20/10).
      // The merge below fits it by index + fingerprint.
      for (const prev of previousKey ? previousKey.split(',') : []) {
        if (raw) break;
        raw = window.localStorage.getItem(draftStorageKey(prev));
      }
      const saved = restoreDraftMerged(raw, linesRef.current);
      if (saved) {
        setDraft(saved.draft);
        // Lines the saved draft never saw: a page added since it was typed.
        const fresh = [...saved.added, ...saved.reset];
        const savedSome = saved.draft.lines.length > fresh.length;
        if (fresh.length && savedSome) {
          setNewLines(new Set(fresh));
          setTouched(new Set(fresh));
          setPageAdded(fresh.length);
        }
      }
    } catch {
      /* storage blocked — start from the note */
    }
    setRestored(true);
  }, [formId, previousKey]);

  useEffect(() => {
    if (!restored || phase.kind === 'saved' || phase.kind === 'already') return;
    try {
      window.localStorage.setItem(draftStorageKey(formId), serializeDraft(draft, lines, rev));
    } catch {
      /* quota / private mode — the form still works */
    }
  }, [draft, lines, rev, restored, formId, phase.kind]);

  /**
   * New lines from the bot (a page appended in place): keep everything typed
   * by index, pre-fill the new ones from the note, tag them "New" and keep
   * them on the "to fill" tab. Returns how many lines are new.
   */
  const applyLines = useCallback((next: FormLine[], nextRev: number): number => {
    // An unreadable answer never empties the form.
    if (next.length === 0) return 0;
    const prev = linesRef.current;
    const prevFp = fingerprints(prev);
    // The fresh/added split is decided against the CURRENT lines, not the
    // draft (the draft follows them in the same update).
    const probe = mergeDraft(initialDraft(prev), prevFp, next);
    const fresh = [...probe.added, ...probe.reset];
    setLines(next);
    setRev(nextRev);
    setDraft((d) => mergeDraft(d, prevFp, next).draft);
    if (fresh.length) {
      setNewLines((s) => new Set([...s, ...fresh]));
      setTouched((s) => new Set([...s, ...fresh]));
      setPageAdded(fresh.length);
      setFlashLine(fresh[0]);
    }
    rt.event('receive_lines_added', { new_lines: fresh.length, rev: nextRev, lines: next.length });
    return fresh.length;
    // rt (the trace) is created further down and never changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Leave for the form that replaced this one, taking the draft along (its restore merges by index). */
  const goToNewer = useCallback(
    (href: string, newerId: string) => {
      carryDraft(formId, newerId);
      window.location.replace(href);
    },
    [formId],
  );

  /** One poll: what the row is now. Acts only while the worker is editing. */
  const poll = useCallback(async () => {
    const p = phaseRef.current.kind;
    if (sending.current || (p !== 'editing' && p !== 'error')) return;
    try {
      const q = new URLSearchParams({ exp, sig, rev: String(revRef.current) });
      const res = await fetch(`/api/receipt-form/${encodeURIComponent(formId)}?${q.toString()}`, { cache: 'no-store' });
      if (!res.ok) return; // a bad link / blip: the next poll or the submit says so
      const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!data || data.ok !== true || sending.current) return;
      const status = String(data.status ?? '');
      if (status === 'open') {
        const nextRev = Number(data.rev);
        if (Number.isInteger(nextRev) && nextRev > revRef.current) applyLines(normalizeFormLines(data.lines), nextRev);
        return;
      }
      if (isInFlightStatus(status)) return; // another phone is saving it; the submit would say so
      if (status === 'failed') {
        rt.event('receive_outcome', { status, at: 'poll' });
        return setPhase({ kind: 'failed' });
      }
      onNotOpen(status, data, 'poll');
    } catch {
      /* offline — try again next time */
    }
    // onNotOpen is stable enough: it only reads its arguments and setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exp, sig, formId, applyLines]);

  useEffect(() => {
    let timer: number | null = null;
    const start = () => {
      if (timer === null && document.visibilityState === 'visible') timer = window.setInterval(() => void poll(), POLL_MS);
    };
    const stop = () => {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void poll();
        start();
      } else stop();
    };
    const onFocus = () => void poll();
    start();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onFocus);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onFocus);
    };
  }, [poll]);

  useEffect(() => {
    if (flashLine === null) return;
    const id = window.setTimeout(() => setFlashLine(null), 1400);
    return () => window.clearTimeout(id);
  }, [flashLine]);

  const scrollToLine = useCallback((index: number) => {
    document.getElementById(`line-${index}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setFlashLine(index);
  }, []);

  // A line hidden by the search is mounted only after the query clears, so
  // the scroll waits for that render.
  useEffect(() => {
    if (pendingScroll === null) return;
    if (typeof pendingScroll === 'number') {
      scrollToLine(pendingScroll);
    } else {
      const el = document.getElementById(pendingScroll.id);
      // 'center', not 'end': the fixed footer covers the bottom of the screen.
      (pendingScroll.last ? el?.lastElementChild : el)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    setPendingScroll(null);
  }, [pendingScroll, scrollToLine]);

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
    rt.lineEdit(index, patch);
    setDraft((d) => ({ ...d, lines: d.lines.map((l) => (l.index === index ? { ...l, ...patch } : l)) }));
    setTouched((s) => (s.has(index) ? s : new Set(s).add(index)));
    setPhase((p) => (p.kind === 'error' ? { kind: 'editing' } : p));
    // rt (the trace) is created further down and never changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onExtraChange = useCallback((key: string, patch: Partial<ExtraDraft>) => {
    rt.extraEdit(key, patch);
    setDraft((d) => ({ ...d, extras: d.extras.map((x) => (x.key === key ? { ...x, ...patch } : x)) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const onExtraRemove = useCallback((key: string) => {
    rt.event('receive_extra', { action: 'remove' });
    setDraft((d) => ({ ...d, extras: d.extras.filter((x) => x.key !== key) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  /** `name` pre-fills the item (the search text, from the no-results card). */
  const addExtra = (name = '') => {
    rt.event('receive_extra', { action: 'add', from_search: name !== '', extras: draft.extras.length });
    setDraft((d) =>
      d.extras.length >= MAX_EXTRAS
        ? d
        : { ...d, extras: [...d.extras, { key: newExtraKey(), name: name.slice(0, 200), quantity: '', unit: 'units' }] },
    );
  };

  const sameDateErr = sameDate ? expiryError(sameDate, today) : null;
  const applySameDate = () => {
    if (!sameDate || sameDateErr) return;
    rt.event('receive_bulk', { tool: 'same_date', date: sameDate, lines: wantingExpiry });
    setDraft((d) => ({ ...d, lines: applySameDateToAll(lines, d.lines, sameDate) }));
  };
  const restNoExpiry = () => {
    rt.event('receive_bulk', { tool: 'rest_no_expiry', lines: wantingExpiry });
    setDraft((d) => ({ ...d, lines: markRestNoExpiry(lines, d.lines) }));
  };

  const showOnlyMissing = (v: boolean) => {
    rt.event('receive_tab', { tab: v ? 'need' : 'all', need: linesWithIssues, from_search: query.trim() !== '' });
    setOnlyMissing(v);
    setTouched(new Set());
    setQuery('');
  };

  const pallets = draft.pallets.trim();
  const palletsN = /^\d{1,3}$/.test(pallets) ? Number(pallets) : null;
  const stepPallets = (delta: number) => {
    const cur = palletsN ?? 0;
    rt.palletsEdit(delta < 0 && cur === 0 ? draft.pallets : String(Math.min(999, Math.max(0, cur + delta))));
    setDraft((d) => {
      const cur = /^\d{1,3}$/.test(d.pallets.trim()) ? Number(d.pallets.trim()) : 0;
      const next = Math.min(999, Math.max(0, cur + delta));
      return { ...d, pallets: delta < 0 && cur === 0 ? d.pallets : String(next) };
    });
  };

  // A non-empty search shows matching lines from the whole note, whichever tab is on.
  const search = useMemo(() => searchLines(lines, query), [lines, query]);
  const shownBySearch = useMemo(
    () => (search.active ? new Set(search.lines.map((l) => l.index)) : null),
    [search],
  );

  /** The trail of what the worker does here (scanner_events, page 'receive') — nothing visible. */
  const rt = useReceiveTrace({
    formId, exp, sig, lines, draft, lineErrors: check.lines, formErrors: check.form, restored, query, search,
  });

  /**
   * The first thing that still blocks approval, in page order. During a
   * search: the first incomplete result; when every result is done, the
   * search clears so the next line of the note is on screen to scroll to.
   */
  const goToNext = () => {
    const next = nextIncompleteLine(
      draft.lines.map((d) => d.index),
      (i) => !!check.lines[i],
      shownBySearch,
    );
    rt.event('receive_next', {
      to: next ? next.index : check.form.includes('pallets_invalid') ? 'pallets' : 'extras',
      clear_search: Boolean(next?.clearSearch),
      remaining,
      by_code: errorCounts(check.lines),
      form: check.form,
    });
    if (next) {
      if (next.clearSearch) {
        setQuery('');
        setPendingScroll(next.index);
      } else {
        scrollToLine(next.index);
      }
      return;
    }
    const id = check.form.includes('pallets_invalid') ? 'pallets' : 'extras';
    if (query) {
      setQuery('');
      setPendingScroll({ id });
      return;
    }
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const visible = shownBySearch
    ? draft.lines.filter((d) => shownBySearch.has(d.index))
    : draft.lines.filter((d) => !onlyMissing || check.lines[d.index] || touched.has(d.index));

  /**
   * The row is done / closed (seen by the poll or the submit): say why
   * (closed_reason, 20/10). Only a really saved note drops the stored draft.
   */
  function onNotOpen(status: unknown, data: Record<string, unknown> | null, at: 'poll' | 'save' = 'save') {
    const view = closedView(String(status ?? ''), closedReasonOf(data));
    rt.event('receive_outcome', { status: String(status ?? ''), view, at });
    const newer = data?.newer as { id?: unknown; href?: unknown } | null | undefined;
    if (view === 'replaced' && newer && typeof newer.href === 'string' && newer.href.startsWith('/receive/') && typeof newer.id === 'string') {
      goToNewer(newer.href, newer.id);
      setPhase({ kind: 'closed', view });
      return;
    }
    if (view === 'saved') {
      clearStoredDraft();
      setPhase({ kind: 'already' });
      return;
    }
    setPhase({ kind: 'closed', view });
  }

  /** `pageRev` / `retry`: one automatic re-send when only the revision moved (no new line, see below). */
  const submit = async (pageRev: number = rev, retry = true) => {
    if (sending.current || remaining > 0) return;
    let again: number | null = null;
    sending.current = true;
    setPhase({ kind: 'submitting' });
    const started = rt.saveAttempt({ rev: pageRev, auto_resend: !retry });
    try {
      const res = await fetch(`/api/receipt-form/${encodeURIComponent(formId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ exp, sig, rev: pageRev, answers }),
        cache: 'no-store',
      });
      const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (res.ok && data?.ok === true) {
        rt.saveDone(started, true, { http: res.status, saved_lines: data.saved_lines ?? null });
        clearStoredDraft();
        const n = Number(data.saved_lines);
        setPhase({ kind: 'saved', savedLines: Number.isFinite(n) ? n : null });
        return;
      }
      // A page was added since this page loaded: bring it in, keep the draft, ask again.
      if (data?.error === 'lines_changed') {
        const nextRev = Number(data.rev);
        const okRev = Number.isInteger(nextRev) && nextRev >= 1;
        const n = applyLines(normalizeFormLines(data.lines), okRev ? nextRev : pageRev);
        rt.saveDone(started, false, { http: res.status, error: 'lines_changed', new_lines: n, rev: okRev ? nextRev : null });
        // Only the header moved (the bot's append with no new line, e.g. the
        // note's date from page 2): nothing to fill — send again on the new
        // revision instead of "Saving failed" (review 20/10).
        if (!n && retry && okRev && nextRev !== pageRev) {
          again = nextRev;
          return;
        }
        setPhase({ kind: 'error', message: n ? tr(n === 1 ? 'receive.linesChangedOne' : 'receive.linesChanged', { n }) : tr('receive.errorGeneric') });
        return;
      }
      const status = data?.status;
      if (isFinalStatus(status) || isInFlightStatus(status) || status === 'failed') {
        rt.saveDone(started, false, { http: res.status, error: data?.error ?? null, status });
      }
      if (isFinalStatus(status)) {
        onNotOpen(status, data);
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
      rt.saveDone(started, false, { http: res.status, error: err || null, status: status ?? null, bot_message: botMessage !== null });
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
      rt.saveDone(started, false, { error: 'network' });
      setPhase({ kind: 'error', message: tr('receive.errorNetwork') });
    } finally {
      sending.current = false;
      if (again !== null) void submit(again, false);
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
  if (phase.kind === 'closed') {
    const [title, body]: [TranslationKey, TranslationKey] =
      phase.view === 'replaced'
        ? ['receive.replacedTitle', 'receive.replacedBody']
        : phase.view === 'duplicate'
          ? ['receive.duplicateTitle', 'receive.duplicateBody']
          : ['receive.cancelledTitle', 'receive.cancelledBody'];
    return <Outcome dir={dir} icon="info" tone="info" title={tr(title)} body={tr(body)} />;
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

        {/* A page was added to the note while it was open (20/10) — a tap shows the first new line */}
        {pageAdded !== null && (
          <div
            role="status"
            className="flex items-start gap-2 rounded-2xl border-2 border-info bg-info-weak px-3 py-2.5 text-sm font-extrabold text-info-weak-ink"
          >
            <Icon name="note_add" size={20} />
            <button
              type="button"
              className="min-w-0 flex-1 text-start"
              onClick={() => {
                const first = draft.lines.find((d) => newLines.has(d.index));
                if (!first) return;
                setOnlyMissing(false);
                setQuery('');
                setPendingScroll(first.index);
              }}
            >
              {tr(pageAdded === 1 ? 'receive.pageAddedOne' : 'receive.pageAdded', { n: pageAdded })}
            </button>
            <button
              type="button"
              aria-label={tr('receive.remove')}
              onClick={() => setPageAdded(null)}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-lg active:scale-95"
            >
              <Icon name="close" size={18} />
            </button>
          </div>
        )}

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
              onChange={(e) => {
                rt.palletsEdit(e.target.value);
                setDraft((d) => ({ ...d, pallets: e.target.value }));
              }}
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
          <div id="expiry-tools" className="relative overflow-hidden rounded-3xl border-2 border-warn/45 bg-[linear-gradient(160deg,rgba(245,158,11,0.16),rgba(16,28,34,1)_65%)] p-4 space-y-3">
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

        {/* Item search — from SEARCH_MIN_LINES lines; sticky so it is reachable deep in the list */}
        {lines.length >= SEARCH_MIN_LINES && (
          <div role="search" className="sticky top-0 z-20 -mx-3 bg-canvas/95 px-3 py-2 backdrop-blur">
            <div
              className={`flex min-h-12 items-center gap-2 rounded-2xl border-2 bg-sunken ps-3 transition-colors focus-within:border-brand focus-within:ring-4 focus-within:ring-brand/40 ${
                query ? 'border-brand' : 'border-line-strong'
              }`}
            >
              <Icon name="search" size={22} className="text-ink-muted" />
              <input
                ref={searchRef}
                type="search"
                inputMode="search"
                enterKeyHint="search"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                // Page direction, not dir="auto": an empty field resolves "auto" to LTR and the Hebrew hint jumps left.
                dir={dir}
                // The wrapper's border shows focus; the global :focus-visible outline would draw a second box.
                style={{ outline: 'none' }}
                value={query}
                placeholder={tr('receive.searchPlaceholder')}
                aria-label={tr('receive.searchPlaceholder')}
                onChange={(e) => setQuery(e.target.value)}
                onFocus={() => setSearchFocused(true)}
                onBlur={() => setSearchFocused(false)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setQuery('');
                  if (e.key === 'Enter') {
                    // The keyboard's search key: close the keyboard; one result → go to it.
                    e.preventDefault();
                    e.currentTarget.blur();
                    if (search.lines.length === 1 && search.active) {
                      rt.event('receive_search_go', { line: search.lines[0].index });
                      scrollToLine(search.lines[0].index);
                    }
                  }
                }}
                className="min-w-0 flex-1 bg-transparent py-2 pe-3 text-base font-bold text-ink placeholder:text-ink-muted outline-none [&::-webkit-search-cancel-button]:hidden"
              />
              {query && (
                <button
                  type="button"
                  aria-label={tr('receive.searchClear')}
                  onClick={() => {
                    setQuery('');
                    searchRef.current?.focus();
                  }}
                  className="grid h-11 w-11 shrink-0 place-items-center rounded-xl text-ink-muted active:scale-95"
                >
                  <Icon name="close" size={22} />
                </button>
              )}
            </div>
            {search.active && search.lines.length > 0 && (
              <p aria-live="polite" className="mt-1 px-1 text-xs font-bold text-ink-muted">
                {search.fuzzy
                  ? tr('receive.searchFuzzy')
                  : tr('receive.searchCount', { n: search.lines.length, total: lines.length })}
              </p>
            )}
          </div>
        )}

        {/* Which lines to show (dimmed while a search shows lines from the whole note; a tap clears it) */}
        <div
          role="tablist"
          className={`grid grid-cols-2 gap-1 rounded-2xl border-2 border-line bg-sunken p-1 transition-opacity ${
            search.active ? 'opacity-50' : ''
          }`}
        >
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
              isNew={newLines.has(d.index)}
              onChange={onLineChange}
            />
          );
        })}
        {search.active && visible.length === 0 && (
          <div className="rounded-3xl border-2 border-line bg-raised p-5 text-center space-y-3">
            <Icon name="search_off" size={36} className="mx-auto block text-ink-muted" />
            <p className="text-base font-extrabold">{tr('receive.searchNone')}</p>
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => setQuery('')}
                className="min-h-12 rounded-xl border-2 border-line-strong bg-tile px-4 font-extrabold text-ink active:scale-95"
              >
                {tr('receive.searchClear')}
              </button>
              {/* What he is holding is not on the note: start an extra item named as he typed it */}
              <button
                type="button"
                disabled={draft.extras.length >= MAX_EXTRAS}
                onClick={() => {
                  addExtra(query.trim());
                  setQuery('');
                  setPendingScroll({ id: 'extras', last: true });
                }}
                className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border-2 border-dashed border-info/60 bg-info-weak px-4 font-extrabold text-info-weak-ink active:scale-95 disabled:opacity-40"
              >
                <Icon name="add_circle" size={20} />
                {tr('receive.addExtra')}
              </button>
            </div>
          </div>
        )}
        {!search.active && onlyMissing && visible.length === 0 && (
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
          onClick={() => addExtra()}
          disabled={draft.extras.length >= MAX_EXTRAS}
          className="inline-flex w-full min-h-14 items-center justify-center gap-2 rounded-3xl border-2 border-dashed border-info/60 bg-info-weak px-4 font-extrabold text-info-weak-ink active:scale-[0.98] disabled:opacity-40"
        >
          <Icon name="add_circle" size={22} />
          {tr('receive.addExtra')}
        </button>
      </div>

      {/* Sticky footer — hidden while the search field has the keyboard up, so results have room.
          z-30: above the sticky search bar (z-20), which otherwise covered the Next / Approve
          button whenever its place in the page fell behind the footer (top of a long form). */}
      <footer
        className={`${searchFocused ? 'hidden ' : ''}fixed inset-x-0 bottom-0 z-30 border-t border-line bg-header/95 backdrop-blur px-3 pt-2.5 shadow-[0_-10px_30px_rgba(0,0,0,0.45)]`}
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
                onClick={() => void submit()}
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
              onClick={() => void submit()}
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
