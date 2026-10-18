'use client';

import { useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { MI } from './MI';
import { LanguageContext, useT } from '@/lib/i18n';
import type { Language } from '@/types';
import type { GroupableBox } from '@/lib/group-key';
import {
  buildItemChips,
  distinctItemCount,
  effectiveItemFilter,
  matchesItemFilter,
  type ItemChip,
} from '@/lib/by-item-filter';

/**
 * State for the scan list's "By item" view filter. Derived from the scan list
 * on every render — no storage of its own — so the counts follow each scan and
 * a filter whose cartons are all deleted (or a new pallet) clears itself.
 * View only: callers filter what they RENDER with `matches`, never what they
 * book, count, delete or send.
 */
export function useItemFilter(
  boxes: GroupableBox[],
  language: Language,
  mergeMap?: Map<string, string>,
) {
  const lang = language === 'Hebrew' ? 'he' : 'en';
  const chips = useMemo(() => buildItemChips(boxes, lang, mergeMap), [boxes, lang, mergeMap]);
  const [selected, setSelected] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const active = effectiveItemFilter(selected, chips);
  // Adjusting state while rendering (React's documented alternative to an
  // effect): the chosen item has no cartons left, or the list emptied.
  if (selected !== null && active === null) setSelected(null);
  if (open && chips.length === 0) setOpen(false);

  const select = useCallback((key: string | null) => {
    setSelected(key);
    setOpen(false);
  }, []);
  const matches = useCallback(
    (box: GroupableBox) => matchesItemFilter(box, active, mergeMap),
    [active, mergeMap],
  );

  return { chips, active, open, setOpen, select, matches, total: boxes.length };
}

export type ItemFilterState = ReturnType<typeof useItemFilter>;

// The scanner's filter-chip look (Documents / Pallets browsers): rounded-full,
// 11px extrabold, tile fill on a hairline; selected = brand outline + tint.
const PILL = 'flex items-center rounded-full text-[11px] font-extrabold border whitespace-nowrap';
const CHIP = `${PILL} flex-none gap-[6px] px-3 py-[6px]`;
const CHIP_IDLE = 'border-line bg-tile text-ink';
const CHIP_ON = 'border-brand bg-brand-weak text-brand-weak-ink';
const BADGE = 'min-w-[18px] h-[18px] px-[5px] rounded-full flex items-center justify-center font-mono text-[10px] font-black';

function CountBadge({ n, on }: { n: number; on: boolean }) {
  return (
    <span className={`${BADGE} ${on ? 'bg-brand text-ink-inverse' : 'bg-tool-tile text-ink'}`} dir="ltr">
      {n}
    </span>
  );
}

interface ByItemBarProps {
  filter: ItemFilterState;
  /** The overall RECEIVED counter — always the whole pallet, never the filter. */
  received: number;
  expected: number;
  tone?: 'brand' | 'warn' | 'done';
}

/**
 * The row above the scan list: "By item" (or the chosen item's pill) and the
 * RECEIVED counter; tapping it opens a one-line, side-scrolling strip of item
 * chips in the counter's place.
 */
export function ByItemBar({ filter, received, expected, tone = 'brand' }: ByItemBarProps) {
  const tr = useT();
  const { chips, active, open, setOpen, select, total } = filter;
  const activeChip = active ? chips.find((c) => c.key === active) : undefined;
  const label = (c: ItemChip) => c.name ?? tr('terminal.byItemUnidentified');
  const color = tone === 'done' ? '#4ade80' : tone === 'warn' ? '#fbbf5c' : '#13a4ec';

  return (
    <div className="sticky top-0 z-10 -mx-4 px-4 py-[6px] bg-raised flex items-center gap-2 min-h-[44px]">
      {activeChip && !open ? (
        // The chosen item: tap the name to switch item, ✕ to show everything.
        <span className={`${PILL} ${CHIP_ON} min-w-0 max-w-[70%]`}>
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-expanded={false}
            className="flex items-center gap-[6px] min-w-0 ps-3 py-[6px]"
          >
            <MI name="filter_list" size={14} />
            <span className="truncate">{label(activeChip)}</span>
            <CountBadge n={activeChip.count} on />
          </button>
          <button
            type="button"
            onClick={() => select(null)}
            aria-label={tr('terminal.byItemClear')}
            className="flex-none flex items-center pe-[10px] ps-1 py-[6px]"
          >
            <MI name="close" size={14} />
          </button>
        </span>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className={`${CHIP} ${open ? 'border-brand text-brand-weak-ink bg-tile' : CHIP_IDLE}`}
        >
          <MI name="filter_list" size={14} />
          {tr('terminal.byItem')}
          <CountBadge n={distinctItemCount(chips)} on={false} />
        </button>
      )}

      {open ? (
        <ChipStrip>
          <button type="button" onClick={() => select(null)} className={`${CHIP} ${active ? CHIP_IDLE : CHIP_ON}`}>
            {tr('terminal.byItemAll')}
            <CountBadge n={total} on={!active} />
          </button>
          {chips.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => select(c.key)}
              className={`${CHIP} ${c.key === active ? CHIP_ON : CHIP_IDLE}`}
            >
              <span className="max-w-[180px] truncate">{label(c)}</span>
              <CountBadge n={c.count} on={c.key === active} />
            </button>
          ))}
        </ChipStrip>
      ) : (
        <span className="ms-auto flex-none flex items-baseline gap-[6px] leading-none">
          <span className="text-[9px] font-bold text-ink-muted tracking-[.6px] uppercase whitespace-nowrap">
            {tr('terminal.byItemReceived')}
          </span>
          <span className="font-mono font-black text-[15px] text-ink-inverse" dir="ltr">
            <span style={{ color }}>{received}</span>
            {expected > 0 && <>/{expected}</>}
          </span>
        </span>
      )}
    </div>
  );
}

