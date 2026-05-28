"use client";

import type { ReactNode } from "react";

/**
 * ScannerOverlay — chrome over the SmartScanner <video>.
 *
 * Minimal direction:
 *  - Green (success) corner brackets — universally "go" signal.
 *  - Soft scan-line.
 *  - Slot for top controls (single icon button — settings/back; pass `topActions`).
 *  - Slot for bottom controls (single Capture-anyway icon; pass `bottomActions`).
 *  - No textual hints (worker reads Hebrew but minimal direction = no text here).
 *
 * `tone`:
 *  - `success` (default green brackets — universal "go")
 *  - `warning` (amber — loose-phase)
 *
 * `flash`:
 *  - `success` → green flash on confirmed scan
 *  - `danger`  → red flash on duplicate
 */

interface ScannerOverlayProps {
  armed?: boolean;
  tone?: "success" | "warning";
  flash?: "success" | "danger";
  topActions?: ReactNode;
  bottomActions?: ReactNode;
  /** Optional small Hebrew hint floating below the framing box. */
  hint?: ReactNode;
}

const toneVarsByTone = {
  success: { "--ovl": "var(--success)" } as const,
  warning: { "--ovl": "var(--warning)" } as const,
};

const flashClass = {
  success: "bg-[var(--success)]/30",
  danger: "bg-[var(--danger)]/35",
} as const;

export function ScannerOverlay({
  armed,
  tone = "success",
  flash,
  topActions,
  bottomActions,
  hint,
}: ScannerOverlayProps) {
  return (
    <div
      className="pointer-events-none absolute inset-0 flex flex-col"
      style={toneVarsByTone[tone] as React.CSSProperties}
    >
      {/* Top action rail */}
      {topActions ? (
        <div
          className="pointer-events-auto flex items-center justify-between gap-2 p-3"
          style={{ paddingTop: "calc(0.75rem + env(safe-area-inset-top, 0px))" }}
        >
          {topActions}
        </div>
      ) : null}

      {/* Scan zone */}
      <div className="relative flex-1 flex items-center justify-center">
        <div className="relative w-[78%] max-w-[420px] aspect-[5/4]">
          <CornerBracket position="tl" />
          <CornerBracket position="tr" />
          <CornerBracket position="bl" />
          <CornerBracket position="br" />

          {armed ? (
            <div
              className="absolute inset-x-3 top-0 h-[2px] bg-[var(--ovl)] animate-scanLine rounded-full"
              style={{
                boxShadow: "0 0 12px var(--ovl), 0 0 24px var(--ovl)",
              }}
            />
          ) : null}

          {hint ? (
            <div className="absolute inset-x-0 -bottom-9 text-center text-[13px] tracking-wide text-white/85 drop-shadow">
              {hint}
            </div>
          ) : null}
        </div>

        {flash ? (
          <div
            className={[
              "absolute inset-0 pointer-events-none animate-cameraFlash",
              flashClass[flash],
            ].join(" ")}
          />
        ) : null}
      </div>

      {/* Bottom action rail */}
      {bottomActions ? (
        <div
          className="pointer-events-auto flex items-center justify-center gap-3 p-3"
          style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom, 0px))" }}
        >
          {bottomActions}
        </div>
      ) : null}
    </div>
  );
}

function CornerBracket({ position }: { position: "tl" | "tr" | "bl" | "br" }) {
  const base = "absolute size-8 border-[var(--ovl)]";
  const pos = {
    tl: "top-0 left-0 border-t-[3px] border-l-[3px] rounded-tl-md",
    tr: "top-0 right-0 border-t-[3px] border-r-[3px] rounded-tr-md",
    bl: "bottom-0 left-0 border-b-[3px] border-l-[3px] rounded-bl-md",
    br: "bottom-0 right-0 border-b-[3px] border-r-[3px] rounded-br-md",
  }[position];
  return <div className={`${base} ${pos}`} />;
}
