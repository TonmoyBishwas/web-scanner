"use client";

import type { ReactNode } from "react";

/**
 * ScannerOverlay — chrome that sits over the SmartScanner <video>.
 *
 * Visual elements:
 *  - 4 corner brackets (orange accent) framing the scan zone
 *  - Animated horizontal scan line sweeping top↔bottom
 *  - Slot for top-right controls (settings, camera-switch — pass as `topActions`)
 *  - Slot for bottom controls (capture-anyway button — pass as `bottomActions`)
 *
 * The SmartScanner's logic — decode, sharpest-frame capture, cooldown timer,
 * `onManualCapture` — is untouched. This overlay is pure presentation.
 *
 * Props:
 *  - `armed` = true when the camera is live + waiting for a decode. Drives the
 *    scan-line animation. Set false during cooldown / processing.
 *  - `tone` = `accent` (default orange) or `warning` (loose-phase amber).
 *  - `flash` = `success` | `danger` | undefined — triggers a one-shot color
 *    flash overlay (caller is responsible for clearing).
 */

interface ScannerOverlayProps {
  armed?: boolean;
  tone?: "accent" | "warning";
  flash?: "success" | "danger";
  topActions?: ReactNode;
  bottomActions?: ReactNode;
  /** Optional centered hint text (e.g. "Aim at barcode"). */
  hint?: ReactNode;
}

const toneVarsByTone = {
  accent: { "--ovl": "var(--accent)" } as const,
  warning: { "--ovl": "var(--warning)" } as const,
};

const flashClass = {
  success: "bg-[var(--success)]/30",
  danger: "bg-[var(--danger)]/40",
} as const;

export function ScannerOverlay({
  armed,
  tone = "accent",
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
      {/* Top action rail — clickable */}
      {topActions ? (
        <div
          className="pointer-events-auto flex items-center justify-end gap-2 p-3"
          style={{ paddingTop: "calc(0.75rem + env(safe-area-inset-top, 0px))" }}
        >
          {topActions}
        </div>
      ) : null}

      {/* Scan zone */}
      <div className="relative flex-1 flex items-center justify-center">
        {/* Centered framing box: 78% width, 4:3 aspect-ish for receipt-style stickers */}
        <div className="relative w-[78%] max-w-[420px] aspect-[5/4]">
          {/* Corner brackets */}
          <CornerBracket position="tl" />
          <CornerBracket position="tr" />
          <CornerBracket position="bl" />
          <CornerBracket position="br" />

          {/* Scan-line — only animates when armed */}
          {armed ? (
            <div
              className="absolute inset-x-2 top-0 h-[2px] bg-[var(--ovl)] animate-scanLine"
              style={{
                boxShadow: "0 0 12px var(--ovl), 0 0 32px var(--ovl)",
              }}
            />
          ) : null}

          {/* Hint */}
          {hint ? (
            <div className="absolute inset-x-0 -bottom-9 text-center text-[13px] tracking-wide text-[var(--text-secondary)]">
              {hint}
            </div>
          ) : null}
        </div>

        {/* Flash layer — full viewport */}
        {flash ? (
          <div
            className={[
              "absolute inset-0 pointer-events-none animate-cameraFlash",
              flashClass[flash],
            ].join(" ")}
          />
        ) : null}
      </div>

      {/* Bottom action rail — clickable */}
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
  // 24×24 L-bracket using two borders. Color = `--ovl` (set by parent).
  const base = "absolute size-7 border-[var(--ovl)]";
  const pos = {
    tl: "top-0 left-0 border-t-[3px] border-l-[3px] rounded-tl",
    tr: "top-0 right-0 border-t-[3px] border-r-[3px] rounded-tr",
    bl: "bottom-0 left-0 border-b-[3px] border-l-[3px] rounded-bl",
    br: "bottom-0 right-0 border-b-[3px] border-r-[3px] rounded-br",
  }[position];
  return <div className={`${base} ${pos}`} />;
}
