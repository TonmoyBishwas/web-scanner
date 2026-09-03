import { encodeCode128, code128ModuleCount } from '@/lib/code128';

interface Barcode128Props {
  value: string;
  /** Bar height in viewBox units — sets the drawn aspect ratio. */
  height?: number;
  /**
   * Rendered height as a CSS length. Defaults to `height` in px; the printed
   * sticker passes an `em` value so the bars scale with the label size.
   */
  cssHeight?: string;
  /** Quiet zone on each side, in modules. The spec's minimum is 10. */
  quietModules?: number;
  className?: string;
  /** Bar colour — black on the printed sticker, lighter in dark-UI previews. */
  color?: string;
}

/**
 * Code 128 barcode as inline SVG.
 *
 * Uses a viewBox in module units and `width: 100%`, so the same element is
 * crisp both in a 60px-wide preview thumbnail and on a 100mm printed label —
 * vector bars have no resampling artefacts for a camera to trip over.
 *
 * No hooks and no browser APIs, so it renders on the server too.
 */
export function Barcode128({
  value,
  height = 40,
  cssHeight,
  quietModules = 10,
  className = '',
  color = '#111',
}: Barcode128Props) {
  const widths = encodeCode128(value);
  if (!widths) return null;

  const modules = code128ModuleCount(widths);
  const total = modules + quietModules * 2;

  // Widths alternate bar, space, bar, … starting on a bar.
  const bars: { x: number; w: number }[] = [];
  let x = quietModules;
  widths.forEach((w, i) => {
    if (i % 2 === 0) bars.push({ x, w });
    x += w;
  });

  return (
    <svg
      className={className}
      viewBox={`0 0 ${total} ${height}`}
      preserveAspectRatio="none"
      style={{ width: '100%', height: cssHeight ?? height, display: 'block' }}
      shapeRendering="crispEdges"
      aria-hidden
    >
      {bars.map((b, i) => (
        <rect key={i} x={b.x} y={0} width={b.w} height={height} fill={color} />
      ))}
    </svg>
  );
}
