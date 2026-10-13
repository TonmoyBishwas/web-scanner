'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { t, useLangDir, type TranslationKey } from '@/lib/i18n';
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

const INPUT =
  'w-full min-w-0 min-h-12 rounded-xl border bg-sunken px-3 text-base text-ink placeholder:text-ink-muted ' +
  'focus:outline-none focus:ring-2 focus:ring-brand-ring [color-scheme:dark]';
const OK_BORDER = 'border-line-strong';
const BAD_BORDER = 'border-danger';

function FieldError({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p className="mt-1 flex items-start gap-1 text-sm font-medium text-danger-weak-ink">
      <span aria-hidden className="mi" style={{ fontSize: 16 }}>
        error
      </span>
      <span>{text}</span>
    </p>
  );
}

function Chip({
  active,
  onClick,
  children,
  tone = 'brand',
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  tone?: 'brand' | 'warn';
}) {
  const on = tone === 'warn' ? 'bg-warn-weak border-warn text-warn-weak-ink' : 'bg-brand-weak border-brand text-brand-weak-ink';
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`min-h-11 rounded-full border px-4 text-sm font-bold whitespace-nowrap ${
        active ? on : 'border-line-strong bg-tile text-ink-body'
      }`}
    >
      {children}
    </button>
  );
}

// ── One delivery-note line ───────────────────────────────────────────────

interface LineCardProps {
  line: FormLine;
  d: LineDraft;
  /** The line's error codes joined with ',' — a string, so memo compares cheaply. */
  errKey: string;
  language: FormLanguage;
  today: string;
  onChange: (index: number, patch: Partial<LineDraft>) => void;
}

