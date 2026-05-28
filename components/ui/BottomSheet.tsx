"use client";

import { useEffect } from "react";
import type { ReactNode } from "react";
import { X } from "lucide-react";

import { IconButton } from "./IconButton";

/**
 * BottomSheet — one consistent modal pattern across the app.
 *
 * Minimal-clean: white surface, big rounded top corners (24 px), soft top
 * shadow on the sheet itself, no aggressive accent stripes by default.
 *
 * - Backdrop click closes UNLESS `dismissable={false}`.
 * - Escape key also closes when dismissable.
 * - Body scroll locked while open.
 * - Footer gets safe-area-bottom inset.
 */

interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  /**
   * Optional thin accent stripe along the top — telegraphs mode without
   * adding extra chrome. `none` (default) is the calmest.
   */
  accent?: "none" | "warning" | "danger";
  dismissable?: boolean;
  children: ReactNode;
  /** Sticky bottom actions (gets safe-area padding). */
  footer?: ReactNode;
}

const accentStripe = {
  none: "",
  warning: "bg-[var(--warning)]",
  danger: "bg-[var(--danger)]",
} as const;

export function BottomSheet({
  open,
  onClose,
  title,
  accent = "none",
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
      {/* Backdrop — soft, not jet-black */}
      <div
        className="absolute inset-0 bg-black/40"
        onClick={dismissable ? onClose : undefined}
      />

      {/* Sheet */}
      <div
        className="relative w-full max-w-[640px] bg-[var(--surface-1)] rounded-t-[24px] shadow-[0_-12px_40px_rgba(0,0,0,0.12)] flex flex-col max-h-[85vh] animate-slideInUp"
        onClick={(e) => e.stopPropagation()}
      >
        {accent !== "none" ? (
          <div className={`h-[3px] w-24 rounded-full ${accentStripe[accent]} mx-auto mt-3`} />
        ) : (
          <div className="h-1 w-10 rounded-full bg-[var(--border-strong)] mx-auto mt-3" />
        )}

        {/* Header */}
        {title ? (
          <div className="flex items-center justify-between px-5 pt-4 pb-2">
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

        {/* Footer */}
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
