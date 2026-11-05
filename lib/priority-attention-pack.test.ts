import { describe, expect, it } from 'vitest';
import { fixLineText, groupFixLines, HIDDEN_UNIT_RISKS, visibleFixLine, type GapLine } from './priority-attention';

// Item 7 (pack table, 2026-11-04): the bot's explain() may add a line as
// unit_risk 'pack_not_converted' (priority_push_config.pack_table_check on).
// It has no approved wording yet, so the page never shows the raw code and
// leaves out a line listed only because of it.
// English: Hebrew test data: חומצה אצתית = "acetic acid"; וופל = "wafer"
describe('pack_not_converted is hidden on the attention page', () => {
  const line = (over: Partial<GapLine> = {}): GapLine => ({
    delivery_id: 'd1', document_number: '2607434', supplier: 'ספק', code: '250401', name: 'חומצה אצתית', // English: supplier, acetic acid
    invoice_qty: 4, received_qty: 4, unit: 'units', gap_reason: null, gap_note: null, rest_expected: null,
    count_source: 'counted', gr_docno: 'GR26000140', unit_risk: 'pack_not_converted', item_not_linked: false,
    discrepancy_status: 'None', ...over,
  });

  it('the kind is in the hidden set', () => {
    expect(HIDDEN_UNIT_RISKS.has('pack_not_converted')).toBe(true);
    expect(HIDDEN_UNIT_RISKS.has('packs_not_units')).toBe(false);
  });

  it('a line listed only because of it is left out', () => {
    expect(visibleFixLine(line())).toBeNull();
    expect(groupFixLines([line()])).toEqual([]);
  });

  it('a line with another reason stays, without the note', () => {
    for (const over of [
      { discrepancy_status: 'Short', received_qty: 3 },
      { count_source: 'invoice_assumed' },
      { gap_reason: 'supplier_short' },
      { rest_expected: 'will_come' },
      { item_not_linked: true },
      { discrepancy_status: undefined },
    ] as Partial<GapLine>[]) {
      const shown = visibleFixLine(line(over));
      expect(shown).not.toBeNull();
      expect(shown!.unit_risk).toBeNull();
      expect(fixLineText(shown!)).not.toContain('pack_not_converted');
      expect(fixLineText(shown!)).not.toContain('unit risk');
    }
  });

  it('fixLineText never prints the raw code, even when handed the raw row', () => {
    expect(fixLineText(line({ discrepancy_status: 'Short' }))).not.toContain('pack_not_converted');
  });

  it('other kinds are untouched', () => {
    const wafer = line({ code: '220102', name: 'וופל', unit: 'cartons', unit_risk: 'packs_not_units' }); // English: wafer
    expect(visibleFixLine(wafer)).toBe(wafer);
    expect(fixLineText(wafer)).toContain('unit risk: counted in cartons or packs, not single units');
    const out = groupFixLines([line(), wafer]);
    expect(out).toHaveLength(1);
    expect(out[0].lines.map((l) => l.code)).toEqual(['220102']);
  });
});
