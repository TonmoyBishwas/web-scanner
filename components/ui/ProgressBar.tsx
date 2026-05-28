/**
 * ProgressBar — horizontal segmented bar. Replaces the round ProgressRing
 * (rings read consumer-app; a bar reads industrial).
 *
 * `segmented` mode draws N ticks so the worker can count progress at a glance
 * — useful for small pallet counts (≤ 30). Above that, fall back to a smooth
 * bar (`segmented={false}`).
 */

interface ProgressBarProps {
  current: number;
  target: number;
  tone?: "accent" | "warning" | "success";
  segmented?: boolean;
  className?: string;
}

const toneFill = {
  accent: "bg-[var(--accent)]",
  warning: "bg-[var(--warning)]",
  success: "bg-[var(--success)]",
} as const;

export function ProgressBar({
  current,
  target,
  tone = "accent",
  segmented,
  className,
}: ProgressBarProps) {
  const safeTarget = Math.max(1, target);
  const filled = Math.max(0, Math.min(current, safeTarget));
  const pct = (filled / safeTarget) * 100;

  // Segment only when target is small enough to perceive each tick.
  const showSegments = segmented ?? safeTarget <= 30;

  return (
    <div
      role="progressbar"
      aria-valuenow={filled}
      aria-valuemin={0}
      aria-valuemax={safeTarget}
      className={[
        "relative h-2 w-full overflow-hidden rounded-full bg-[var(--surface-3)]",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div
        className={["h-full transition-[width] duration-200", toneFill[tone]].join(" ")}
        style={{ width: `${pct}%` }}
      />
      {showSegments && safeTarget > 1 ? (
        <div className="pointer-events-none absolute inset-0 flex">
          {Array.from({ length: safeTarget - 1 }, (_, i) => (
            <span
              key={i}
              style={{ width: `${100 / safeTarget}%` }}
              className="block border-r border-[var(--surface-0)]/80 last:border-r-0"
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
