import { describe, it, expect } from 'vitest';
import {
  BarcodeFormat,
  BinaryBitmap,
  DecodeHintType,
  HybridBinarizer,
  MultiFormatReader,
  RGBLuminanceSource,
} from '@zxing/library';
import { encodeCode128 } from './code128';
import { thickenBars, orderReads, ReadConfirmer, nextPass, type PixelBuffer } from './barcode-frame';

/**
 * Render a Code 128 sticker the way the 2026-10-03 floor photos show it:
 * 3.5 px per module, every dark bar printed `loss` px narrower than nominal
 * (the gap widens by the same amount), anti-aliased, grey ink on a light
 * label, optionally with a `voidPx`-wide white void through the middle of the
 * `voidInBar`-th bar that is ≥ 3 modules wide.
 */
function renderSticker(text: string, opts: { loss: number; voidInBar?: number; voidPx?: number }): PixelBuffer {
  const widths = encodeCode128(text)!;
  const mod = 3.5;
  const quiet = 40;
  const total = widths.reduce((a, b) => a + b, 0) * mod;
  const w = Math.ceil(total + 2 * quiet);
  const h = 60;
  // Coverage (0..1 dark) of each column, from the analytic bar edges.
  const cover = new Float64Array(w);
  let x = quiet;
  let wideBars = 0;
  const voids: number[] = [];
  widths.forEach((m, i) => {
    const span = m * mod;
    if (i % 2 === 0 && m >= 3 && wideBars++ === opts.voidInBar) voids.push(Math.round(x + span / 2));
    if (i % 2 === 0) {
      const a = x + opts.loss / 2;
      const b = x + span - opts.loss / 2;
      for (let px = Math.floor(a); px < Math.ceil(b); px++) {
        cover[px] += Math.max(0, Math.min(b, px + 1) - Math.max(a, px));
      }
    }
    x += span;
  });
  for (const c of voids) {
    for (let k = 0; k < (opts.voidPx ?? 1); k++) cover[c + k] = 0;
  }
  const data = new Uint8ClampedArray(w * h * 4);
  const paper = 200;
  const ink = 30;
  for (let y = 0; y < h; y++) {
    for (let px = 0; px < w; px++) {
      const v = Math.round(paper - (paper - ink) * Math.min(1, cover[px]));
      const j = (y * w + px) * 4;
      data[j] = v;
      data[j + 1] = v;
      data[j + 2] = v;
      data[j + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

function zxingRead(img: PixelBuffer): string | null {
  const lum = new Uint8ClampedArray(img.width * img.height);
  for (let i = 0; i < lum.length; i++) lum[i] = img.data[i * 4];
  const hints = new Map();
  hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.CODE_128]);
  hints.set(DecodeHintType.TRY_HARDER, true);
  const reader = new MultiFormatReader();
  reader.setHints(hints);
  try {
    const src = new RGBLuminanceSource(lum, img.width, img.height);
    return reader.decode(new BinaryBitmap(new HybridBinarizer(src))).getText();
  } catch {
    return null;
  }
}

// The real "item C" sticker payload (פרגית קפוא, 12.27 kg, best before 30/05/2027).
const ITEM_C = '7290002195832012270127630052027';

describe('thickenBars', () => {
  it('grows a 1-px dark line to 3 px and leaves alpha alone', () => {
    const w = 7;
    const h = 3;
    const data = new Uint8ClampedArray(w * h * 4).fill(255);
    for (let y = 0; y < h; y++) {
      const j = (y * w + 3) * 4;
      data[j] = data[j + 1] = data[j + 2] = 0;
    }
    const img = { data, width: w, height: h };
    thickenBars(img);
    const row = Array.from({ length: w }, (_, x) => data[(1 * w + x) * 4]);
    expect(row).toEqual([255, 255, 0, 0, 0, 255, 255]);
    expect(data[3]).toBe(255);
  });

  it('closes a hairline white void inside a bar', () => {
    const w = 5;
    const data = new Uint8ClampedArray(w * 4).fill(255);
    [0, 0, 255, 0, 0].forEach((v, x) => {
      data[x * 4] = data[x * 4 + 1] = data[x * 4 + 2] = v;
    });
    thickenBars({ data, width: w, height: 1 });
    expect(Array.from({ length: w }, (_, x) => data[x * 4])).toEqual([0, 0, 0, 0, 0]);
  });

  it('reuses the scratch buffer it is given', () => {
    const scratch = new Uint8Array(2 * 4 * 4);
    const img = { data: new Uint8ClampedArray(4 * 4 * 4).fill(128), width: 4, height: 4 };
    expect(thickenBars(img, scratch)).toBe(scratch);
  });

  it('makes a starved-bar sticker decodable that is unreadable raw (floor regression)', () => {
    const sticker = renderSticker(ITEM_C, { loss: 1.6 });
    expect(zxingRead(sticker)).toBeNull();
    thickenBars(sticker);
    expect(zxingRead(sticker)).toBe(ITEM_C);
  });

  it('starved bars plus a hairline void through a bar (the 1.58.08 photo)', () => {
    const voided = renderSticker(ITEM_C, { loss: 1.2, voidInBar: 2, voidPx: 1 });
    expect(zxingRead(voided)).toBeNull();
    thickenBars(voided);
    expect(zxingRead(voided)).toBe(ITEM_C);
  });

  it('a well-printed sticker still reads on the raw pass (why the loop alternates)', () => {
    expect(zxingRead(renderSticker(ITEM_C, { loss: 0 }))).toBe(ITEM_C);
  });
});

describe('orderReads', () => {
  it('puts the barcode nearest the centre first and drops blanks/repeats', () => {
    expect(
      orderReads([
        { value: 'B', dist: 0.4 },
        { value: '', dist: 0 },
        { value: 'A', dist: 0.1 },
        { value: 'B', dist: 0.3 },
      ]),
    ).toEqual([
      { value: 'A', dist: 0.1 },
      { value: 'B', dist: 0.3 },
    ]);
  });
});

// The decision part of add()'s result — what the scanner books on.
const decision = (r: { confirmed: string | null; progress: number }) => ({ confirmed: r.confirmed, progress: r.progress });

describe('ReadConfirmer', () => {
  it('confirms on the second identical read within the window', () => {
    const c = new ReadConfirmer();
    expect(decision(c.add([{ value: 'A', dist: 0 }], 0))).toEqual({ confirmed: null, progress: 1 });
    expect(decision(c.add([{ value: 'A', dist: 0 }], 500))).toEqual({ confirmed: 'A', progress: 0 });
  });

  it('does not let an interleaved second label reset the first (floor regression)', () => {
    // Old rule: A, B, A, B … never confirmed anything.
    const c = new ReadConfirmer();
    expect(c.add([{ value: 'A', dist: 0.1 }], 0).confirmed).toBeNull();
    expect(c.add([{ value: 'B', dist: 0.5 }], 100).confirmed).toBeNull();
    expect(c.add([{ value: 'A', dist: 0.1 }], 200).confirmed).toBe('A');
  });

  it('when two labels confirm on the same frame, the centred one wins', () => {
    const c = new ReadConfirmer();
    c.add([{ value: 'EDGE', dist: 0.6 }, { value: 'AIMED', dist: 0.05 }], 0);
    const r = c.add([{ value: 'EDGE', dist: 0.6 }, { value: 'AIMED', dist: 0.05 }], 100);
    expect(r.confirmed).toBe('AIMED');
  });

  it('a read after the window starts that value over', () => {
    const c = new ReadConfirmer(2, 3000);
    c.add([{ value: 'A', dist: 0 }], 0);
    expect(decision(c.add([{ value: 'A', dist: 0 }], 3500))).toEqual({ confirmed: null, progress: 1 });
    expect(c.add([{ value: 'A', dist: 0 }], 3600).confirmed).toBe('A');
  });

  it('empty frames keep progress; a confirmation clears everything', () => {
    const c = new ReadConfirmer();
    c.add([{ value: 'A', dist: 0 }, { value: 'B', dist: 0.3 }], 0);
    expect(decision(c.add([], 50))).toEqual({ confirmed: null, progress: 1 });
    expect(c.add([{ value: 'A', dist: 0 }], 100).confirmed).toBe('A');
    expect(decision(c.add([{ value: 'B', dist: 0.3 }], 150))).toEqual({ confirmed: null, progress: 1 });
  });
});


// The confirmer as it stood before the trace fields (5af2a32), kept verbatim
// so the decision can be proven unchanged.
class ReadConfirmerBefore {
  private pending = new Map<string, { count: number; first: number }>();
  constructor(private readonly need = 2, private readonly windowMs = 3000) {}
  add(reads: { value: string; dist: number }[], now: number): { confirmed: string | null; progress: number } {
    for (const [v, p] of this.pending) {
      if (now - p.first > this.windowMs) this.pending.delete(v);
    }
    let confirmed: string | null = null;
    for (const r of orderReads(reads)) {
      const p = this.pending.get(r.value);
      const count = p ? p.count + 1 : 1;
      this.pending.set(r.value, { count, first: p ? p.first : now });
      if (confirmed === null && count >= this.need) confirmed = r.value;
    }
    if (confirmed !== null) {
      this.pending.clear();
      return { confirmed, progress: 0 };
    }
    let progress = 0;
    for (const p of this.pending.values()) progress = Math.max(progress, p.count);
    return { confirmed: null, progress };
  }
  forget(test: (value: string) => boolean): void {
    for (const v of [...this.pending.keys()]) {
      if (test(v)) this.pending.delete(v);
    }
  }
}

describe('ReadConfirmer — trace fields (2026-10-26, read_unconfirmed on every carton)', () => {
  const r = (value: string, dist = 0) => ({ value, dist });

  it('the decision is unchanged: 20 000 random frames, with forget() and heartbeat sweeps between them', () => {
    // Small deterministic PRNG (mulberry32) so a failure replays.
    let seed = 0x25_10_2026;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const values = ['A', 'B', 'C', 'D', '7290003670444014790729829072027'];
    for (const [need, windowMs] of [[2, 3000], [3, 1500], [2, 500]] as const) {
      const before = new ReadConfirmerBefore(need, windowMs);
      const now = new ReadConfirmer(need, windowMs);
      let t = 0;
      for (let i = 0; i < 20_000; i++) {
        t += Math.floor(rand() * 1200);
        const roll = rand();
        if (roll < 0.05) {
          const v = values[Math.floor(rand() * values.length)];
          before.forget((x) => x === v);
          now.forget((x) => x === v);
          continue;
        }
        if (roll < 0.15) {
          // The 15 s heartbeat sweeps between frames.
          now.sweep(t);
          continue;
        }
        const frame = Array.from({ length: Math.floor(rand() * 3) }, () =>
          r(values[Math.floor(rand() * values.length)], rand()),
        );
        expect(decision(now.add(frame, t, 'raw pass'))).toEqual(before.add(frame, t));
      }
    }
  });

  it('a confirmation says when its first read was', () => {
    const c = new ReadConfirmer(2, 3000);
    expect(c.add([r('A')], 1000).confirmedFirstAt).toBeNull();
    expect(c.add([r('A')], 1340).confirmedFirstAt).toBe(1000);
  });

  it('a normal carton drops nothing', () => {
    const c = new ReadConfirmer(2, 3000);
    expect(c.add([r('A')], 0, 'raw pass').dropped).toEqual([]);
    expect(c.add([r('A')], 300, 'e2e').dropped).toEqual([]);
  });

  it('sweep() returns a value whose window closed unconfirmed, once, with what read it first', () => {
    const c = new ReadConfirmer(2, 3000);
    c.add([r('MISREAD')], 1000, 'e2e');
    expect(c.sweep(4000)).toEqual([]); // still inside its window
    expect(c.sweep(4001)).toEqual([{ value: 'MISREAD', via: 'e2e', reads: 1, first: 1000, reason: 'expired' }]);
    expect(c.sweep(20_000)).toEqual([]);
  });

  it('a value expiring on the next decoding frame comes back from add() as expired', () => {
    const c = new ReadConfirmer(2, 3000);
    c.add([r('MISREAD')], 0, 'thick pass');
    const out = c.add([r('REAL')], 5000, 'raw pass');
    expect(out.dropped).toEqual([{ value: 'MISREAD', via: 'thick pass', reads: 1, first: 0, reason: 'expired' }]);
  });

  it('a read after the window reports the old window expired and starts a new one', () => {
    const c = new ReadConfirmer(2, 3000);
    c.add([r('A')], 0, 'raw pass');
    const out = c.add([r('A')], 3500, 'e2e');
    expect(out.dropped).toEqual([{ value: 'A', via: 'raw pass', reads: 1, first: 0, reason: 'expired' }]);
    expect(c.add([r('A')], 3600).confirmedFirstAt).toBe(3500);
  });

  it('values still pending when another confirms come back as superseded (the e2e misread at 09:55:24)', () => {
    const c = new ReadConfirmer(2, 3000);
    const REAL = '7290003670444014790729829072027';
    const MISREAD = '7290003670444014790729899066027';
    c.add([r(REAL)], 0, 'raw pass');
    c.add([r(MISREAD, 0.2)], 100, 'e2e');
    const out = c.add([r(REAL)], 200, 'raw pass');
    expect(out.confirmed).toBe(REAL);
    expect(out.dropped).toEqual([{ value: MISREAD, via: 'e2e', reads: 1, first: 100, reason: 'superseded' }]);
  });

  it('a label that also confirmed on the frame but lost the centre tie is superseded, with its reads', () => {
    const c = new ReadConfirmer(2, 3000);
    c.add([r('EDGE', 0.6), r('AIMED', 0.05)], 0, 'raw pass');
    const out = c.add([r('EDGE', 0.6), r('AIMED', 0.05)], 100, 'raw pass');
    expect(out.confirmed).toBe('AIMED');
    expect(out.dropped).toEqual([{ value: 'EDGE', via: 'raw pass', reads: 2, first: 0, reason: 'superseded' }]);
  });

  it('drain() hands back everything pending and empties the confirmer', () => {
    const c = new ReadConfirmer(2, 3000);
    c.add([r('A'), r('B', 0.4)], 0, 'raw pass');
    expect(c.drain('camera_stop')).toEqual([
      { value: 'A', via: 'raw pass', reads: 1, first: 0, reason: 'camera_stop' },
      { value: 'B', via: 'raw pass', reads: 1, first: 0, reason: 'camera_stop' },
    ]);
    expect(c.drain('camera_stop')).toEqual([]);
    expect(decision(c.add([r('A')], 100))).toEqual({ confirmed: null, progress: 1 });
  });

  it('via defaults to empty for callers that do not say', () => {
    const c = new ReadConfirmer(2, 3000);
    c.add([r('A')], 0);
    expect(c.sweep(5000)[0].via).toBe('');
  });
});

describe('nextPass', () => {
  it('keeps a pass that read something', () => {
    expect(nextPass('raw', true)).toBe('raw');
    expect(nextPass('thick', true)).toBe('thick');
    expect(nextPass('thickSmall', true)).toBe('thickSmall');
  });

  it('cycles raw → thick → thickSmall → raw while nothing reads', () => {
    expect(nextPass('raw', false)).toBe('thick');
    expect(nextPass('thick', false)).toBe('thickSmall');
    expect(nextPass('thickSmall', false)).toBe('raw');
  });
});

// ── 01/11: read policy (Glatt note 261062322) ──
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { inboundReadPolicy, isGlattMisread, sameGlattCarton } from './carton-barcode';
import { framesFromTrace, newRules, oldRules, replayFrames, serialRules, type TraceRow } from './scan-replay';

describe('ReadConfirmer — read policy', () => {
  const at = (value: string) => [{ value, dist: 0 }];

  it('a trusted value confirms on ONE read, and reports 1 read', () => {
    const c = new ReadConfirmer(2, 3000);
    const r = c.add(at('A'), 0, 'raw', (v) => (v === 'A' ? 'trust' : undefined));
    expect(r.confirmed).toBe('A');
    expect(r.confirmedReads).toBe(1);
  });

  it('without a policy, or for an untrusted value, two reads as before', () => {
    const c = new ReadConfirmer(2, 3000);
    expect(c.add(at('B'), 0).confirmed).toBeNull();
    const r = c.add(at('B'), 100);
    expect(r.confirmed).toBe('B');
    expect(r.confirmedReads).toBe(2);
    const d = new ReadConfirmer(2, 3000);
    expect(d.add(at('C'), 0, '', () => undefined).confirmed).toBeNull();
    expect(d.add(at('C'), 50, '', () => undefined).confirmed).toBe('C');
  });

  it('an ignored value never confirms, never shows progress, and leaves as `misread`', () => {
    const c = new ReadConfirmer(2, 3000);
    const ignore = () => 'ignore' as const;
    expect(c.add(at('M'), 0, '', ignore)).toMatchObject({ confirmed: null, progress: 0 });
    expect(c.add(at('M'), 50, '', ignore)).toMatchObject({ confirmed: null, progress: 0 });
    expect(c.add(at('M'), 100, '', ignore).confirmed).toBeNull();
    const swept = c.sweep(4000);
    expect(swept).toEqual([{ value: 'M', via: '', reads: 3, first: 0, reason: 'misread' }]);
  });

  it('an ignored value superseded by a confirmation is still reported as a misread', () => {
    const c = new ReadConfirmer(2, 3000);
    const policy = (v: string) => (v === 'M' ? 'ignore' as const : v === 'T' ? 'trust' as const : undefined);
    c.add(at('M'), 0, '', policy);
    const r = c.add(at('T'), 10, '', policy);
    expect(r.confirmed).toBe('T');
    expect(r.dropped.map((d) => [d.value, d.reason])).toEqual([['M', 'misread']]);
  });

  it('one read is trusted only for the read nearest the frame centre', () => {
    const policy = (v: string) => (v === 'T' ? ('trust' as const) : undefined);
    const c = new ReadConfirmer(2, 3000);
    // T at the edge, U in the middle: T is not booked on one glimpse.
    expect(c.add([{ value: 'U', dist: 0.1 }, { value: 'T', dist: 0.3 }], 0, '', policy).confirmed).toBeNull();
    // A second read of T confirms it the usual way.
    expect(c.add([{ value: 'U', dist: 0.3 }, { value: 'T', dist: 0.5 }], 50, '', policy).confirmed).not.toBeNull();
    const d = new ReadConfirmer(2, 3000);
    const r = d.add([{ value: 'T', dist: 0.1 }, { value: 'U', dist: 0.3 }], 0, '', policy);
    expect(r.confirmed).toBe('T');
    expect(r.dropped.map((x) => x.value)).toEqual(['U']);
  });

  it('the policy sees the other waiting reads and the rest of the frame', () => {
    const seen: string[][] = [];
    const c = new ReadConfirmer(2, 3000);
    const policy = (v: string, ctx?: { pending: string[] }) => {
      if (v === 'T') seen.push([...(ctx?.pending ?? [])].sort());
      return undefined;
    };
    c.add([{ value: 'M', dist: 0 }], 0, '', policy);
    c.add([{ value: 'T', dist: 0 }, { value: 'X', dist: 0.4 }], 10, '', policy);
    expect(seen).toEqual([['M', 'X']]);
  });

  it('a single isolated read of a serial misread (session LGUtpTw2) does not confirm', () => {
    const lines = [{ item_code: '1578' }, { item_code: '5086' }, { item_code: '7801' }];
    // Meatball cartons counted on that note, serials 0679351xx, ~10.1 kg.
    const listed = new Set(['1050861100101014067935118', '1050861100101012067935119', '1050861100101011067935120']);
    const policy = inboundReadPolicy(() => lines, () => listed);
    const c = new ReadConfirmer(2, 3000);
    expect(c.add([{ value: '1050861100100814067902118', dist: 0 }], 0, 'e2e', policy).confirmed).toBeNull();
    // The real next carton, read once, is trusted.
    expect(c.add([{ value: '1050861100101013067935121', dist: 0 }], 5000, 'e2e', policy).confirmed).toBe('1050861100101013067935121');
  });
});

/**
 * The real read sequence of session hceJxe4obaK2TgXOdVXfu (David, Glatt note
 * 261062322, 01/11) from scanner_events, replayed through the confirmer and
 * the page's read checks (lib/scan-replay.ts).
 */
describe('replay: session hceJxe4obaK2TgXOdVXfu (Glatt note 261062322)', () => {
  const fx = JSON.parse(
    readFileSync(path.resolve(__dirname, '../test/fixtures/scan_trace_hceJxe4obaK2TgXOdVXfu.json'), 'utf8'),
  ) as { lines: Array<{ item_code: string }>; rows: TraceRow[] };
  const frames = framesFromTrace(fx.rows);
  const old = replayFrames(frames, oldRules());
  const neu = replayFrames(frames, newRules(fx.lines));
  const oldCodes = old.booked.map((b) => b.value);
  const newCodes = neu.booked.map((b) => b.value);
  const VALID = ['1050861100101011067936150', '1014721100101530065729703', '1014721100101409065729707'];
  const MISREAD = '1050861115101001067936150';
  const REGEX_VALID_MISREADS = ['1006781100101369069565401', '1120671100101720069560708'];

  it('the note lines and the read sequence are the real ones', () => {
    expect(fx.lines.map((l) => l.item_code)).toEqual(['1472', '1578', '5086']);
    expect(frames.length).toBeGreaterThan(300);
  });

  it('before: 120 cartons from the camera, the double misread booked, the 3 valid single reads lost', () => {
    expect(oldCodes).toHaveLength(120);
    expect(oldCodes).toContain(MISREAD);
    for (const v of VALID) expect(oldCodes).not.toContain(v);
  });

  it('now: each of the 3 valid single reads with a note item code is confirmed and booked', () => {
    for (const v of VALID) {
      const b = neu.booked.find((x) => x.value === v);
      expect(b, v).toBeDefined();
      expect(b!.reads).toBe(1);
    }
  });

  it('now: the double misread is refused and never booked; the regex-valid misreads never confirm', () => {
    expect(newCodes).not.toContain(MISREAD);
    expect(newCodes.filter(isGlattMisread)).toEqual([]);
    for (const v of REGEX_VALID_MISREADS) expect(newCodes).not.toContain(v);
  });

  it('now: no carton booked before is lost (by code or by Glatt serial), and no carton is booked twice', () => {
    for (const v of oldCodes) {
      if (v === MISREAD) continue;
      expect(newCodes.includes(v) || newCodes.some((n) => sameGlattCarton(n, v)), v).toBe(true);
    }
    const serials = newCodes.filter((c) => /^1\d{24}$/.test(c)).map((c) => c.slice(-9));
    expect(new Set(serials).size).toBe(serials.length);
    // 120 − the misread + its valid code + the 2 thigh cartons.
    expect(newCodes).toHaveLength(122);
  });

  it('a carton already on the list still needs two reads (one glimpse never re-arms the cooldown)', () => {
    // A thigh carton next to VALID[1] is counted, so VALID[1] is trusted on one read.
    const listed = new Set<string>([VALID[0], '1014721100101420065729702']);
    const policy = inboundReadPolicy(() => fx.lines, () => listed);
    const c = new ReadConfirmer(2, 3000);
    expect(c.add([{ value: VALID[0], dist: 0 }], 0, '', policy).confirmed).toBeNull();
    expect(c.add([{ value: VALID[1], dist: 0 }], 10, '', policy).confirmed).toBe(VALID[1]);
  });
});

/**
 * Wall Dan item 1 (04/11): the real reads of notes 48651 and 48696 — every
 * value a 6-digit carton serial the page refused — replayed with the
 * camera_short_serial rules (lib/scan-replay.ts serialRules). An
 * approximation: a refused value's confirms are traced at most once per 3 s.
 */
describe('replay: Wall Dan serials (item 1, camera_short_serial)', () => {
  const load = (token: string) => JSON.parse(
    readFileSync(path.resolve(__dirname, `../test/fixtures/scan_trace_${token}.json`), 'utf8'),
  ) as { lines: Array<{ item_code: string }>; rows: TraceRow[] };

  it('48696 (zc0OjN6GaKPyvrfOJh7rx): 0 → 20 cartons; 409829 and 379337 lost to the cooldown; flag off books 0', () => {
    const fx = load('zc0OjN6GaKPyvrfOJh7rx');
    const frames = framesFromTrace(fx.rows);
    expect(replayFrames(frames, oldRules()).booked).toEqual([]);
    expect(replayFrames(frames, newRules(fx.lines)).booked).toEqual([]);
    const serial = replayFrames(frames, serialRules(fx.lines));
    const codes = serial.booked.map((b) => b.value);
    expect(codes).toEqual([
      '406186', '409830', '409849', '379338', '379333', '379301', '409850', '409825', '379325', '379334',
      '379341', '409826', '409824', '409823', '379300', '379335', '379326', '379439', '379343', '406190',
    ]);
    expect(new Set(codes).size).toBe(codes.length);
    // Lost = dropped by the cooldown and never booked later (379326 was re-read and booked).
    const lost = [...new Set(serial.cooldownDropped.map((d) => d.value))].filter((v) => !codes.includes(v));
    expect(lost.sort()).toEqual(['379337', '409829']);
  });

  it('48651 (-9KcCgT1Q2nKSfVjfT6W7): 0 → 16 cartons, each once; 6 lost to the cooldown; flag off books 0', () => {
    const fx = load('-9KcCgT1Q2nKSfVjfT6W7');
    const frames = framesFromTrace(fx.rows);
    expect(replayFrames(frames, oldRules()).booked).toEqual([]);
    expect(replayFrames(frames, newRules(fx.lines)).booked).toEqual([]);
    const serial = replayFrames(frames, serialRules(fx.lines));
    const codes = serial.booked.map((b) => b.value);
    expect(codes).toHaveLength(16);
    expect(new Set(codes).size).toBe(16);
    expect(codes).toContain('409251');
    expect(codes).toContain('409241');
    expect(codes.every((c) => /^[1-9]\d{5}$/.test(c))).toBe(true);
    // Lost = dropped by the cooldown and never booked later (409235, 409254 were re-read and booked).
    const lost = [...new Set(serial.cooldownDropped.map((d) => d.value))].filter((v) => !codes.includes(v));
    expect(lost.sort()).toEqual(['409233', '409238', '409242', '409243', '409245', '409451']);
    // Read 4 times each, booked once.
    expect(codes.filter((c) => c === '409251')).toHaveLength(1);
    expect(codes.filter((c) => c === '409241')).toHaveLength(1);
  });

  it('the Glatt session is unchanged under the serial rules (no short serial there)', () => {
    const fx = load('hceJxe4obaK2TgXOdVXfu');
    const frames = framesFromTrace(fx.rows);
    expect(replayFrames(frames, serialRules(fx.lines))).toEqual(replayFrames(frames, newRules(fx.lines)));
  });
});