/** One line of chips that scrolls sideways; ‹ › appear only while there is
 *  more to see in that direction. Works in RTL (scrollLeft runs ≤ 0 there). */
function ChipStrip({ children }: { children: ReactNode }) {
  const tr = useT();
  const rtl = useContext(LanguageContext) === 'Hebrew';
  const ref = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState({ back: false, fwd: false });

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const pos = Math.abs(el.scrollLeft);
    const max = el.scrollWidth - el.clientWidth;
    const back = pos > 1;
    const fwd = max > 1 && pos < max - 1;
    setMore((m) => (m.back === back && m.fwd === fwd ? m : { back, fwd }));
  }, []);

  useEffect(() => {
    measure();
    const el = ref.current;
    if (!el) return;
    el.addEventListener('scroll', measure, { passive: true });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    for (const child of Array.from(el.children)) ro?.observe(child);
    return () => {
      el.removeEventListener('scroll', measure);
      ro?.disconnect();
    };
  });

  const step = (dir: 1 | -1) => {
    const el = ref.current;
    if (!el) return;
    const rtl = getComputedStyle(el).direction === 'rtl';
    const amount = Math.max(80, el.clientWidth * 0.7) * dir;
    el.scrollBy({ left: rtl ? -amount : amount, behavior: 'smooth' });
  };

  const arrow = (dir: 1 | -1, show: boolean) =>
    show && (
      <button
        type="button"
        onClick={() => step(dir)}
        aria-label={tr(dir === 1 ? 'terminal.byItemScrollMore' : 'terminal.byItemScrollBack')}
        className="flex-none w-8 h-8 rounded-full border border-line bg-tile text-ink flex items-center justify-center"
      >
        {/* Icon ligatures don't mirror: in RTL "more" lies to the left. */}
        <MI name={(dir === 1) !== rtl ? 'chevron_right' : 'chevron_left'} size={20} />
      </button>
    );

  return (
    <div className="flex-1 min-w-0 flex items-center gap-[6px]">
      {arrow(-1, more.back)}
      <div ref={ref} className="flex-1 min-w-0 flex items-center gap-[7px] overflow-x-auto no-scrollbar">
        {children}
      </div>
      {arrow(1, more.fwd)}
    </div>
  );
}
