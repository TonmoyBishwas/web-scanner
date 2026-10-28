'use client';

/**
 * One delivery-note line, compact (receive redesign 28/10, flag
 * `receive_redesign`). The note already pre-fills quantity, cartons and the
 * package, so they fold into ONE summary row with an edit chip; only what is
 * still missing stays open (usually the expiry, or why a line is short). A
 * field with a wrong value opens by itself. The title is the Priority item's
 * name when the code maps, the printed name a small subtitle under it; a line
 * whose quantity × unit price ≠ line total gets the amber border and a label.
 *
 * The open fields are the same controls as ReceiptForm's LineCard, which stays
 * the form while the flag is off.
 */
import { memo, useState } from 'react';
import { t } from '@/lib/i18n';
import { DateEntry } from '@/components/shared/DateEntry';
import {
  PACKAGING,
  PACKAGING_LABELS,
  addDaysIso,
  fmtQty,
  formatDdMmYyyy,
  isOver,
  isShort,
  maxExpiryIso,
  packBadge,
  parseDecimal,
  parseWholeOrBlank,
  type FormLanguage,
  type FormLine,
  type Gap,
  type LineDraft,
  type LineError,
  type Packaging,
} from '@/lib/receipt-form';
import { lineNames } from '@/lib/receive-walk';
import {
  BAD_BORDER,
  CALENDAR_BTN,
  Chip,
  DATE_ROW,
  DONE_BORDER,
  FieldError,
  FieldLabel,
  INPUT,
  Icon,
  LINE_ERROR_KEY,
  OK_BORDER,
  STATUS_STYLE,
  TODO_BORDER,
  TODO_ERRORS,
  lineStatus,
  type Tr,
} from './ui';

export interface CompactLineCardProps {
  line: FormLine;
  d: LineDraft;
  /** The line's error codes joined with ',' — a string, so memo compares cheaply. */
  errKey: string;
  language: FormLanguage;
  today: string;
  flash: boolean;
  isNew: boolean;
  onChange: (index: number, patch: Partial<LineDraft>) => void;
  /** The edit chip opened / closed the folded fields (the trace's receive_step). */
  onEdit?: (index: number, open: boolean) => void;
}

/** A figure + its word as one bidi isolate, so a Hebrew unit cannot swap sides with its number. */
const iso = (v: string) => `⁨${v}⁩`;

