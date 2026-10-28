'use client';

/**
 * The expiry walk (receive redesign 28/10, flag `receive_redesign`): a
 * full-screen card, one line at a time — the item's name big, the printed
 * name under it, its code, the package and count, the date (typed on the
 * numeric keypad, or the calendar) and "no expiry". "Next" skips to the next
 * line still without an answer; "Which item is in front of you?" picks any
 * line, grouped by package type, with a search — the goods stand on the
 * pallets in their own order, not the note's.
 *
 * It edits the same draft as the list (`onChange`), so leaving the walk loses
 * nothing and the list's validation, counts and Approve see every answer.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { t } from '@/lib/i18n';
import { DateEntry } from '@/components/shared/DateEntry';
import {
  PACKAGING_PLURAL,
  addDaysIso,
  fmtQty,
  maxExpiryIso,
  packBadge,
  type FormLanguage,
  type FormLine,
  type LineDraft,
  type LineError,
} from '@/lib/receipt-form';
import { searchLines } from '@/lib/receipt-form-search';
import { groupByPackage, isDated, lineNames, nextUndated, prevInWalk, walkOrder } from '@/lib/receive-walk';
import {
  CALENDAR_BTN,
  Chip,
  DATE_ROW,
  DONE_BORDER,
  FieldError,
  FieldLabel,
  INPUT,
  Icon,
  LINE_ERROR_KEY,
  STATUS_STYLE,
  TODO_BORDER,
  BAD_BORDER,
  TODO_ERRORS,
  type Tr,
} from './ui';

export type WalkVia = 'next' | 'back' | 'pick';

const EXPIRY_ERRORS: readonly LineError[] = [
  'expiry_missing',
  'expiry_invalid',
  'expiry_not_future',
  'expiry_too_far',
  'expiry_conflict',
];

const iso = (v: string) => `⁨${v}⁩`;

export function ExpiryWalk({
  lines,
  drafts,
  lineErrors,
  language,
  today,
  start,
  onChange,
  onStep,
  onExit,
}: {
  lines: FormLine[];
  drafts: LineDraft[];
  lineErrors: Record<number, LineError[]>;
  language: FormLanguage;
  today: string;
  /** The line the walk opens on. */
  start: number | null;
  onChange: (index: number, patch: Partial<LineDraft>) => void;
  /** Every move inside the walk, for the trace (receive_step). */
  onStep: (step: string, data: Record<string, unknown>) => void;
  /** Back to the list; `line` = where the walk was. */
  onExit: (line: number | null) => void;
}) {
  const tr: Tr = (k, v) => t(language, k, v);
  const lang = language === 'Hebrew' ? 'he' : 'en';
  const dir = language === 'Hebrew' ? 'rtl' : 'ltr';

  const lineByIndex = useMemo(() => new Map(lines.map((l) => [l.index, l])), [lines]);
  const draftByIndex = useMemo(() => new Map(drafts.map((d) => [d.index, d])), [drafts]);
  const order = useMemo(() => walkOrder(lines, drafts), [lines, drafts]);
  const undated = (i: number) => {
    const d = draftByIndex.get(i);
    return !!d && !isDated(d, today);
  };
  const dated = order.filter((i) => !undated(i)).length;

  const [current, setCurrent] = useState<number | null>(start ?? order[0] ?? null);
  const [done, setDone] = useState(false);
  const [picker, setPicker] = useState(false);
  const [query, setQuery] = useState('');
  const [nudge, setNudge] = useState(false);
  const top = useRef<HTMLDivElement>(null);

  // The line left the walk (marked "did not arrive" in the list, or the
  // lines changed): fall back to the next one still to date.
  const cur = current !== null && order.includes(current) ? current : (order.find(undated) ?? order[0] ?? null);

  // A new line on screen: back to the top, the date field ready for the keypad.
  useEffect(() => {
    if (cur === null || done) return;
    top.current?.scrollIntoView({ block: 'start' });
    const el = document.getElementById(`e-${cur}`) as HTMLInputElement | null;
    if (el && !el.disabled) el.focus({ preventScroll: true });
  }, [cur, done]);

  useEffect(() => {
    if (!nudge) return;
    const id = window.setTimeout(() => setNudge(false), 900);
    return () => window.clearTimeout(id);
  }, [nudge]);

  const go = (to: number, via: WalkVia) => {
    onStep('walk_line', { line: to, via, from: cur, dated, total: order.length });
    setDone(false);
    setCurrent(to);
  };
  const next = () => {
    const n = nextUndated(order, undated, cur);
    if (n !== null) return go(n, 'next');
    if (cur !== null && undated(cur)) {
      // The only line still without a date is this one.
      setNudge(true);
      return;
    }
    onStep('walk_done', { dated, total: order.length });
    setDone(true);
  };
  const back = () => {
    if (done) {
      setDone(false);
      return;
    }
    const p = prevInWalk(order, cur);
    if (p !== null) go(p, 'back');
  };
  const openPicker = (open: boolean) => {
    onStep('walk_pick', { open, line: cur });
    setPicker(open);
    if (!open) setQuery('');
  };

  // ── The picker's list ──
  const walkLines = useMemo(() => order.map((i) => lineByIndex.get(i)).filter((l): l is FormLine => !!l), [order, lineByIndex]);
  const search = useMemo(() => searchLines(walkLines, query), [walkLines, query]);
  const shown = useMemo(() => new Set(search.lines.map((l) => l.index)), [search]);
  const groups = useMemo(
    () => groupByPackage(lines, drafts, order.filter((i) => shown.has(i))),
    [lines, drafts, order, shown],
  );

  const line = cur !== null ? lineByIndex.get(cur) : undefined;
  const d = cur !== null ? draftByIndex.get(cur) : undefined;
  const pct = order.length ? Math.round((dated / order.length) * 100) : 100;

  return (
    <main
      dir={dir}
      lang={lang}
      className="min-h-dvh text-ink bg-[radial-gradient(120%_60%_at_50%_0%,rgba(245,158,11,0.14),var(--surface-canvas)_60%)]"
    >
      <div ref={top} className="mx-auto max-w-xl px-3 pt-4 pb-56 space-y-4">
        {/* Back to the list + progress */}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => onExit(cur)}
            className="inline-flex shrink-0 min-h-11 items-center gap-1 rounded-xl border-2 border-line-strong bg-tile px-3 text-sm font-extrabold text-ink active:scale-95"
          >
            <Icon name="arrow_back" size={18} className="rtl:-scale-x-100" />
            {tr('receive.v2.walkExit')}
          </button>
          <div className="min-w-0 flex-1">
            <p className="mb-1 text-sm font-extrabold" aria-live="polite">
              {tr('receive.v2.walkProgress', { n: dated, m: order.length })}
            </p>
            <div className="h-2.5 overflow-hidden rounded-full bg-white/15">
              <div
                className={`h-full rounded-full transition-[width] duration-500 ${pct === 100 ? 'bg-[#4ade80]' : 'bg-[linear-gradient(90deg,#fde047,#fb923c)]'}`}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        </div>

        {done || !line || !d ? (
          <div className="rounded-3xl border-2 border-ok/50 bg-[linear-gradient(180deg,rgba(34,197,94,0.14),rgba(16,28,34,1))] p-6 text-center space-y-4">
            <span className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-ok text-[#04210f] shadow-[0_0_30px_rgba(34,197,94,0.45)]">
              <Icon name="done_all" size={36} />
            </span>
            <p className="text-lg font-extrabold text-ok-weak-ink">{tr('receive.expiryAllSet')}</p>
            <button
              type="button"
              onClick={() => onExit(cur)}
              className="w-full min-h-14 rounded-2xl bg-brand px-4 text-lg font-black text-white active:scale-[0.98]"
            >
              {tr('receive.v2.walkExit')}
            </button>
          </div>
        ) : (
          <WalkCard
            line={line}
            d={d}
            errors={lineErrors[line.index] ?? []}
            language={language}
            today={today}
            nudge={nudge}
            onChange={onChange}
          />
        )}
      </div>

      {/* Picker + back / next */}
      <footer
        className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-header/95 backdrop-blur px-3 pt-2.5 shadow-[0_-10px_30px_rgba(0,0,0,0.45)]"
        style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
      >
        <div className="mx-auto max-w-xl space-y-2">
          <button
            type="button"
            onClick={() => openPicker(true)}
            className="inline-flex w-full min-h-12 items-center justify-center gap-2 rounded-2xl border-2 border-info/60 bg-info-weak px-4 font-extrabold text-info-weak-ink active:scale-[0.98]"
          >
            <Icon name="pan_tool_alt" size={22} />
            {tr('receive.v2.walkPick')}
          </button>
          <div className="grid grid-cols-[1fr_2fr] gap-2">
            <button
              type="button"
              onClick={back}
              disabled={!done && prevInWalk(order, cur) === null}
              className="inline-flex min-h-14 items-center justify-center gap-1 rounded-2xl border-2 border-line-strong bg-tile px-3 text-base font-extrabold text-ink active:scale-[0.98] disabled:opacity-35"
            >
              <Icon name="arrow_forward" size={20} className="ltr:-scale-x-100" />
              {tr('receive.v2.walkBack')}
            </button>
            <button
              type="button"
              onClick={next}
              disabled={done}
              className="inline-flex min-h-14 items-center justify-center gap-2 rounded-2xl px-4 text-lg font-black text-[#1a1100] bg-[linear-gradient(135deg,#fde047,#f59e0b)] shadow-[0_8px_28px_rgba(245,158,11,0.35)] active:scale-[0.98] disabled:opacity-35"
            >
              {tr('receive.v2.walkNext')}
              <Icon name="arrow_forward" size={22} className="rtl:-scale-x-100" />
            </button>
          </div>
        </div>
      </footer>

      {/* "Which item is in front of you?" */}
      {picker && (
        <div role="dialog" aria-modal="true" aria-label={tr('receive.v2.walkPick')} className="fixed inset-0 z-40 flex items-end bg-black/60">
          <div className="mx-auto flex max-h-[88dvh] w-full max-w-xl flex-col rounded-t-3xl border-t-2 border-line bg-raised shadow-2xl">
            <div className="flex items-center gap-2 px-4 pt-4 pb-2">
              <h2 className="min-w-0 flex-1 text-lg font-black">{tr('receive.v2.walkPick')}</h2>
              <button
                type="button"
                aria-label={tr('common.close')}
                onClick={() => openPicker(false)}
                className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border-2 border-line-strong bg-tile active:scale-95"
              >
                <Icon name="close" size={22} />
              </button>
            </div>
            <div role="search" className="px-4 pb-2">
              <div className="flex min-h-12 items-center gap-2 rounded-2xl border-2 border-line-strong bg-sunken ps-3 focus-within:border-brand">
                <Icon name="search" size={22} className="text-ink-muted" />
                <input
                  type="search"
                  inputMode="search"
                  enterKeyHint="search"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  dir={dir}
                  style={{ outline: 'none' }}
                  value={query}
                  placeholder={tr('receive.searchPlaceholder')}
                  aria-label={tr('receive.searchPlaceholder')}
                  onChange={(e) => setQuery(e.target.value)}
                  className="min-w-0 flex-1 bg-transparent py-2 pe-3 text-base font-bold text-ink placeholder:text-ink-muted outline-none [&::-webkit-search-cancel-button]:hidden"
                />
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 space-y-4" style={{ paddingBottom: 'max(1.5rem, env(safe-area-inset-bottom))' }}>
              {groups.length === 0 && (
                <p className="py-6 text-center text-base font-extrabold text-ink-muted">{tr('receive.searchNone')}</p>
              )}
              {groups.map((g) => (
                <section key={g.packaging} className="space-y-2">
                  <h3 className="flex items-center gap-1.5 text-sm font-extrabold text-ink-body">
                    <Icon name="inventory_2" size={18} className="text-brand-weak-ink" />
                    {PACKAGING_PLURAL[g.packaging][lang]}
                    <span className="text-ink-muted">({g.lines.length})</span>
                  </h3>
                  {g.lines.map((i) => {
                    const l = lineByIndex.get(i);
                    if (!l) return null;
                    const { title, subtitle } = lineNames(l);
                    const ok = !undated(i);
                    return (
                      <button
                        key={i}
                        type="button"
                        aria-current={i === cur ? 'true' : undefined}
                        onClick={() => {
                          onStep('walk_pick', { open: false, picked: i, query_len: query.trim().length });
                          setPicker(false);
                          setQuery('');
                          go(i, 'pick');
                        }}
                        className={`flex w-full items-center gap-3 rounded-2xl border-2 px-3 py-2.5 text-start active:scale-[0.99] ${
                          i === cur ? 'border-brand bg-brand-weak' : ok ? 'border-ok/40 bg-tile/60' : 'border-line-strong bg-tile'
                        }`}
                      >
                        <span
                          className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-xs font-black ${
                            ok ? 'bg-ok text-[#04210f]' : 'bg-warn text-[#1a1100]'
                          }`}
                          aria-hidden
                        >
                          {ok ? <Icon name="check" size={18} /> : l.index}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className={`block font-extrabold leading-snug break-words ${ok ? 'text-ink-body' : 'text-ink'}`} dir="auto">
                            {title}
                          </span>
                          {subtitle && (
                            <span className="block text-xs text-ink-muted break-words" dir="auto">
                              {subtitle}
                            </span>
                          )}
                        </span>
                        {l.code && (
                          <span className="shrink-0 font-mono text-xs text-ink-muted" dir="ltr">
                            {l.code}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </section>
              ))}
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

/** The walk's one line: name big, printed name, code, package + count, the date. */
function WalkCard({
  line,
  d,
  errors,
  language,
  today,
  nudge,
  onChange,
}: {
  line: FormLine;
  d: LineDraft;
  errors: LineError[];
  language: FormLanguage;
  today: string;
  nudge: boolean;
  onChange: (index: number, patch: Partial<LineDraft>) => void;
}) {
  const tr: Tr = (k, v) => t(language, k, v);
  const lang = language === 'Hebrew' ? 'he' : 'en';
  const { title, subtitle } = lineNames(line);
  const expiryErr = errors.find((e) => EXPIRY_ERRORS.includes(e)) ?? null;
  const doneHere = isDated(d, today);
  const badge = packBadge(line, lang, tr('receive.packsWord'));
  const packs = badge.packs ? iso(tr('receive.onNotePacks', badge.packs)) : null;
  const perPack = badge.perPack ? iso(tr('receive.perPack', badge.perPack)) : null;
  const qty = iso(`${fmtQty(line.qty)} ${line.unit_label || ''}`.trim());
  const st = STATUS_STYLE[doneHere ? 'ready' : 'todo'];
  const set = (patch: Partial<LineDraft>) => onChange(line.index, patch);
  const border = expiryErr ? (TODO_ERRORS.has(expiryErr) ? TODO_BORDER : BAD_BORDER) : doneHere ? DONE_BORDER : TODO_BORDER;

  return (
    <section
      id={`line-${line.index}`}
      aria-label={`#${line.index} ${title}`}
      className={`rounded-3xl border-2 border-s-[6px] p-5 space-y-4 shadow-lg shadow-black/30 transition-shadow ${st.card} ${
        nudge ? 'ring-4 ring-warn' : ''
      }`}
    >
      <div className="flex flex-wrap items-center gap-2 text-sm font-bold text-ink-muted">
        <span className={`grid h-8 w-8 place-items-center rounded-full text-xs font-black ${st.badge}`} aria-hidden>
          {doneHere ? <Icon name="check" size={18} /> : line.index}
        </span>
        {line.code && (
          <span className="inline-flex items-center gap-1 rounded-full border border-line-strong bg-tile px-2.5 py-0.5">
            <Icon name="numbers" size={16} />
            <span className="font-mono text-ink-body" dir="ltr">
              {line.code}
            </span>
          </span>
        )}
        {line.qty_check && (
          <span className="inline-flex items-center gap-1 rounded-full border border-warn/50 bg-warn-weak px-2.5 py-0.5 text-xs font-extrabold text-warn-weak-ink">
            <Icon name="calculate" size={14} />
            {tr('receive.v2.qtyCheck')}
          </span>
        )}
      </div>

      <div>
        <h2 className="text-2xl font-black leading-tight break-words" dir="auto">
          {title}
        </h2>
        {subtitle && (
          <p className="mt-1 text-sm text-ink-muted break-words" dir="auto">
            {subtitle}
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-base">
        {packs && (
          <span className="inline-flex items-center gap-1.5 rounded-2xl border border-brand/30 bg-brand-weak px-3 py-1.5 font-extrabold">
            <Icon name="inventory_2" size={20} className="text-brand-weak-ink" />
            {packs}
          </span>
        )}
        <span className="inline-flex items-center gap-1.5 rounded-2xl border border-line-strong bg-tile px-3 py-1.5 font-extrabold">
          <Icon name={line.weighed ? 'scale' : 'tag'} size={20} className="text-brand-weak-ink" />
          {qty}
        </span>
        {perPack && <span className="text-sm font-bold text-ink-body">{perPack}</span>}
      </div>

      <div>
        <FieldLabel htmlFor={`e-${line.index}`} icon="event">
          {tr('receive.expiry')}
        </FieldLabel>
        <div className="flex flex-wrap gap-2">
          <DateEntry
            key={line.index}
            id={`e-${line.index}`}
            value={d.noExpiry ? '' : d.expiry}
            disabled={d.noExpiry}
            invalid={!!expiryErr && !TODO_ERRORS.has(expiryErr)}
            min={addDaysIso(today, 1)}
            max={maxExpiryIso(today)}
            placeholder={tr('receive.expiryPlaceholder')}
            calendarLabel={tr('receive.openCalendar')}
            onChange={(v) => set({ expiry: v, noExpiry: false })}
            className={DATE_ROW}
            inputClassName={`${INPUT} flex-1 font-mono text-2xl font-black disabled:opacity-35 ${border}`}
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
        {/* "Missing" is the job here, not an error: only a wrong date speaks. */}
        <FieldError text={expiryErr && expiryErr !== 'expiry_missing' ? tr(LINE_ERROR_KEY[expiryErr]) : null} />
      </div>
    </section>
  );
}
