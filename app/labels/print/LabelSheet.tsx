'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { CartonSticker } from '@/components/terminal/CartonSticker';
import { t } from '@/lib/i18n';
import type { CartonLabel, Language, LabelSize } from '@/types';

/**
 * Page geometry per label size.
 *
 * 10×10 and 10×15 print one sticker per page for a dedicated label printer.
 * A4 falls back to a grid on ordinary paper (or an 8-up label sheet), which is
 * what a warehouse without a label printer actually has.
 *
 * `maxH` is the label stock's height — a ceiling, not the printed height. For
 * the one-per-page sizes the page shrinks to whatever the sticker actually
 * needs (see `pageHeightMm`), so a short sticker does not eject a half-blank
 * label. It never grows past `maxH`, so die-cut stock still lines up.
 */
const SHEETS: Record<LabelSize, { margin: string; w: string; maxH: number; cols: number; font: string }> = {
  '10x10': { margin: '0', w: '100mm', maxH: 100, cols: 1, font: '3.4mm' },
  '10x15': { margin: '0', w: '100mm', maxH: 150, cols: 1, font: '4mm' },
  a4:      { margin: '6mm', w: '96mm', maxH: 67, cols: 2, font: '2.6mm' },
};

/** CSS px → mm (1 CSS px is 1/96 in by definition). */
const pxToMm = (px: number) => (px / 96) * 25.4;

function isLabelSize(v: string | null): v is LabelSize {
  return v === '10x10' || v === '10x15' || v === 'a4';
}

export function LabelSheet() {
  const params = useSearchParams();
  const token = params.get('token') ?? '';
  const batches = params.get('batches') ?? '';
  const sizeParam = params.get('size');
  const size: LabelSize = isLabelSize(sizeParam) ? sizeParam : '10x15';
  const language: Language = params.get('lang') === 'English' ? 'English' : 'Hebrew';
  const tr = useMemo(() => (k: Parameters<typeof t>[1]) => t(language, k), [language]);

  // Starts as [] (not null) when the URL carries nothing to print, so the
  // empty state renders without an effect having to set it.
  const [labels, setLabels] = useState<CartonLabel[] | null>(() => (token && batches ? null : []));
  const [failed, setFailed] = useState(false);
  /**
   * Printed page height in mm for the one-per-page sizes, measured from the
   * rendered sticker. Null until the first measurement lands.
   */
  const [pageHeightMm, setPageHeightMm] = useState<number | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  // The print dialog must fire once, and only after the stickers are on screen —
  // printing an empty page is worse than making the worker tap Print.
  const printedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    if (!token || !batches) return;
    fetch(`/api/carton-labels/print?token=${encodeURIComponent(token)}&batches=${encodeURIComponent(batches)}`)
      .then(r => r.json())
      .then(data => {
        if (cancelled) return;
        if (data?.success) setLabels(data.labels as CartonLabel[]);
        else setFailed(true);
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [token, batches]);

  const sheet = SHEETS[size];
  const autoHeight = sheet.cols === 1;

  /**
   * Measure the tallest sticker and size the page to it.
   *
   * A ResizeObserver rather than a one-shot read: the webfonts land after the
   * first paint and change the height, and a page sized from the fallback face
   * would either clip the barcode or leave the blank strip back.
   */
  useEffect(() => {
    const node = gridRef.current;
    if (!autoHeight || !node || !labels?.length) return;

    const observer = new ResizeObserver(() => {
      const cells = node.querySelectorAll<HTMLElement>('.sheet-cell');
      let tallest = 0;
      cells.forEach(cell => { tallest = Math.max(tallest, cell.getBoundingClientRect().height); });
      if (tallest <= 0) return;
      // Round up to a whole mm and cap at the stock height.
      const mm = Math.min(Math.ceil(pxToMm(tallest)), sheet.maxH);
      setPageHeightMm(prev => (prev === mm ? prev : mm));
    });

    observer.observe(node);
    node.querySelectorAll('.sheet-cell').forEach(cell => observer.observe(cell));
    return () => observer.disconnect();
  }, [autoHeight, labels, sheet.maxH]);

  useEffect(() => {
    if (printedRef.current || !labels?.length) return;
    // Wait for the measured page height, otherwise the dialog opens against
    // the pre-measurement layout and prints the blank strip we just removed.
    if (autoHeight && pageHeightMm == null) return;
    printedRef.current = true;
    // A beat for the webfonts — a sticker printed mid-font-swap comes out in
    // the fallback face at the wrong metrics.
    const timer = setTimeout(() => window.print(), 400);
    return () => clearTimeout(timer);
  }, [labels, autoHeight, pageHeightMm]);

  const pageSize = autoHeight
    ? `${sheet.w} ${pageHeightMm ?? sheet.maxH}mm`
    : 'A4';

  return (
    <div id="label-sheet-page" style={{ background: '#fff', minHeight: '100vh' }}>
      <style>{`
        @page { size: ${pageSize}; margin: ${sheet.margin}; }
        html, body { background: #fff !important; }
        #label-sheet-page { background: #fff !important; }
        /* Browsers drop background paint when printing; the sticker's rules,
           dividers and barcode quiet zones are exactly that. */
        .sheet-cell, .sheet-cell * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        .sheet-grid {
          display: grid;
          grid-template-columns: repeat(${sheet.cols}, ${sheet.w});
          justify-content: center;
          gap: 0;
        }
        .sheet-cell {
          width: ${sheet.w};
          ${autoHeight ? '' : `height: ${sheet.maxH}mm;`}
          box-sizing: border-box;
          page-break-inside: avoid;
          break-inside: avoid;
          overflow: hidden;
        }
        ${sheet.cols === 1 ? '.sheet-cell { page-break-after: always; break-after: page; }' : ''}
        ${sheet.cols === 1 ? '.sheet-cell:last-child { page-break-after: auto; break-after: auto; }' : ''}
        @media screen {
          .sheet-cell { border: 1px dashed #bbb; margin: 4px; }
          .sheet-grid { gap: 4px; padding: 12px; }
        }
        @media print { .no-print { display: none !important; } }
      `}</style>

      <div className="no-print" style={{ padding: '12px', textAlign: 'center', fontFamily: "var(--font-app-sans), system-ui, sans-serif" }}>
        <button
          onClick={() => window.print()}
          style={{
            background: '#13a4ec', color: '#fff', border: 'none', borderRadius: 12,
            padding: '12px 24px', cursor: 'pointer',
            fontFamily: 'var(--font-app-sans), system-ui, sans-serif', fontWeight: 900, fontSize: 15,
          }}
        >
          {tr('labels.sheetPrint')}
        </button>
      </div>

      {labels === null && !failed ? (
        <p style={{ textAlign: 'center', fontFamily: "var(--font-app-sans), system-ui, sans-serif", color: '#444' }}>
          {tr('labels.sheetLoading')}
        </p>
      ) : null}

      {failed || (labels && labels.length === 0) ? (
        <p style={{ textAlign: 'center', fontFamily: "var(--font-app-sans), system-ui, sans-serif", color: '#444' }}>
          {tr('labels.sheetEmpty')}
        </p>
      ) : null}

      <div className="sheet-grid" ref={gridRef}>
        {(labels ?? []).map(label => (
          <div className="sheet-cell" key={label.id}>
            <CartonSticker label={label} fontSize={sheet.font} />
          </div>
        ))}
      </div>
    </div>
  );
}
