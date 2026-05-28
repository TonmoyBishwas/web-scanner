import { forwardRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

/**
 * Button — single primitive for every clickable action across the scanner.
 *
 * - `primary`  = the hi-vis accent (orange). Use ONE per screen for the main action.
 * - `secondary`= outlined neutral. Cancel, back, alt actions.
 * - `ghost`    = transparent. Inline links / "edit" buttons inside list rows.
 * - `danger`   = red. Destructive only (delete-scan, force-cancel pallet).
 *
 * Sizing:
 * - `lg` = h-14 (56 px). Default for any sticky bottom CTA — gloves-safe.
 * - `md` = h-12 (48 px). For inline / per-row actions.
 * - `sm` = h-10 (40 px). Use sparingly — never the only action on a screen.
 */

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "lg" | "md" | "sm";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  fullWidth?: boolean;
  loading?: boolean;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
}

const variantClasses: Record<Variant, string> = {
  primary:
    "bg-[var(--accent)] text-black active:bg-[var(--accent-pressed)] disabled:bg-[var(--surface-3)] disabled:text-[var(--text-tertiary)]",
  secondary:
    "bg-transparent text-[var(--text-primary)] border border-[var(--border-strong)] active:bg-[var(--surface-2)] disabled:text-[var(--text-tertiary)] disabled:border-[var(--border-default)]",
  ghost:
    "bg-transparent text-[var(--text-primary)] active:bg-[var(--surface-2)] disabled:text-[var(--text-tertiary)]",
  danger:
    "bg-[var(--danger)] text-white active:brightness-90 disabled:bg-[var(--surface-3)] disabled:text-[var(--text-tertiary)]",
};

const sizeClasses: Record<Size, string> = {
  lg: "h-14 text-[18px] px-6 gap-2.5",
  md: "h-12 text-[16px] px-5 gap-2",
  sm: "h-10 text-[14px] px-4 gap-2",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "primary",
    size = "lg",
    fullWidth,
    loading,
    leadingIcon,
    trailingIcon,
    children,
    className,
    disabled,
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={[
        "inline-flex items-center justify-center rounded-lg font-semibold tracking-[-0.01em]",
        "transition-[background-color,color] duration-100 select-none",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]",
        "disabled:cursor-not-allowed",
        variantClasses[variant],
        sizeClasses[size],
        fullWidth ? "w-full" : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    >
      {loading ? (
        <span className="inline-block size-4 rounded-full border-2 border-current border-t-transparent animate-spin" />
      ) : (
        leadingIcon
      )}
      <span>{children}</span>
      {!loading && trailingIcon}
    </button>
  );
});