export const CompactLineCard = memo(function CompactLineCard({
  line,
  d,
  errKey,
  language,
  today,
  flash,
  isNew,
  onChange,
  onEdit,
}: CompactLineCardProps) {
  const tr: Tr = (k, v) => t(language, k, v);
  const lang = language === 'Hebrew' ? 'he' : 'en';
  const [editing, setEditing] = useState(false);
  /** Typed into here: the expiry stays open once filled, so it never folds away mid-typing. */
  const [expiryTyped, setExpiryTyped] = useState(false);
  const errors = (errKey ? errKey.split(',') : []) as LineError[];
  const first = (codes: LineError[]) => errors.find((e) => codes.includes(e)) ?? null;
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
  const qtyCheck = !!line.qty_check;
  // The amber card for a line to check, unless something is already red.
  const cardStyle = qtyCheck && status === 'ready' ? STATUS_STYLE.todo.card : st.card;

  const received = parseDecimal(d.qty);
  const short = isShort(line, received);
  const over = isOver(line, received);
  const same = Number.isFinite(received) && !short && !over;
  const notArrived = received === 0;

  const { title, subtitle } = lineNames(line);
  const enSub = language === 'English' && line.name_en && line.name_en !== title ? line.name_en : '';
  const qtyLabel = line.weighed
    ? tr('receive.qtyWeighed')
    : line.unit_label
      ? tr('receive.qtyUnit', { unit: line.unit_label })
      : tr('receive.qtyPlain');

  // The summary shows what WILL be saved (the draft), which is the note until edited.
  const cartonsN = parseWholeOrBlank(d.cartons);
  const badge = packBadge(
    { cartons: Number.isFinite(cartonsN) ? cartonsN : null, packaging: d.packaging || null, per_pack: line.per_pack, inner: line.inner },
    lang,
    tr('receive.packsWord'),
  );
  const sumQty = iso(`${d.qty.trim() || '?'} ${line.unit_label || ''}`.trim());
  const sumPacks = badge.packs ? iso(tr('receive.onNotePacks', badge.packs)) : null;
  const sumPerPack = badge.perPack ? iso(tr('receive.perPack', badge.perPack)) : null;

  const set = (patch: Partial<LineDraft>) => onChange(line.index, patch);
  const gapChoice = (g: Gap) => set({ gap: d.gap === g ? null : g });
  const expiryDone = d.noExpiry || (!!d.expiry && !expiryErr);

  // A wrong value opens its fields by itself; the chip opens them on demand.
  const forced = !!(qtyErr || cartonsErr || packErr);
  const open = editing || forced;
  const showExpiry = line.needs_expiry && (open || expiryTyped || !expiryDone || !!expiryErr);
  const setExpiry = (patch: Partial<LineDraft>) => {
    setExpiryTyped(true);
    set(patch);
  };
  const toggle = () => {
    const next = !editing;
    setEditing(next);
    onEdit?.(line.index, next);
  };

  return (
    <section
      id={`line-${line.index}`}
      className={`relative scroll-mt-4 overflow-hidden rounded-3xl border-2 border-s-[6px] p-4 space-y-3 shadow-lg shadow-black/30 transition-shadow ${cardStyle} ${
        flash ? 'ring-4 ring-brand' : ''
      }`}
      aria-label={`#${line.index} ${title}`}
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
            {title}
          </h2>
          {subtitle && (
            <p className="text-xs text-ink-muted break-words" dir="auto">
              {subtitle}
            </p>
          )}
          {enSub && (
            <p className="text-xs text-ink-muted break-words" dir="auto">
              {enSub}
            </p>
          )}
          {/* The pills wrap as a row: a second one never sits indented under the first. */}
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-extrabold ${st.pill}`}>
              <Icon name={status === 'todo' && !errors.includes('expiry_missing') ? 'help' : st.icon} size={14} />
              {statusText}
            </span>
            {qtyCheck && (
              <span className="inline-flex items-center gap-1 rounded-full border border-warn/50 bg-warn-weak px-2.5 py-0.5 text-xs font-extrabold text-warn-weak-ink">
                <Icon name="calculate" size={14} />
                {tr('receive.v2.qtyCheck')}
              </span>
            )}
            {isNew && (
              <span className="inline-flex items-center gap-1 rounded-full bg-info px-2.5 py-0.5 text-xs font-extrabold text-[#160a33]">
                <Icon name="fiber_new" size={14} />
                {tr('receive.newLineTag')}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Quantity · cartons · package, folded; the chip opens them */}
      <div
        className={`flex items-center gap-2 rounded-2xl border px-3 py-2 text-sm ${
          qtyCheck ? 'border-warn/50 bg-warn-weak' : 'border-brand/30 bg-brand-weak'
        }`}
      >
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          <Icon name={line.weighed ? 'scale' : 'tag'} size={18} className="text-brand-weak-ink" />
          <span className="font-extrabold text-ink">{sumQty}</span>
          {/* Each dot travels with the item after it: a wrap never leaves a dot at a line end. */}
          {sumPacks && (
            <span className="inline-flex items-center gap-2">
              <span className="text-ink-muted">·</span>
              <span className="font-extrabold text-ink">{sumPacks}</span>
            </span>
          )}
          {sumPerPack && (
            <span className="inline-flex items-center gap-2">
              <span className="text-ink-muted">·</span>
              <span className="font-bold text-ink-body">{sumPerPack}</span>
            </span>
          )}
          {line.needs_expiry && expiryDone && !showExpiry && (
            <span className="inline-flex items-center gap-2">
              <span className="text-ink-muted">·</span>
              <span className="inline-flex items-center gap-1 font-bold text-ok-weak-ink">
                <Icon name={d.noExpiry ? 'event_busy' : 'event_available'} size={16} />
                {d.noExpiry ? tr('receive.noExpiry') : <span className="font-mono">{formatDdMmYyyy(d.expiry)}</span>}
              </span>
            </span>
          )}
        </div>
        {!forced && (
          <Chip active={editing} onClick={toggle} icon="edit">
            {tr('receive.v2.edit')}
          </Chip>
        )}
      </div>
      {!open && short && (
        <p className="inline-flex items-center gap-1 rounded-full bg-warn px-3 py-1 text-sm font-extrabold text-[#1a1100]">
          <Icon name="trending_down" size={17} />
          {tr('receive.shortBy', { x: fmtQty(line.qty - received) })}
        </p>
      )}
      {!open && over && (
        <p className="inline-flex items-center gap-1 rounded-full bg-info px-3 py-1 text-sm font-extrabold text-[#160a33]">
          <Icon name="trending_up" size={17} />
          {tr('receive.over', { x: `⁦+${fmtQty(received - line.qty)}⁩` })}
        </p>
      )}

      {open && (
        <>
          {/* What the note says, next to the fields that change it */}
          <p className="flex flex-wrap items-center gap-2 text-sm">
            <Icon name="receipt_long" size={18} className="text-brand-weak-ink" />
            <span className="font-bold text-brand-weak-ink">{tr('receive.onNoteLabel')}</span>
            <span className="font-extrabold text-ink">{iso(`${fmtQty(line.qty)} ${line.unit_label || ''}`.trim())}</span>
          </p>

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
                  notArrived ? 'border-danger bg-danger text-white' : 'border-danger/40 bg-danger-weak text-danger-weak-ink'
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
        </>
      )}

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

      {/* Expiry: open while missing or wrong; folded into the summary once given */}
      {showExpiry && (
        <div>
          <FieldLabel htmlFor={`e-${line.index}`} icon="event">
            {tr('receive.expiry')}
          </FieldLabel>
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
              onChange={(v) => setExpiry({ expiry: v, noExpiry: false })}
              className={DATE_ROW}
              inputClassName={`${INPUT} flex-1 font-mono text-lg font-bold disabled:opacity-35 ${borderFor(expiryErr, expiryDone)}`}
              buttonClassName={CALENDAR_BTN}
            />
            <Chip
              tone="ok"
              icon="block"
              active={d.noExpiry}
              onClick={() => setExpiry(d.noExpiry ? { noExpiry: false } : { noExpiry: true, expiry: '' })}
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
