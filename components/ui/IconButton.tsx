import { forwardRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

/**
 * IconButton — square icon-only button. 44 px / 48 px square so it stays
 * gloves-safe. Used for camera-switch, settings, close, etc.
 */

type Tone = "neutral" | "accent" | "danger";
type Size = "sm" | "md" | "lg";

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: Tone;
  size?: Size;
  /** Required for screen readers — Lucide icons aren't textual. */
  "aria-label": string;
  children: ReactNode;
}

const toneClasses: Record<Tone, string> = {
  neutral:
    "bg-[var(--surface-2)] text-[var(--text-primary)] border border-[var(--border-default)] active:bg-[var(--surface-3)]",
  accent:
    "bg-[var(--accent)] text-black border border-[var(--accent)] active:bg-[var(--accent-pressed)]",
  danger:
    "bg-[var(--danger)] text-white border border-[var(--danger)] active:brightness-90",
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
        "inline-flex items-center justify-center rounded-lg",
        "transition-colors duration-100 select-none",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]",
        "disabled:opacity-50 disabled:cursor-not-allowed",
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
