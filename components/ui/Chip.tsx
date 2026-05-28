import { forwardRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

/**
 * Chip — small pill button used as a hidden-content trigger.
 *
 * Use case: the "scanned list" peek chip floating over the scanner. Tapping
 * it opens the BottomSheet with the full list. Shows a number + icon by
 * default — minimal direction means we don't show the list on the main
 * screen, just a count.
 *
 * Variants:
 *  - `default`  = white pill, hairline border, dark text.
 *  - `subtle`   = transparent surface-2, no border. For inline chips.
 *  - `floating` = white pill with soft shadow, intended to float over the
 *                 camera viewport.
 *
 * `tone` adds a left dot in the chosen color — replaces the badge for cases
 * where you want to show state inline without the full StatusBadge weight.
 */

type Variant = "default" | "subtle" | "floating";
type Tone = "default" | "success" | "warning" | "danger";

interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  tone?: Tone;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
  children?: ReactNode;
}

const variantClasses: Record<Variant, string> = {
  default:
    "bg-[var(--surface-1)] text-[var(--text-primary)] border border-[var(--border-default)] active:bg-[var(--surface-2)]",
  subtle:
    "bg-[var(--surface-2)] text-[var(--text-primary)] active:bg-[var(--surface-3)]",
  floating:
    "bg-[var(--surface-1)] text-[var(--text-primary)] border border-[var(--border-default)] shadow-[0_4px_16px_rgba(0,0,0,0.10)] active:bg-[var(--surface-2)]",
};

const toneDot: Record<Tone, string | null> = {
  default: null,
  success: "bg-[var(--success)]",
  warning: "bg-[var(--warning)]",
  danger: "bg-[var(--danger)]",
};

export const Chip = forwardRef<HTMLButtonElement, ChipProps>(function Chip(
  {
    variant = "default",
    tone = "default",
    leadingIcon,
    trailingIcon,
    children,
    className,
    ...rest
  },
  ref,
) {
  const dot = toneDot[tone];
  return (
    <button
      ref={ref}
      className={[
        "inline-flex items-center gap-2 h-10 px-3.5 rounded-full text-[14px] font-medium",
        "transition-colors duration-100 select-none",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]",
        "disabled:opacity-40 disabled:cursor-not-allowed",
        variantClasses[variant],
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    >
      {dot ? <span className={`size-2 rounded-full ${dot}`} /> : null}
      {leadingIcon}
      {children ? <span>{children}</span> : null}
      {trailingIcon}
    </button>
  );
});