const LineCard = memo(function LineCard({ line, d, errKey, language, today, onChange }: LineCardProps) {
  const tr: Tr = (k, v) => t(language, k, v);
  const lang = language === 'Hebrew' ? 'he' : 'en';
  const errors = (errKey ? errKey.split(',') : []) as LineError[];
  const first = (codes: LineError[]) => {
    const hit = errors.find((e) => codes.includes(e));
    return hit ? tr(LINE_ERROR_KEY[hit]) : null;
  };
  const qtyErr = first(['qty_invalid']);
  const cartonsErr = first(['cartons_invalid']);
  const packErr = first(['packaging_invalid']);
  const expiryErr = first(['expiry_missing', 'expiry_invalid', 'expiry_not_future', 'expiry_too_far', 'expiry_conflict']);
  const gapErr = first(['gap_missing', 'gap_invalid', 'gap_note_missing', 'gap_note_too_long']);

  const received = parseDecimal(d.qty);
  const short = isShort(line, received);
  const over = isOver(line, received);

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
  const iso = (v: string) => `\u2068${v}\u2069`;
  const onNote =
    tr('receive.onNote', { what: iso(`${fmtQty(line.qty)} ${line.unit_label || ''}`.trim()) }) +
    (line.cartons !== null ? ` · ${iso(tr('receive.onNotePacks', { n: line.cartons, pack: packWord }))}` : '');

  const set = (patch: Partial<LineDraft>) => onChange(line.index, patch);
  const gapChoice = (g: Gap) => set({ gap: d.gap === g ? null : g });

  return (
    <section
      className={`rounded-2xl border bg-raised p-3 space-y-3 ${errors.length ? 'border-danger' : 'border-line'}`}
      aria-label={`#${line.index} ${name}`}
    >
      <div>
        <h2 className="text-base font-extrabold leading-snug break-words">
          <span className="text-ink-muted font-mono me-1">#{line.index}</span>
          <span dir="auto">{name}</span>
        </h2>
        {sub && (
          <p className="text-xs text-ink-muted break-words" dir="auto">
            {sub}
          </p>
        )}
        <p className="mt-0.5 text-sm text-ink-muted">{onNote}</p>
      </div>

      {/* Received quantity */}
      <div>
        <label className="block text-sm font-bold text-ink-body mb-1" htmlFor={`q-${line.index}`}>
          {qtyLabel}
        </label>
        <div className="flex gap-2">
          <input
            id={`q-${line.index}`}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            dir="ltr"
            value={d.qty}
            onChange={(e) => set({ qty: e.target.value })}
            className={`${INPUT} flex-1 font-mono text-lg ${qtyErr ? BAD_BORDER : OK_BORDER}`}
          />
          <button
            type="button"
            onClick={() => set({ qty: '0' })}
            className={`shrink-0 min-h-12 rounded-xl border px-3 text-sm font-bold ${
              received === 0 ? 'border-warn bg-warn-weak text-warn-weak-ink' : 'border-line-strong bg-tile text-ink-body'
            }`}
          >
            {tr('receive.notArrived')}
          </button>
        </div>
        <FieldError text={qtyErr} />
        {short && (
          <p className="mt-1 text-sm font-bold text-warn-weak-ink">
            {tr('receive.shortBy', { x: fmtQty(line.qty - received) })}
          </p>
        )}
        {over && (
          <p className="mt-1 text-sm font-bold text-info-weak-ink">
            {tr('receive.over', { x: `\u2066+${fmtQty(received - line.qty)}\u2069` })}
          </p>
        )}
      </div>

      {/* Why short */}
      {short && (
        <div>
          <p className="text-sm font-bold text-ink-body mb-1">{tr('receive.gapQuestion')}</p>
          <div className="flex flex-wrap gap-2">
            <Chip tone="warn" active={d.gap === 'will'} onClick={() => gapChoice('will')}>
              {tr('receive.gapWill')}
            </Chip>
            <Chip tone="warn" active={d.gap === 'wont'} onClick={() => gapChoice('wont')}>
              {tr('receive.gapWont')}
            </Chip>
            <Chip tone="warn" active={d.gap === 'other'} onClick={() => gapChoice('other')}>
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
              className={`${INPUT} mt-2 ${errors.includes('gap_note_missing') || errors.includes('gap_note_too_long') ? BAD_BORDER : OK_BORDER}`}
            />
          )}
          <FieldError text={gapErr} />
        </div>
      )}

      {/* Cartons + packaging */}
      <div className="grid grid-cols-2 gap-2">
        <div className="min-w-0">
          <label className="block text-sm font-bold text-ink-body mb-1" htmlFor={`c-${line.index}`}>
            {tr('receive.cartons')}
          </label>
          <input
            id={`c-${line.index}`}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            dir="ltr"
            value={d.cartons}
            onChange={(e) => set({ cartons: e.target.value })}
            className={`${INPUT} font-mono ${cartonsErr ? BAD_BORDER : OK_BORDER}`}
          />
          <FieldError text={cartonsErr} />
        </div>
        <div className="min-w-0">
          <label className="block text-sm font-bold text-ink-body mb-1" htmlFor={`p-${line.index}`}>
            {tr('receive.packaging')}
          </label>
          <select
            id={`p-${line.index}`}
            value={d.packaging}
            onChange={(e) => set({ packaging: e.target.value as Packaging | '' })}
            className={`${INPUT} ${packErr ? BAD_BORDER : OK_BORDER}`}
          >
            <option value="">{tr('receive.packagingNone')}</option>
            {PACKAGING.map((p) => (
              <option key={p} value={p}>
                {PACKAGING_LABELS[p][lang]}
              </option>
            ))}
          </select>
          <FieldError text={packErr} />
        </div>
      </div>

      {/* Expiry */}
      {line.needs_expiry && (
        <div>
          <label className="block text-sm font-bold text-ink-body mb-1" htmlFor={`e-${line.index}`}>
            {tr('receive.expiry')}
          </label>
          <div className="flex gap-2">
            <input
              id={`e-${line.index}`}
              type="date"
              dir="ltr"
              min={addDaysIso(today, 1)}
              max={maxExpiryIso(today)}
              value={d.noExpiry ? '' : d.expiry}
              disabled={d.noExpiry}
              onChange={(e) => set({ expiry: e.target.value, noExpiry: false })}
              className={`${INPUT} flex-1 font-mono disabled:opacity-40 ${expiryErr ? BAD_BORDER : OK_BORDER}`}
            />
            <Chip
              active={d.noExpiry}
              onClick={() => set(d.noExpiry ? { noExpiry: false } : { noExpiry: true, expiry: '' })}
            >
              {tr('receive.noExpiry')}
            </Chip>
          </div>
          <FieldError text={expiryErr} />
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
    <section className={`rounded-2xl border bg-raised p-3 space-y-2 ${errors.length ? 'border-danger' : 'border-line'}`}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-extrabold text-info-weak-ink">{tr('receive.extraTitle')}</h2>
        <button
          type="button"
          onClick={() => onRemove(x.key)}
          className="min-h-11 rounded-xl border border-line-strong px-3 text-sm font-bold text-ink-body"
        >
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
          className={`${INPUT} ${nameErr ? BAD_BORDER : OK_BORDER}`}
        />
        <FieldError text={nameErr ? tr(EXTRA_ERROR_KEY[nameErr]) : null} />
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
          className={`${INPUT} font-mono ${qtyErr ? BAD_BORDER : OK_BORDER}`}
        />
        <select
          value={x.unit}
          aria-label={tr('receive.extraUnit')}
          onChange={(e) => onChange(x.key, { unit: e.target.value as ExtraDraft['unit'] })}
          className={`${INPUT} ${OK_BORDER}`}
        >
          {EXTRA_UNITS.map((u) => (
            <option key={u} value={u}>
              {EXTRA_UNIT_LABELS[u][lang]}
            </option>
          ))}
        </select>
      </div>
      <FieldError text={qtyErr ? tr(EXTRA_ERROR_KEY[qtyErr]) : null} />
    </section>
  );
}

// ── Full-screen outcomes ─────────────────────────────────────────────────

function Outcome({ dir, icon, tone, title, body, action }: {
  dir: 'rtl' | 'ltr';
  icon: string;
  tone: string;
  title: string;
  body?: string;
  action?: React.ReactNode;
}) {
  return (
    <main dir={dir} className="min-h-dvh bg-canvas text-ink flex items-center justify-center px-4">
      <div className="w-full max-w-md rounded-2xl border border-line bg-raised p-6 text-center space-y-3">
        <span aria-hidden className={`mi ${tone}`} style={{ fontSize: 56 }}>
          {icon}
        </span>
        <h1 className="text-xl font-extrabold leading-snug">{title}</h1>
        {body && <p className="text-ink-body">{body}</p>}
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

  const toggleOnlyMissing = () => {
    setOnlyMissing((v) => !v);
    setTouched(new Set());
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
        icon="check_circle"
        tone="text-ok"
        title={tr('receive.saved')}
        body={phase.savedLines !== null ? tr('receive.savedLines', { n: phase.savedLines }) : undefined}
      />
    );
  }
  if (phase.kind === 'already') {
    return (
      <Outcome dir={dir} icon="check_circle" tone="text-ok" title={tr('receive.alreadySavedTitle')} body={tr('receive.alreadySavedBody')} />
    );
  }
  if (phase.kind === 'failed') {
    return <Outcome dir={dir} icon="info" tone="text-info" title={tr('receive.failedTitle')} body={tr('receive.failedBody')} />;
  }
  if (phase.kind === 'inflight') {
    return (
      <Outcome
        dir={dir}
        icon="hourglass_top"
        tone="text-warn"
        title={tr('receive.beingSavedTitle')}
        body={tr('receive.beingSavedBody')}
        action={
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="inline-flex min-h-12 items-center justify-center rounded-xl border border-line-strong px-6 font-bold text-ink"
          >
            {tr('receive.refresh')}
          </button>
        }
      />
    );
  }

  const submitting = phase.kind === 'submitting';
  const palletsBad = check.form.includes('pallets_invalid');

  return (
    <main dir={dir} lang={language === 'Hebrew' ? 'he' : 'en'} className="min-h-dvh bg-canvas text-ink">
      <div className="mx-auto max-w-xl px-3 pt-4 pb-44 space-y-3">
        {/* Header */}
        <header className="rounded-2xl border border-line bg-header p-3 space-y-2">
          <h1 className="text-lg font-extrabold leading-snug break-words" dir="auto">
            {header.supplier || tr('receive.title')}
          </h1>
          <p className="flex flex-wrap gap-x-3 gap-y-1 text-sm text-ink-body">
            {header.invoice_number && <span>{tr('receive.invoice', { n: header.invoice_number })}</span>}
            {header.invoice_date && <span className="font-mono">{formatDdMmYyyy(header.invoice_date)}</span>}
            <span>{tr('receive.lineCount', { n: lines.length })}</span>
          </p>
          <div className="flex items-center gap-2">
            <label htmlFor="pallets" className="text-sm font-bold text-ink-body shrink-0">
              {tr('receive.pallets')}
            </label>
            <input
              id="pallets"
              type="text"
              inputMode="numeric"
              dir="ltr"
              autoComplete="off"
              value={draft.pallets}
              placeholder={tr('receive.optional')}
              onChange={(e) => setDraft((d) => ({ ...d, pallets: e.target.value }))}
              className={`${INPUT.replace('w-full ', '')} w-28 flex-none font-mono ${palletsBad ? BAD_BORDER : OK_BORDER}`}
            />
          </div>
          <FieldError text={palletsBad ? tr('receive.err.pallets') : null} />
        </header>

        {/* Toolbar */}
        <div className="rounded-2xl border border-line bg-raised p-3 space-y-3">
          {anyNeedsExpiry && (
            <>
              <div>
                <label htmlFor="same-date" className="block text-sm font-bold text-ink-body mb-1">
                  {tr('receive.sameDate')}
                </label>
                <div className="flex gap-2">
                  <input
                    id="same-date"
                    type="date"
                    dir="ltr"
                    min={addDaysIso(today, 1)}
                    max={maxExpiryIso(today)}
                    value={sameDate}
                    onChange={(e) => setSameDate(e.target.value)}
                    className={`${INPUT} flex-1 font-mono ${sameDateErr ? BAD_BORDER : OK_BORDER}`}
                  />
                  <button
                    type="button"
                    onClick={applySameDate}
                    disabled={!sameDate || !!sameDateErr || wantingExpiry === 0}
                    className="shrink-0 min-h-12 rounded-xl bg-brand px-4 font-bold text-ink-inverse disabled:opacity-40"
                  >
                    {tr('receive.sameDateApply')}
                  </button>
                </div>
                <FieldError text={sameDateErr ? tr(LINE_ERROR_KEY[sameDateErr]) : null} />
                <p className="mt-1 text-xs text-ink-muted">{tr('receive.sameDateHint', { n: wantingExpiry })}</p>
              </div>
              <button
                type="button"
                onClick={restNoExpiry}
                disabled={wantingExpiry === 0}
                className="w-full min-h-12 rounded-xl border border-line-strong bg-tile px-4 font-bold text-ink disabled:opacity-40"
              >
                {tr('receive.restNoExpiry')}
              </button>
            </>
          )}
          <label className="flex items-center justify-between gap-3 min-h-11 cursor-pointer">
            <span className="text-sm font-bold text-ink-body">{tr('receive.onlyMissing')}</span>
            <input
              type="checkbox"
              role="switch"
              checked={onlyMissing}
              onChange={toggleOnlyMissing}
              className="h-6 w-6 shrink-0 accent-[var(--brand)]"
            />
          </label>
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
              onChange={onLineChange}
            />
          );
        })}
        {onlyMissing && visible.length === 0 && (
          <div className="rounded-2xl border border-line bg-raised p-4 text-center space-y-2">
            <p className="font-bold text-ok-weak-ink">{tr('receive.nothingMissing')}</p>
            <button type="button" onClick={toggleOnlyMissing} className="min-h-11 px-4 font-bold text-brand-weak-ink underline">
              {tr('receive.showAll')}
            </button>
          </div>
        )}

        {/* Items not on the note */}
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
        {check.form.includes('too_many_extras') && <FieldError text={tr('receive.err.tooManyExtras')} />}
        <button
          type="button"
          onClick={addExtra}
          disabled={draft.extras.length >= MAX_EXTRAS}
          className="w-full min-h-12 rounded-2xl border border-dashed border-line-strong px-4 font-bold text-ink-body disabled:opacity-40"
        >
          {tr('receive.addExtra')}
        </button>
      </div>

      {/* Sticky footer */}
      <footer
        className="fixed inset-x-0 bottom-0 border-t border-line bg-header/95 backdrop-blur px-3 pt-2"
        style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
      >
        <div className="mx-auto max-w-xl space-y-2">
          {phase.kind === 'error' && (
            <div role="alert" className="rounded-xl border border-danger/40 bg-danger-weak p-2 text-sm text-danger-weak-ink flex items-center gap-2">
              <span className="flex-1" dir="auto">
                {phase.message}
              </span>
              <button
                type="button"
                onClick={submit}
                disabled={remaining > 0}
                className="shrink-0 min-h-10 rounded-lg border border-danger/50 px-3 font-bold disabled:opacity-40"
              >
                {tr('receive.retry')}
              </button>
            </div>
          )}
          <p className={`text-center text-sm font-bold ${remaining > 0 ? 'text-warn-weak-ink' : 'text-ok-weak-ink'}`}>
            {remaining === 0
              ? tr('receive.allReady')
              : remaining === 1
                ? tr('receive.remainingOne')
                : tr('receive.remaining', { k: remaining })}
          </p>
          <button
            type="button"
            onClick={submit}
            disabled={remaining > 0 || submitting}
            aria-busy={submitting}
            className="w-full min-h-14 rounded-2xl bg-ok px-4 text-lg font-extrabold text-canvas disabled:bg-tile disabled:text-ink-muted flex items-center justify-center gap-2"
          >
            {submitting && (
              <span aria-hidden className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent" />
            )}
            {submitting ? tr('receive.submitting') : tr('receive.submit')}
          </button>
        </div>
      </footer>
    </main>
  );
}
