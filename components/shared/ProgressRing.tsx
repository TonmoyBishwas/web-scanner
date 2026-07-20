'use client';

interface ProgressRingProps {
  current: number;
  total: number;
  size?: number;
}

export function ProgressRing({ current, total, size = 52 }: ProgressRingProps) {
  const strokeWidth = 3.5;
  const radius = (size - strokeWidth * 2) / 2;
  const circumference = 2 * Math.PI * radius;
  const progress = total > 0 ? Math.min(current / total, 1) : 0;
  const dashoffset = circumference * (1 - progress);
  const isComplete = current >= total && total > 0;

  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg className="-rotate-90" width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {/* Background circle */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          className="text-line-strong"
          strokeWidth={strokeWidth}
        />
        {/* Progress circle */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          className={`transition-all duration-700 ease-out ${
            isComplete ? 'text-ok' : 'text-brand'
          }`}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={dashoffset}
        />
      </svg>
      {/* Center text */}
      <div className={`absolute inset-0 flex flex-col items-center justify-center ${isComplete ? 'animate-pulseGlow' : ''}`} dir="ltr">
        <span className={`text-xs font-mono font-bold leading-none ${isComplete ? 'text-ok' : 'text-ink'}`}>
          {current}
        </span>
        <span className="text-[9px] font-mono text-ink-muted leading-none">
          /{total}
        </span>
      </div>
    </div>
  );
}
