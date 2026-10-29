import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { barcodeWeight, weightsAgree } from './barcode-weight';
import { parseCartonBarcode } from './barcode-parser';

/**
 * The shared barcode-weight case list (Mevaser 28/10, the barcode-vs-OCR
 * weight check). The same file is run by the bot
 * (tests/fixtures/barcode_weight_fixture.json, bot/utils/carton_barcode.py)
 * and matches the SQL carton_barcode_weight_kg: one rule, three places.
 * Mostly real box_inventory barcodes (every family, the per-batch 19th digit,
 * `]C1`, Glatt units/misread mids, 24/26/28/30/32-digit shapes, the 150+ kg
 * pallet fixtures) plus synthetic bound cases.
 */
interface Case {
  barcode: string;
  family: 'gs31' | 'glatt25' | null;
  kg: number | null;
  class: string;
  source: 'db' | 'synthetic';
  note?: string;
}
interface Fixture {
  cases: Case[];
  agree_cases: Array<{ ocr_kg: number; barcode_kg: number; agree: boolean }>;
}

const fixture: Fixture = JSON.parse(
  readFileSync(path.resolve(__dirname, '../test/fixtures/barcode_weight_fixture.json'), 'utf8'),
);

describe('barcode_weight_fixture.json', () => {
  it('covers every family and shape', () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(40);
    const classes = new Set(fixture.cases.map((c) => c.class));
    for (const c of ['gs31', 'glatt25', 'glatt_units', 'glatt_misread', 'fixture', 'truncated', 'minted_label', 'ean13']) {
      expect(classes.has(c)).toBe(true);
    }
  });

  it.each(fixture.cases.map((c) => [c.barcode || '(empty)', c] as const))('%s', (_label, c) => {
    const bw = barcodeWeight(c.barcode);
    expect(bw?.source ?? null).toBe(c.family);
    expect(bw?.kg ?? null).toBe(c.kg);
    // The 31-digit decoder the reconcile uses says the same.
    if (c.family !== 'glatt25') expect(parseCartonBarcode(c.barcode)?.weight ?? null).toBe(c.kg);
  });

  it.each(fixture.agree_cases.map((a) => [a.ocr_kg, a.barcode_kg, a.agree] as const))(
    'OCR %s vs barcode %s → agree %s',
    (ocr, code, agree) => {
      expect(weightsAgree(ocr, code)).toBe(agree);
    },
  );
});
