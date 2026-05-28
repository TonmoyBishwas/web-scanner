import { forwardRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

/**
 * Button — single primitive for every clickable action.
 *
 * Minimal-clean direction (iOS-feel pills, light theme):
 *  - `primary`   = black pill, white text. ONE per screen.
 *  - `secondary` = white pill, black border, black text. Cancel / back / alt.
 *  - `ghost`     = transparent, black text. Inline "edit" inside list rows.
 *  - `success`   = green pill — use only for "this worked" affirmations
 *                  (e.g. confirm after a green check is needed; rare).
 *  - `danger`    = red pill, white text. Destructive only.
 *
 * Sizing — defaults to gloves-safe. `lg` = 56 px.
 */

type Variant = "primary" | "secondary" | "ghost" | "success" | "danger";
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
    "bg-[var(--accent)] text-white active:bg-[var(--accent-pressed)] " +
    "disabled:bg-[var(--surface-3)] disabled:text-[var(--text-tertiary)]",
  secondary:
    "bg-[var(--surface-1)] text-[var(--text-primary)] border border-[var(--border-strong)] " +
    "active:bg-[var(--surface-2)] " +
    "disabled:text-[var(--text-tertiary)] disabled:border-[var(--border-default)]",
  ghost:
    "bg-transparent text-[var(--text-primary)] active:bg-[var(--surface-2)] " +
    "disabled:text-[var(--text-tertiary)]",
  success:
    "bg-[var(--success)] text-white active:brightness-95 " +
    "disabled:bg-[var(--surface-3)] disabled:text-[var(--text-tertiary)]",
  danger:
    "bg-[var(--danger)] text-white active:brightness-95 " +
    "disabled:bg-[var(--surface-3)] disabled:text-[var(--text-tertiary)]",
};

const sizeClasses: Record<Size, string> = {
  lg: "h-14 text-[17px] px-7 gap-2.5",
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
        "inline-flex items-center justify-center rounded-full font-semibold",
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
      {children ? <span>{children}</span> : null}
      {!loading && trailingIcon}
    </button>
  );
});
