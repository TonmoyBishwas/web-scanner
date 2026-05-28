import { Check, AlertTriangle, Loader2, X } from "lucide-react";
import type { ReactNode } from "react";

/**
 * StatusBadge — Lucide icon + label. Replaces ✅ / ⚠️ / ⏳ / ❌ emoji
 * sprinkled across ScannedList / IssuedBoxList / etc.
 *
 * `tone`:
 * - success = scanned & OCR verified
 * - pending = OCR in flight
 * - warning = needs_review (OCR partial, missing digits, user must check)
 * - danger  = duplicate / error / not found
 * - neutral = informational chip (e.g. "MIX", "LOOSE")
 */

type Tone = "success" | "pending" | "warning" | "danger" | "neutral";
type Size = "sm" | "md";

interface StatusBadgeProps {
  tone: Tone;
  size?: Size;
  /** Override the auto-picked Lucide icon. Pass null to hide the icon. */
  icon?: ReactNode | null;
  children?: ReactNode;
  className?: string;
}

const toneClasses: Record<Tone, string> = {
  success: "text-[var(--success)] bg-[var(--success-soft)] border-[var(--success)]/40",
  pending: "text-[var(--text-secondary)] bg-[var(--surface-3)] border-[var(--border-strong)]",
  warning: "text-[var(--warning)] bg-[var(--warning-soft)] border-[var(--warning)]/40",
  danger: "text-[var(--danger)] bg-[var(--danger-soft)] border-[var(--danger)]/40",
  neutral: "text-[var(--text-secondary)] bg-[var(--surface-2)] border-[var(--border-default)]",
};

const sizeClasses: Record<Size, string> = {
  sm: "h-6 px-2 text-[11px] gap-1",
  md: "h-7 px-2.5 text-[12px] gap-1.5",
};

const iconSize: Record<Size, number> = { sm: 12, md: 14 };

function defaultIcon(tone: Tone, size: Size): ReactNode {
  const s = iconSize[size];
  switch (tone) {
    case "success":
      return <Check size={s} strokeWidth={3} />;
    case "warning":
      return <AlertTriangle size={s} strokeWidth={2.5} />;
    case "danger":
      return <X size={s} strokeWidth={3} />;
    case "pending":
      return <Loader2 size={s} className="animate-spin" />;
    default:
      return null;
  }
}

export function StatusBadge({
  tone,
  size = "sm",
  icon,
  children,
  className,
}: StatusBadgeProps) {
  const resolvedIcon = icon === undefined ? defaultIcon(tone, size) : icon;
  return (
    <span
      className={[
        "inline-flex items-center rounded-md border font-semibold tracking-[0.02em] uppercase",
        toneClasses[tone],
        sizeClasses[size],
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {resolvedIcon}
      {children ? <span>{children}</span> : null}
    </span>
  );
}
