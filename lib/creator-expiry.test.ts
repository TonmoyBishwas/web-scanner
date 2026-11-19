import { describe, expect, it } from 'vitest';
import { creatorExpiryPrefill, type ExpiryRow } from './creator-expiry';

const TODAY = '2026-11-18';
const LINES = [
  { item_code: '1001', item_name_hebrew: 'שוקיים עוף', item_name_english: 'Chicken drumsticks' },
  { item_code: '1002', item_name_hebrew: 'חזה עוף', item_name_english: 'Chicken breast' },
];
let n = 0;
const row = (name: string, expiry: string, extra: Partial<ExpiryRow> = {}): ExpiryRow => ({
  barcode: `B${++n}`, item_name_hebrew: name, item_name: '', expiry, ...extra,
});

describe('creatorExpiryPrefill (creator_expiry_prefill, 18/11)', () => {
  it("the most common expiry among the item's cartons", () => {
    const rows = [
      row('שוקיים עוף', '2026-12-01'),
      row('שוקיים עוף', '2026-12-05'),
      row('שוקיים עוף', '2026-12-05'),
    ];
    expect(creatorExpiryPrefill('1001', rows, LINES, TODAY)).toBe('2026-12-05');
  });

  it("only that item's cartons count", () => {
    const rows = [
      row('שוקיים עוף', '2026-12-01'),
      row('חזה עוף', '2026-12-09'),
      row('חזה עוף', '2026-12-09'),
    ];
    expect(creatorExpiryPrefill('1001', rows, LINES, TODAY)).toBe('2026-12-01');
    expect(creatorExpiryPrefill('1002', rows, LINES, TODAY)).toBe('2026-12-09');
  });

  it('a tie goes to the expiry of the carton scanned last', () => {
    const rows = [
      row('שוקיים עוף', '2026-12-05', { scanned_at: '2026-11-18T08:00:00Z' }),
      row('שוקיים עוף', '2026-12-01', { scanned_at: '2026-11-18T08:10:00Z' }),
    ];
    expect(creatorExpiryPrefill('1001', rows, LINES, TODAY)).toBe('2026-12-01');
    // Scan time wins over list order.
    expect(creatorExpiryPrefill('1001', [...rows].reverse(), LINES, TODAY)).toBe('2026-12-01');
  });

  it('a tie with no scan times goes to the later row on the list', () => {
    const rows = [row('שוקיים עוף', '2026-12-05'), row('שוקיים עוף', '2026-12-01')];
    expect(creatorExpiryPrefill('1001', rows, LINES, TODAY)).toBe('2026-12-01');
  });

  it('one invoice line: every carton on the list is that item', () => {
    const one = [LINES[0]];
    expect(creatorExpiryPrefill('1001', [row('', '2026-12-03')], one, TODAY)).toBe('2026-12-03');
  });

  it('a sticker date (D/M/YYYY) is given back as ISO', () => {
    expect(creatorExpiryPrefill('1001', [row('שוקיים עוף', '3/12/2026')], LINES, TODAY)).toBe('2026-12-03');
  });

  it('never an expiry the form would refuse: today or earlier, or not after the production date', () => {
    const rows = [
      row('שוקיים עוף', TODAY),
      row('שוקיים עוף', '2026-11-01'),
      row('שוקיים עוף', '2026-12-10', { production_date: '2026-12-10' }),
      row('שוקיים עוף', '2026-12-20'),
    ];
    expect(creatorExpiryPrefill('1001', rows, LINES, TODAY)).toBe('2026-12-20');
  });

  it('nothing usable: null (the field opens blank)', () => {
    expect(creatorExpiryPrefill('1001', [], LINES, TODAY)).toBeNull();
    expect(creatorExpiryPrefill('1001', [row('שוקיים עוף', '')], LINES, TODAY)).toBeNull();
    expect(creatorExpiryPrefill('1001', [row('שוקיים עוף', 'soon')], LINES, TODAY)).toBeNull();
    expect(creatorExpiryPrefill('', [row('שוקיים עוף', '2026-12-05')], LINES, TODAY)).toBeNull();
    expect(creatorExpiryPrefill('1001', [row('שוקיים עוף', '2026-12-05')], [], TODAY)).toBeNull();
  });
});
