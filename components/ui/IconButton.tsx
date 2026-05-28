import { forwardRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

/**
 * IconButton — square icon-only button. 44 / 48 / 56 px square, gloves-safe.
 *
 * Minimal direction: soft borders, no fills by default. Tone variants for the
 * rare case where the button needs to "shout" (e.g. emergency cancel).
 */

type Tone = "neutral" | "accent" | "success" | "danger";
type Size = "sm" | "md" | "lg";

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: Tone;
  size?: Size;
  /** Required — Lucide icons aren't textual. */
  "aria-label": string;
  children: ReactNode;
}

const toneClasses: Record<Tone, string> = {
  neutral:
    "bg-[var(--surface-1)] text-[var(--text-primary)] border border-[var(--border-strong)] active:bg-[var(--surface-2)]",
  accent:
    "bg-[var(--accent)] text-white border border-[var(--accent)] active:bg-[var(--accent-pressed)]",
  success:
    "bg-[var(--success)] text-white border border-[var(--success)] active:brightness-95",
  danger:
    "bg-[var(--danger)] text-white border border-[var(--danger)] active:brightness-95",
};

const sizeClasses: Record<Size, string> = {
  sm: "size-10",
  md: "size-12",
  lg: "size-14",
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { tone = "neutral", size = "md", className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      className={[
        "inline-flex items-center justify-center rounded-full",
        "transition-colors duration-100 select-none",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]",
        "disabled:opacity-40 disabled:cursor-not-allowed",
        toneClasses[tone],
        sizeClasses[size],
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    >
      {children}
    </button>
  );
});
