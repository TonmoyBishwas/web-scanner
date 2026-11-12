import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { flagSuspectWeights, replaceIdenticalSample, weightCheckOpts } from './weight-check';
import { expandIdenticalBoxes, sourceTakesFormWeight } from './identical-boxes';
import { blocksConfirm } from './failed-read';
import type { BarcodeFilled } from './barcode-reconcile';
import type { MultiPalletBoxScan, MultiPalletSession } from '@/types';

/**
 * The page wiring of weight_ratio_over_kg_name (review 12/11): the session's
 * switch reaches the weight check on the "Different carton?" save, the only
 * path where the peas doubt (IN26014927) can fire. Asher Shahar, peas
 * 7290019872498 "אפונה תפ' 10 ק"ג (4*2.5 ק"ג)" (peas 10 kg, 4 bags of
 * 2.5 kg): the source carton read 2.5 kg off the inner bag's label, and 79
 * copies were saved at 10 kg.
 */
type Row = MultiPalletBoxScan & {
  ocr_status?: string; weight_checked?: boolean; weight_typed?: boolean; needs_review?: boolean;
  barcode_filled?: BarcodeFilled;
  weight_suspect?: { typical?: number; reason: 'name_number' | 'ratio'; name?: string };
};

const NAME = 'אפונה תפ\' 10 ק"ג (4*2.5 ק"ג) בד"ץ (פנזה)';
const SRC = '7290019872498';
const source = (): Row => ({
  barcode: SRC, sku: SRC, item_name: 'Peas 10 kg (4*2.5 kg) Badatz (Frozen)', item_name_hebrew: NAME,
  weight: 2.5, ocr_weight: 2.5, expiry: '2028-05-24', production_date: '2025-11-24',
  scanned_at: '2026-11-11T09:20:28.866Z', ocr_status: 'done',
});
const FORM = { weight: 10, expiry: '2028-05-24', production_date: '2025-11-24', weight_confirmed: true };
const labels = (n: number) => Array.from({ length: n }, (_, i) => ({ barcode: `2826111111${String(i).padStart(6, '0')}`, batch_id: 'b11' }));
const total = (rows: ReadonlyArray<{ weight: number }>) => rows.reduce((a, b) => a + b.weight, 0);

const session = (features?: MultiPalletSession['features']) => ({ features } as Pick<MultiPalletSession, 'features'>);
const ON = session({ units_mode: true, weight_ratio_over_kg_name: true });
const OFF = session({ units_mode: true });

/** The page's "Different carton?" save of 79 at 10 kg on the 2.5 kg source. */
function differentCarton(s: Pick<MultiPalletSession, 'features'> | null, reweigh = false): Row[] {
  const src = source();
  const rows = expandIdenticalBoxes(src, labels(79), FORM);
  const reweighSource = reweigh && sourceTakesFormWeight(src, FORM, 79);
  return replaceIdenticalSample<Row>([src], {
    sourceBarcode: SRC, anotherOf: true, rows, form: FORM, saved: 79, reweighSource, opts: weightCheckOpts(s),
  });
}

describe('weightCheckOpts', () => {
  it('off unless the session carries the switch', () => {
    expect(weightCheckOpts(null)).toEqual({ ratioOverKgName: false });
    expect(weightCheckOpts(undefined)).toEqual({ ratioOverKgName: false });
    expect(weightCheckOpts(session(undefined))).toEqual({ ratioOverKgName: false });
    expect(weightCheckOpts(OFF)).toEqual({ ratioOverKgName: false });
    expect(weightCheckOpts(ON)).toEqual({ ratioOverKgName: true });
  });
});

describe('replaceIdenticalSample — "Different carton?" on the peas carton', () => {
  it('switch on: the source comes out a ratio doubt at typical 10 kg, holding the confirm', () => {
    const out = differentCarton(ON);
    expect(out).toHaveLength(80);
    expect(out[0].barcode).toBe(SRC);
    expect(out[0].weight_suspect).toEqual({ typical: 10, reason: 'ratio', name: undefined });
    expect(blocksConfirm(out[0])).toBe(true);
    expect(out.slice(1).every((r) => !r.weight_suspect)).toBe(true);
  });

  it('switch absent: no doubt, the list exactly as the save made it before', () => {
    for (const s of [OFF, session(undefined), null]) {
      const out = differentCarton(s);
      expect(out.every((r) => !r.weight_suspect)).toBe(true);
      expect(total(out)).toBeCloseTo(792.5, 6);
    }
  });

  it('identical_source_weight with it: the source takes 10 kg, nothing is doubted, 800 kg', () => {
    const out = differentCarton(ON, true);
    expect(out[0]).toMatchObject({ weight: 10, weight_typed: true, weight_checked: true, weight_suspect: undefined });
    expect(out.every((r) => !r.weight_suspect)).toBe(true);
    expect(total(out)).toBeCloseTo(800, 6);
  });

  it('a partial safeguard only: Save in the edit panel with 2.5 unchanged settles it, and 792.5 kg is booked', () => {
    // The edit panel's save marks the weight reviewed and clears the doubt
    // (page.tsx: weight_checked true, weight_suspect undefined). The ratio
    // text says a sticker that reads 2.5 kg means the weight is correct, and
    // the inner bag's sticker does.
    const out = differentCarton(ON);
    const saved = out.map((r, i) => (i === 0 ? { ...r, weight_checked: true, weight_suspect: undefined } : r));
    expect(blocksConfirm(saved[0])).toBe(false);
    expect(flagSuspectWeights(saved, {}, weightCheckOpts(ON)).every((r) => !r.weight_suspect)).toBe(true);
    expect(total(saved)).toBeCloseTo(792.5, 6);
  });
});

