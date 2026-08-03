'use client';

import { useContext, useMemo, useState } from 'react';
import { MI } from './MI';
import { LanguageContext, useT } from '@/lib/i18n';

interface CalendarPickerProps {
  /** ISO date (YYYY-MM-DD) or empty */
  value: string;
  fieldTitle: string;
  onPick: (iso: string) => void;
  onClose: () => void;
}

type Tab = 'day' | 'month' | 'year';

function toParts(value: string): { y: number; m: number; d: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (m) return { y: +m[1], m: +m[2] - 1, d: +m[3] };
  const now = new Date();
  return { y: now.getFullYear(), m: now.getMonth(), d: now.getDate() };
}

const pad = (n: number) => String(n).padStart(2, '0');

// Design calendar picker: centered modal (z-81) with a day/month/year tab
// segmented control, localized grids, selected=brand, "היום" + "אישור" footer.
export function CalendarPicker({ value, fieldTitle, onPick, onClose }: CalendarPickerProps) {
  const tr = useT();
  const language = useContext(LanguageContext);
  const locale = language === 'Hebrew' ? 'he' : 'en';

  const init = toParts(value);
  const [tab, setTab] = useState<Tab>('day');
  const [y, setY] = useState(init.y);
  const [m, setM] = useState(init.m);
  const [d, setD] = useState(init.d);

  const monthNames = useMemo(
    () => Array.from({ length: 12 }, (_, i) =>
      new Date(2000, i, 1).toLocaleDateString(locale, { month: 'long' })),
    [locale],
  );
  const dowNames = useMemo(
    () => Array.from({ length: 7 }, (_, i) =>
      // 2023-01-01 was a Sunday; week starts Sunday (Israel)
      new Date(2023, 0, 1 + i).toLocaleDateString(locale, { weekday: 'narrow' })),
    [locale],
  );

  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const firstDow = new Date(y, m, 1).getDay(); // 0 = Sunday
  const todayParts = useMemo(() => {
    const now = new Date();
    return { y: now.getFullYear(), m: now.getMonth(), d: now.getDate() };
  }, []);
  const isToday = (day: number) => todayParts.y === y && todayParts.m === m && todayParts.d === day;

  const years = useMemo(
    () => Array.from({ length: 12 }, (_, i) => todayParts.y - 2 + i),
    [todayParts],
  );

  const commit = () => {
    const day = Math.min(d, new Date(y, m + 1, 0).getDate());
    onPick(`${y}-${pad(m + 1)}-${pad(day)}`);
  };

  const tabBtn = (t: Tab, label: string) => (
    <button
      key={t}
      onClick={() => setTab(t)}
      className="flex-1 py-[7px] rounded-[8px] text-[11px] font-extrabold transition-colors"
      style={tab === t
        ? { background: 'rgba(19,164,236,.18)', color: '#7cc9f2', border: '1px solid #13a4ec' }
        : { color: '#cbd5e1', border: '1px solid transparent' }}
    >
      {label}
    </button>
  );

  return (
    <div className="fixed inset-0 z-[81] bg-[rgba(5,8,10,.74)] backdrop-blur-[3px] flex items-center justify-center p-[22px]" onClick={onClose}>
      <div
        className="w-full max-w-[330px] bg-overlay-card border border-line rounded-[20px] p-4 shadow-[0_26px_64px_rgba(0,0,0,.72)] animate-doneRise"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <div>
            <div className="text-[9px] font-bold text-[#e8eef2] tracking-[.5px]">{fieldTitle}</div>
            <div className="text-[15px] font-extrabold text-ink-inverse mt-[2px]" dir="ltr">
              {`${pad(d)}/${pad(m + 1)}/${y}`}
            </div>
          </div>
          <button onClick={onClose} className="flex text-ink-inverse p-1" aria-label="close">
            <MI name="close" size={20} />
          </button>
        </div>

        <div className="flex gap-[5px] bg-header border border-line rounded-[9px] p-[3px] mb-3">
          {tabBtn('day', tr('terminal.day'))}
          {tabBtn('month', tr('terminal.month'))}
          {tabBtn('year', tr('terminal.year'))}
        </div>

        {tab === 'day' && (
          <div>
            <div className="grid grid-cols-7 gap-1 mb-1">
              {dowNames.map((n, i) => (
                <div key={i} className="text-center text-[9px] font-bold text-ink-muted py-1">{n}</div>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-1">
              {Array.from({ length: firstDow }, (_, i) => <span key={`b${i}`} />)}
              {Array.from({ length: daysInMonth }, (_, i) => {
                const day = i + 1;
                const sel = day === d;
                return (
                  <button
                    key={day}
                    onClick={() => setD(day)}
                    className="h-9 rounded-[9px] text-[12px] font-mono font-bold flex items-center justify-center"
                    style={sel
                      ? { background: '#13a4ec', color: '#04222f' }
                      : isToday(day)
                        ? { border: '1px solid #13a4ec', color: '#7cc9f2' }
                        : { color: '#e8eef2' }}
                  >
                    {day}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {tab === 'month' && (
          <div className="grid grid-cols-3 gap-2">
            {monthNames.map((name, i) => (
              <button
                key={i}
                onClick={() => { setM(i); setTab('day'); }}
                className="h-10 rounded-[10px] text-[12px] font-bold"
                style={i === m
                  ? { background: '#13a4ec', color: '#04222f' }
                  : { background: '#101821', border: '1px solid #1e2a35', color: '#e8eef2' }}
              >
                {name}
              </button>
            ))}
          </div>
        )}

        {tab === 'year' && (
          <div className="grid grid-cols-3 gap-2">
            {years.map(year => (
              <button
                key={year}
                onClick={() => { setY(year); setTab('month'); }}
                className="h-10 rounded-[10px] text-[12px] font-mono font-bold"
                style={year === y
                  ? { background: '#13a4ec', color: '#04222f' }
                  : { background: '#101821', border: '1px solid #1e2a35', color: '#e8eef2' }}
              >
                {year}
              </button>
            ))}
          </div>
        )}

        <div className="flex items-center justify-between mt-4">
          <button
            onClick={() => {
              const now = new Date();
              setY(now.getFullYear()); setM(now.getMonth()); setD(now.getDate()); setTab('day');
            }}
            className="text-[12px] font-extrabold text-[#7cc9f2] py-2"
          >
            {tr('terminal.today')}
          </button>
          <button
            onClick={commit}
            className="bg-brand text-ink-inverse text-[13px] font-black rounded-[11px] px-6 py-[10px]"
          >
            {tr('terminal.ok')}
          </button>
        </div>
      </div>
    </div>
  );
}
