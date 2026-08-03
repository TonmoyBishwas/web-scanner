'use client';

interface ProgressHeaderProps {
  label: string;
  count: number;
  total: number;
  /** Trailing word after "N / M" (design: "קרטונים") */
  unitLabel: string;
  tone?: 'brand' | 'warn' | 'done';
}

// Design progress row: label + mono counter + 6px gradient bar on #0a0f14.
export function ProgressHeader({ label, count, total, unitLabel, tone = 'brand' }: ProgressHeaderProps) {
  const pct = total > 0 ? Math.min(100, (count / total) * 100) : 0;
  const barBg =
    tone === 'done'
      ? 'linear-gradient(90deg,#16a34a,#22c55e)'
      : tone === 'warn'
        ? 'linear-gradient(90deg,#b45309,#f59e0b)'
        : 'linear-gradient(90deg,#0e86c2,#13a4ec)';
  const countColor = tone === 'done' ? '#4ade80' : tone === 'warn' ? '#fbbf5c' : '#13a4ec';

  return (
    <div className="flex-none px-[14px] pt-2 pb-[10px] bg-header border-b border-[#101821]">
      <div className="flex justify-between items-center mb-[6px]">
        <span className="text-[9px] font-bold text-[#e8eef2] tracking-[.5px]">{label}</span>
        <span className="font-mono font-black text-[11px] text-ink-inverse" dir="ltr">
          <span style={{ color: countColor }}>{count}</span> / {total} <bdi className="font-sans">{unitLabel}</bdi>
        </span>
      </div>
      <div className="h-[6px] bg-[#12202a] rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-[width] duration-400"
          style={{ background: barBg, width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
