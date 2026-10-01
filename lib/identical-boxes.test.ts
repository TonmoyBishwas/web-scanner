import { describe, it, expect } from 'vitest';
import { dedupCodes, expandIdenticalBoxes, releasedSources, sourceSku, sourceStillListed } from './identical-boxes';

const sample = {
  barcode: '7290004456825',
  sku: '7290004456825',
  item_name: 'Kebabonim',
  item_name_hebrew: 'קבבונים',
  weight: 5,
  expiry: '2026-12-01',
  production_date: '2026-09-01',
  supplier_batch: '',
  scanned_at: '2026-09-22T10:00:00.000Z',
  image_url: 'https://x/y.jpg',
  image_data: 'data:image/jpeg;base64,AAA',
  needs_review: true as boolean | undefined,
};

const labels = [
  { barcode: '2826092212345678', batch_id: 'b1' },
  { barcode: '2826092287654321', batch_id: 'b1' },
  { barcode: '2826092211112222', batch_id: 'b1' },
];

describe('sourceSku', () => {
  it('is the 13-digit prefix of the digits, or the digits when shorter', () => {
    expect(sourceSku('7290003570867015320158115072027')).toBe('7290003570867');
    expect(sourceSku('7290004456825')).toBe('7290004456825');
    expect(sourceSku('12345678')).toBe('12345678');
    expect(sourceSku('MANUAL-123')).toBe('');
  });
});

describe('expandIdenticalBoxes', () => {
  const rows = expandIdenticalBoxes(sample, labels, { weight: 5.2, expiry: '2026-12-31', production_date: '2026-09-10' });

  it('makes one row per minted label, each with its own barcode', () => {
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.barcode)).size).toBe(3);
    expect(rows.map((r) => r.barcode)).toEqual(labels.map((l) => l.barcode));
  });

  it('keeps the product identity under the supplier sku and marks the rows minted', () => {
    for (const r of rows) {
      expect(r.sku).toBe('7290004456825');
      expect(r.minted).toBe(true);
      expect(r.label_batch_id).toBe('b1');
      expect(r.source_barcode).toBe('7290004456825');
      expect(r.item_name_hebrew).toBe('קבבונים');
      expect(r.image_url).toBe('https://x/y.jpg');
      expect(r.needs_review).toBeUndefined();
    }
  });

  it('takes weight and dates from the form, not the sample', () => {
    for (const r of rows) {
      expect(r.weight).toBe(5.2);
      expect(r.expiry).toBe('2026-12-31');
      expect(r.production_date).toBe('2026-09-10');
    }
  });

  it('keeps the sticker photo on the first row only', () => {
    expect(rows[0].image_data).toBe(sample.image_data);
    expect(rows[1].image_data).toBeUndefined();
    expect(rows[2].image_data).toBeUndefined();
  });
});

describe('dedup bookkeeping for minted rows', () => {
  const SRC = '7290004456825';
  const rows = expandIdenticalBoxes(sample, labels, { weight: 5.2, expiry: '2026-12-31', production_date: '' });
  const other = { barcode: '7290009999999', sku: '7290009999999' };

  it('dedupCodes holds every row barcode plus the supplier code they stand in for', () => {
    expect(dedupCodes([...rows, other]).sort()).toEqual([...labels.map((l) => l.barcode), SRC, other.barcode].sort());
    expect(dedupCodes([other])).toEqual([other.barcode]);
  });

  it('keeps the supplier code while any row still stands in for it', () => {
    expect(releasedSources(rows, new Set([rows[0].barcode]))).toEqual([]);
    expect(releasedSources(rows, new Set([rows[0].barcode, rows[1].barcode]))).toEqual([]);
  });

  it('frees the supplier code when the last row of the batch is deleted (one at a time)', () => {
    // Rows 0 and 1 already deleted; deleting the last one releases the code.
    const left = rows.slice(2);
    expect(releasedSources(left, new Set([left[0].barcode]))).toEqual([SRC]);
    // Or all at once.
    expect(releasedSources(rows, new Set(rows.map((r) => r.barcode)))).toEqual([SRC]);
  });

  it('keeps it while a plain row with that very code, or another batch for it, is listed', () => {
    const last = rows.slice(2);
    expect(releasedSources([...last, { barcode: SRC }], new Set([last[0].barcode]))).toEqual([]);
    const second = expandIdenticalBoxes(sample, [{ barcode: '2826092299990000', batch_id: 'b2' }], {
      weight: 5.2, expiry: '', production_date: '',
    });
    expect(releasedSources([...last, ...second], new Set([last[0].barcode]))).toEqual([]);
    expect(sourceStillListed(second, SRC)).toBe(true);
    expect(sourceStillListed([other], SRC)).toBe(false);
  });

  it('releases nothing for a row that is not minted', () => {
    expect(releasedSources([other], new Set([other.barcode]))).toEqual([]);
  });
});
