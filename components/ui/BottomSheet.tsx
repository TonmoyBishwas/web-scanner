"use client";

import { useEffect } from "react";
import type { ReactNode } from "react";
import { X } from "lucide-react";

import { IconButton } from "./IconButton";

/**
 * BottomSheet — one consistent modal pattern across the app.
 *
 * - Slides up from the bottom on mobile; full-screen-ish height cap (85vh).
 * - Backdrop click closes UNLESS `dismissable={false}` (use for in-flight
 *   confirmations the user shouldn't be able to drop accidentally).
 * - Escape key also closes when dismissable.
 * - Body scroll is locked while open.
 * - Bottom action area gets safe-area-bottom inset so the CTA isn't under the
 *   gesture bar.
 */

interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  /**
   * The hi-vis stripe along the top of the sheet. Use to telegraph mode:
   * - `accent` = default
   * - `warning` = loose-box phase / needs-review prompts
   * - `danger` = irreversible / destructive
   */
  accent?: "accent" | "warning" | "danger" | "none";
  dismissable?: boolean;
  children: ReactNode;
  /** Render here for sticky bottom buttons (gets safe-area padding). */
  footer?: ReactNode;
}

const accentStripe = {
  accent: "bg-[var(--accent)]",
  warning: "bg-[var(--warning)]",
  danger: "bg-[var(--danger)]",
  none: "",
} as const;

export function BottomSheet({
  open,
  onClose,
  title,
  accent = "accent",
  dismissable = true,
  children,
  footer,
}: BottomSheetProps) {
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dismissable) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, dismissable, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center animate-fadeIn"
      role="dialog"
      aria-modal="true"
      aria-labelledby={title ? "bottomsheet-title" : undefined}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={dismissable ? onClose : undefined}
      />

      {/* Sheet */}
      <div
        className="relative w-full max-w-[640px] bg-[var(--surface-2)] border-t border-[var(--border-strong)] rounded-t-xl flex flex-col max-h-[85vh] animate-slideInUp"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Accent stripe — 3 px line that telegraphs mode */}
        {accent !== "none" ? (
          <div className={`h-[3px] w-full ${accentStripe[accent]} rounded-t-xl`} />
        ) : null}

        {/* Drag handle */}
        <div className="flex justify-center pt-2">
          <div className="h-1 w-10 rounded-full bg-[var(--border-strong)]" />
        </div>

        {/* Header */}
        {title ? (
          <div className="flex items-center justify-between px-5 pt-3 pb-2">
            <h2
              id="bottomsheet-title"
              className="text-[20px] leading-[26px] font-semibold text-[var(--text-primary)]"
            >
              {title}
            </h2>
            {dismissable ? (
              <IconButton size="sm" tone="neutral" aria-label="Close" onClick={onClose}>
                <X size={18} />
              </IconButton>
            ) : null}
          </div>
        ) : null}

        {/* Body */}
        <div className="px-5 py-3 overflow-y-auto flex-1">{children}</div>

        {/* Footer (sticky, safe-area-aware) */}
        {footer ? (
          <div
            className="px-5 pt-3 border-t border-[var(--border-default)]"
            style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom, 0px))" }}
          >
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}
