import { describe, expect, it } from 'vitest';
import { encodeCode128 } from './code128';
import { scanCode128 } from './code128-e2e';

/**
 * Draw a Code 128 symbol the way a phone camera sees a thermal sticker:
 * `mod` px per module, every bar `spread` px fatter (negative = starved),
 * an optional hairline white void (a dead printhead dot) at `voidAt`
 * (0..1 along the symbol), a gaussian blur, and the symbol cut off at
 * `cutAt` (0..1) to imitate a scanline leaving it.
 */
function render(
  text: string,
  { mod = 3, spread = 0, blur = 0.8, voidAt = -1, cutAt = 2, flip = false } = {},
) {
  const widths = encodeCode128(text);
  if (!widths) throw new Error('unencodable ' + text);
  const total = widths.reduce((a, b) => a + b, 0) * mod;
  const W = Math.ceil(total + 40 * mod);
  const H = 40;
  const x0 = 20 * mod;
  const edges: number[] = [];
  let x = x0;
  for (const m of widths) {
    edges.push(x);
    x += m * mod;
  }
  edges.push(x);
  const S = 4;
  const sig = new Float64Array(W * S);
  for (let i = 0; i < sig.length; i++) {
    const u = i / S;
    if (u > x0 + total * cutAt) continue;
    for (let b = 0; b < widths.length; b += 2) {
      if (u >= edges[b] - spread / 2 && u < edges[b + 1] + spread / 2) {
        const v = x0 + voidAt * total;
        sig[i] = voidAt >= 0 && u >= v && u < v + mod * 0.45 ? 0 : 1;
        break;
      }
    }
  }
  const r = Math.ceil(blur * 3 * S);
  const k: number[] = [];
  let ks = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-(i * i) / (2 * (blur * S) ** 2));
    k.push(v);
    ks += v;
  }
  const data = new Uint8ClampedArray(W * H * 4);
  for (let px = 0; px < W; px++) {
    let acc = 0;
    const c = px * S + S / 2;
    for (let i = -r; i <= r; i++) {
      const q = c + i;
      if (q >= 0 && q < sig.length) acc += sig[q] * k[i + r];
    }
    const g = 210 - (acc / ks) * 190;
    for (let py = 0; py < H; py++) {
      const j = (py * W + (flip ? W - 1 - px : px)) * 4;
      data[j] = data[j + 1] = data[j + 2] = g;
      data[j + 3] = 255;
    }
  }
  return { data, width: W, height: H };
}

const ITEM_C = '7290002195832012210127027052027'; // 31 digits: start B + C pairs
const MEAT = '72900000001011550004301120260002'; // 32 digits: all subset C

const values = (img: ReturnType<typeof render>) =>
  scanCode128(img, { max: 4, angles: [0] }).map((r) => r.value);

describe('scanCode128', () => {
  it('reads clean symbols at 2–5 px per module', () => {
    for (const mod of [2, 3, 5]) {
      expect(values(render(ITEM_C, { mod }))).toEqual([ITEM_C]);
      expect(values(render(MEAT, { mod }))).toEqual([MEAT]);
    }
  });

  it('reads text and mixed payloads the way the platform detector spells them', () => {
    for (const t of ['IN26412132', '200000113569+', '381325', 'Hello-World 42']) {
      expect(values(render(t))).toEqual([t]);
    }
  });

  it('reads starved bars (thermal print) and fat bars (ink spread)', () => {
    // A pixel thinner per bar at 3 px/module is the item-C floor sticker.
    expect(values(render(ITEM_C, { mod: 3, spread: -1.2 }))).toEqual([ITEM_C]);
    expect(values(render(ITEM_C, { mod: 3, spread: 1.2 }))).toEqual([ITEM_C]);
  });

  it('reads a sticker with a dead-printhead hairline through one bar', () => {
    let read = 0;
    for (let v = 0.05; v < 0.95; v += 0.05) {
      const got = values(render(ITEM_C, { mod: 3.5, spread: -0.6, voidAt: v }));
      // Never a wrong value; usually the right one.
      expect(got.every((g) => g === ITEM_C)).toBe(true);
      if (got.length) read++;
    }
    expect(read).toBeGreaterThanOrEqual(14);
  });

  it('reads upside down', () => {
    expect(values(render(ITEM_C, { flip: true }))).toEqual([ITEM_C]);
  });

  it('never reads a symbol the scanline left half-way', () => {
    for (let cut = 0.2; cut < 0.99; cut += 0.02) {
      expect(values(render(MEAT, { cutAt: cut }))).toEqual([]);
      expect(values(render(ITEM_C, { cutAt: cut, spread: -0.8 }))).toEqual([]);
    }
  });

  it('finds nothing in noise', () => {
    let seed = 1;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const W = 640;
    const H = 120;
    const data = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      // Random bar-like stripes: the worst case for a 1-D reader.
      const g = Math.floor(i % W / (2 + Math.floor(rnd() * 8))) % 2 ? 30 : 220;
      data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = g;
      data[i * 4 + 3] = 255;
    }
    expect(scanCode128({ data, width: W, height: H }, { max: 4 })).toEqual([]);
  });
});
