'use client';

interface ProgressHeaderProps {
  /**
   * Caption above the bar. Omit it to render the bar on its own — pallet-verify
   * carries both counters in the header itself, and repeating them here read as
   * clutter to the workers rather than as reassurance.
   */
  label?: string;
  count: number;
  total: number;
  /** Trailing word after "N / M" (design: "קרטונים") */
  unitLabel?: string;
  tone?: 'brand' | 'warn' | 'done';
}

// Design progress row: label + mono counter + 6px gradient bar on #0a0f14.
export function ProgressHeader({ label, count, total, unitLabel, tone = 'brand' }: ProgressHeaderProps) {
  // total <= 0 = declared count not known yet: show a soft indeterminate fill
  // that grows with each scan instead of a misleading "N / 0".
  const pct = total > 0 ? Math.min(100, (count / total) * 100) : Math.min(60, count * 8);
  const barBg =
    tone === 'done'
      ? 'linear-gradient(90deg,#16a34a,#22c55e)'
      : tone === 'warn'
        ? 'linear-gradient(90deg,#b45309,#f59e0b)'
        : 'linear-gradient(90deg,#0e86c2,#13a4ec)';
  const countColor = tone === 'done' ? '#4ade80' : tone === 'warn' ? '#fbbf5c' : '#13a4ec';

  return (
    <div className="flex-none px-[14px] pt-2 pb-[10px] bg-header border-b border-[#101821]">
      {label && (
        <div className="flex justify-between items-center mb-[6px]">
          <span className="text-[9px] font-bold text-[#e8eef2] tracking-[.5px]">{label}</span>
          <span className="font-mono font-black text-[11px] text-ink-inverse" dir="ltr">
            <span style={{ color: countColor }}>{count}</span>
            {total > 0 && <> / {total}</>} <bdi className="font-sans">{unitLabel}</bdi>
          </span>
        </div>
      )}
      <div className="h-[6px] bg-[#12202a] rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-[width] duration-400"
          style={{ background: barBg, width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
