import type { CSSProperties } from 'react';
import type { CartonLabel } from '@/types';
import { Barcode128 } from './Barcode128';

/** DD/MM/YY — the convention printed on the supplier stickers this one stands in for. */
function shortDate(iso: string | null): string {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${m[3]}/${m[2]}/${m[1].slice(2)}`;
}

function formatWeight(kg: number | null): string {
  if (kg == null) return '';
  return kg.toFixed(2);
}

interface CartonStickerProps {
  label: CartonLabel;
  /**
   * Root font size — every dimension inside is expressed in `em`, so one
   * number scales the whole sticker. Use a mm value for print and a px value
   * for the on-screen preview.
   */
  fontSize: string;
  className?: string;
  style?: CSSProperties;
}

/**
 * The printed face of a warehouse-minted carton sticker.
 *
 * Laid out to be read back by the same Gemini box-sticker OCR that reads
 * supplier stickers: Hebrew product name on top, the net weight as the one
 * large number, production and expiry as labelled DD/MM/YY pairs, and the
 * barcode digits spelled out under the bars. Nothing here carries the LPN
 * sticker's marker — this must classify as a box sticker, not a pallet.
 */
export function CartonSticker({ label, fontSize, className = '', style }: CartonStickerProps) {
  const name = label.item_name_hebrew || label.item_name_english || '';
  const weight = formatWeight(label.weight_kg);

  return (
    <div
      dir="rtl"
      className={className}
      style={{
        fontSize,
        fontFamily: "var(--font-app-sans), system-ui, sans-serif",
        background: '#fff',
        color: '#111',
        width: '100%',
        height: '100%',
        boxSizing: 'border-box',
        padding: '0.9em',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.5em',
        overflow: 'hidden',
        ...style,
      }}
    >
      {/* Product name — the field OCR matches against the invoice line. */}
      <div
        style={{
          fontWeight: 900,
          fontSize: '1.7em',
          lineHeight: 1.1,
          wordBreak: 'break-word',
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}
      >
        {name}
      </div>

      <div style={{ display: 'flex', gap: '0.8em', fontSize: '0.85em', fontWeight: 600, color: '#444' }}>
        {label.item_code ? <span>מק״ט {label.item_code}</span> : null}
        {label.document_number ? <span dir="ltr">{label.document_number}</span> : null}
      </div>

      <div style={{ height: 1, background: '#111', opacity: 0.75 }} />

      {weight ? (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.4em' }}>
          <span style={{ fontSize: '0.8em', fontWeight: 700, color: '#444' }}>משקל נטו</span>
          <span style={{ fontSize: '2.1em', fontWeight: 900, letterSpacing: '-0.01em' }} dir="ltr">
            {weight}
          </span>
          <span style={{ fontSize: '1em', fontWeight: 800 }}>ק״ג</span>
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: '1.4em', fontSize: '0.95em', fontWeight: 700 }}>
        {label.production_date ? (
          <div>
            <div style={{ fontSize: '0.7em', fontWeight: 700, color: '#555' }}>PROD · ייצור</div>
            <div dir="ltr" style={{ fontFamily: "var(--font-app-mono), ui-monospace, monospace" }}>{shortDate(label.production_date)}</div>
          </div>
        ) : null}
        {label.expiry_date ? (
          <div>
            <div style={{ fontSize: '0.7em', fontWeight: 700, color: '#555' }}>EXPIRY · תוקף</div>
            <div dir="ltr" style={{ fontFamily: "var(--font-app-mono), ui-monospace, monospace" }}>{shortDate(label.expiry_date)}</div>
          </div>
        ) : null}
      </div>

      {/* The bars sit immediately under the text, NOT pushed to the bottom of
          the label. Aiming at the barcode is what frames the shot, and the
          scanner OCRs that same frame for the product, weight and dates — a
          gap between them means the worker scans a barcode with no readable
          text in view, and the box lands as "needs review". Any spare label
          height falls below this block instead of between it and the text. */}
      <div style={{ marginTop: '0.35em' }}>
        {label.print_barcode ? (
          <>
            <Barcode128 value={label.barcode} height={34} cssHeight="2.6em" quietModules={10} />
            <div
              dir="ltr"
              style={{
                fontFamily: "var(--font-app-mono), ui-monospace, monospace",
                fontSize: '0.85em',
                fontWeight: 700,
                letterSpacing: '0.12em',
                textAlign: 'center',
                marginTop: '0.15em',
              }}
            >
              {label.barcode}
            </div>
          </>
        ) : null}
        <div
          dir="ltr"
          style={{
            fontFamily: "var(--font-app-mono), ui-monospace, monospace",
            fontSize: '0.7em',
            fontWeight: 700,
            color: '#555',
            textAlign: 'center',
            marginTop: '0.2em',
          }}
        >
          {label.serial}
        </div>
      </div>
    </div>
  );
}
