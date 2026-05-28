import { Check, AlertTriangle, Loader2, X } from "lucide-react";
import type { ReactNode } from "react";

/**
 * StatusBadge — Lucide icon + (optional) Hebrew label, soft tinted pill.
 *
 * Replaces ✅ / ⚠️ / ⏳ / ❌ emojis. In the minimal-clean direction we lean on
 * icon + color; a Hebrew label is optional (and short — תקין / בבדיקה / כפול).
 *
 * `tone`:
 *  - success = scanned & OCR verified           (green)
 *  - pending = OCR in flight                    (neutral gray)
 *  - warning = needs_review                     (amber)
 *  - danger  = duplicate / not found / error    (red)
 *  - neutral = informational chip (e.g. "Mix")  (gray)
 */

type Tone = "success" | "pending" | "warning" | "danger" | "neutral";
type Size = "sm" | "md";

interface StatusBadgeProps {
  tone: Tone;
  size?: Size;
  /** Override the auto-picked Lucide icon. Pass null to hide. */
  icon?: ReactNode | null;
  children?: ReactNode;
  className?: string;
}

const toneClasses: Record<Tone, string> = {
  success: "text-[var(--success)] bg-[var(--success-soft)]",
  pending: "text-[var(--text-secondary)] bg-[var(--surface-2)]",
  warning: "text-[var(--warning)] bg-[var(--warning-soft)]",
  danger: "text-[var(--danger)] bg-[var(--danger-soft)]",
  neutral: "text-[var(--text-secondary)] bg-[var(--surface-2)]",
};

const sizeClasses: Record<Size, string> = {
  sm: "h-7 px-2.5 text-[12px] gap-1.5",
  md: "h-8 px-3 text-[13px] gap-1.5",
};

const iconSize: Record<Size, number> = { sm: 14, md: 16 };

function defaultIcon(tone: Tone, size: Size): ReactNode {
  const s = iconSize[size];
  switch (tone) {
    case "success":
      return <Check size={s} strokeWidth={2.5} />;
    case "warning":
      return <AlertTriangle size={s} strokeWidth={2.25} />;
    case "danger":
      return <X size={s} strokeWidth={2.5} />;
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
        "inline-flex items-center rounded-full font-medium",
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
