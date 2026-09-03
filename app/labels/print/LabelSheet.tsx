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
 */
const SHEETS: Record<LabelSize, { page: string; margin: string; w: string; h: string; cols: number; font: string }> = {
  '10x10': { page: '100mm 100mm', margin: '0', w: '100mm', h: '100mm', cols: 1, font: '3.4mm' },
  '10x15': { page: '100mm 150mm', margin: '0', w: '100mm', h: '150mm', cols: 1, font: '4mm' },
  a4:      { page: 'A4',          margin: '6mm', w: '96mm', h: '67mm', cols: 2, font: '2.6mm' },
};

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

  useEffect(() => {
    if (printedRef.current || !labels?.length) return;
    printedRef.current = true;
    // One frame for layout, then a beat for the webfonts — a sticker printed
    // mid-font-swap comes out in the fallback face at the wrong metrics.
    const timer = setTimeout(() => window.print(), 400);
    return () => clearTimeout(timer);
  }, [labels]);

  const sheet = SHEETS[size];

  return (
    <div id="label-sheet-page" style={{ background: '#fff', minHeight: '100vh' }}>
      <style>{`
        @page { size: ${sheet.page}; margin: ${sheet.margin}; }
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
          height: ${sheet.h};
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

      <div className="sheet-grid">
        {(labels ?? []).map(label => (
          <div className="sheet-cell" key={label.id}>
            <CartonSticker label={label} fontSize={sheet.font} />
          </div>
        ))}
      </div>
    </div>
  );
}