describe('replaceIdenticalSample — identical / New carton (the sample row replaced)', () => {
  const others = (): Row[] => [10, 10.02, 9.98].map((w, i) => ({ ...source(), barcode: `o${i}`, weight: w, ocr_weight: w }));

  it('the rows take the sample\'s place, and the switch reaches the check', () => {
    const src = source();
    const list = [others()[0], src, ...others().slice(1)];
    const rows = expandIdenticalBoxes({ ...src, weight: 2.5 }, labels(2), { ...FORM, weight: 2.5, weight_confirmed: false });
    const on = replaceIdenticalSample<Row>(list, { sourceBarcode: SRC, anotherOf: false, rows, form: { ...FORM, weight: 2.5, weight_confirmed: false }, saved: 2, reweighSource: false, opts: weightCheckOpts(ON) });
    expect(on.map((r) => r.barcode)).toEqual(['o0', rows[0].barcode, rows[1].barcode, 'o1', 'o2']);
    expect(on.filter((r) => r.weight_suspect?.reason === 'ratio').map((r) => r.barcode)).toEqual(rows.map((r) => r.barcode));
    const off = replaceIdenticalSample<Row>(list, { sourceBarcode: SRC, anotherOf: false, rows, form: { ...FORM, weight: 2.5, weight_confirmed: false }, saved: 2, reweighSource: false, opts: weightCheckOpts(OFF) });
    expect(off.every((r) => !r.weight_suspect)).toBe(true);
  });

  it('`replaces` drops the photo row a twin stands in for', () => {
    const list = [...others(), { ...source(), barcode: 'photo' }];
    const rows = expandIdenticalBoxes(others()[0], labels(1), FORM);
    const out = replaceIdenticalSample<Row>(list, { sourceBarcode: 'o0', anotherOf: true, replaces: 'photo', rows, form: FORM, saved: 1, reweighSource: false, opts: {} });
    expect(out.map((r) => r.barcode)).toEqual(['o0', 'o1', 'o2', rows[0].barcode]);
  });
});

describe('flagSuspectWeights', () => {
  it('a weight its barcode gave is never doubted; one already doubted is kept as it is', () => {
    const rows: Row[] = [10, 10, 10].map((w, i) => ({ ...source(), barcode: `o${i}`, weight: w }));
    const fromBarcode: Row = { ...source(), barcode: 'bc', barcode_filled: { weight: 2.5 } };
    expect(flagSuspectWeights([...rows, fromBarcode], {}, { ratioOverKgName: true })).toEqual([...rows, fromBarcode]);
    const doubted: Row = { ...source(), weight_suspect: { reason: 'name_number', name: 'x' } };
    expect(flagSuspectWeights([...rows, doubted], {}, { ratioOverKgName: true })[3]).toBe(doubted);
  });
});

describe('page.tsx passes the switch to every weight check', () => {
  const src = readFileSync(path.join(__dirname, '..', 'app', 'pallet-verify', '[token]', 'page.tsx'), 'utf8');
  /** The text of each call `name(…)`, by balancing its parentheses. */
  const calls = (name: string): string[] => {
    const out: string[] = [];
    for (let i = src.indexOf(`${name}(`); i !== -1; i = src.indexOf(`${name}(`, i + 1)) {
      let depth = 0;
      let j = i + name.length;
      for (; j < src.length; j++) {
        if (src[j] === '(') depth++;
        else if (src[j] === ')' && --depth === 0) break;
      }
      out.push(src.slice(i, j + 1));
    }
    return out;
  };

  it('the pallet OCR result, the loose OCR result and the identical saves', () => {
    const checks = [...calls('flagSuspectWeights'), ...calls('replaceIdenticalSample')];
    expect(checks).toHaveLength(3);
    for (const c of checks) expect(c).toContain('weightCheckOpts(sessionRef.current)');
  });
});
