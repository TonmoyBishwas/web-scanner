type Tone = 'brand' | 'info' | 'inverse';

const toneClass: Record<Tone, string> = {
  brand: 'border-brand border-t-transparent',
  info: 'border-info border-t-transparent',
  inverse: 'border-cam-ink border-t-transparent',
};

/**
 * Spinner — the repeated "working" indicator. `inverse` tone is for use over
 * camera glass / dark scrims; brand/info for light screens.
 */
export function Spinner({
  size = 24,
  tone = 'brand',
  className = '',
}: {
  size?: number;
  tone?: Tone;
  className?: string;
}) {
  return (
    <span
      role="status"
      aria-label="Loading"
      style={{ width: size, height: size, borderWidth: Math.max(2, Math.round(size / 10)) }}
      className={`inline-block animate-spin rounded-full ${toneClass[tone]} ${className}`}
    />
  );
}
