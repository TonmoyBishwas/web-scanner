import type { LucideIcon } from 'lucide-react';

type Tone = 'ghost' | 'brand' | 'danger';

const toneClass: Record<Tone, string> = {
  ghost: 'text-ink-muted hover:bg-hover active:bg-sunken',
  brand: 'bg-brand text-ink-inverse hover:bg-brand-hover active:bg-brand-active',
  danger: 'text-danger hover:bg-danger-weak active:bg-danger-weak',
};

/**
 * IconButton — a square 48px touch target around a lucide icon. `label` is the
 * required aria-label (icon-only buttons must stay accessible). Replaces the
 * bare `<button className="p-2 …">` icon triggers across the app.
 */
export function IconButton({
  icon: Icon,
  label,
  onClick,
  tone = 'ghost',
  size = 22,
  disabled,
  className = '',
  type = 'button',
}: {
  icon: LucideIcon;
  label: string;
  onClick?: () => void;
  tone?: Tone;
  size?: number;
  disabled?: boolean;
  className?: string;
  type?: 'button' | 'submit';
}) {
  return (
    <button
      type={type}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className={`tap-target inline-flex items-center justify-center rounded-xl transition-colors disabled:opacity-40 ${toneClass[tone]} ${className}`}
    >
      <Icon size={size} strokeWidth={2.25} />
    </button>
  );
}
