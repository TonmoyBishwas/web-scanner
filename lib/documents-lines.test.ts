import { describe, expect, it, vi } from 'vitest';

vi.mock('./supabase', () => ({ supabase: {} }));

const { meatDocumentLine } = await import('./documents');

/** A meat detail line shows its figures in the line's own unit (27/10). */
const row = {
  item_name_hebrew: 'מנה', item_name_english: 'Meal', invoice_qty_kg: 126, invoice_box_count: 7,
  received_qty_kg: 108, received_box_count: 6, discrepancy_status: 'Short', discrepancy_note: null,
};

describe('meatDocumentLine', () => {
  it('a units line (008955) reads in units, short against units', () => {
    const line = meatDocumentLine({ ...row, unit: 'units' });
    expect(line.unit).toBe('units');
    expect(line.invoice_qty).toBe(126);
    expect(line.received_qty).toBe(108);
    expect(line.discrepancy).toBe('Short');
  });

  it('any other line is kg, as before', () => {
    expect(meatDocumentLine({ ...row, unit: 'kg' }).unit).toBe('kg');
    expect(meatDocumentLine({ ...row, unit: null }).unit).toBe('kg');
    expect(meatDocumentLine(row).unit).toBe('kg');
  });

  it('an unflagged line carries no received figures', () => {
    const line = meatDocumentLine({ ...row, unit: 'units', discrepancy_status: 'OK' });
    expect(line.received_qty).toBeNull();
    expect(line.discrepancy).toBeNull();
  });
});
