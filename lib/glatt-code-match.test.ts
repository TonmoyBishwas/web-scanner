import { describe, it, expect } from 'vitest';
import {
  glattFallbackLines,
  invoiceNameConflict,
  matchGlattItemCode,
  matchInvoiceItem,
  matchInvoiceItemByCode,
  rowCartonCodes,
  type InvoiceItem,
} from './invoice-match';

/**
 * glatt_code_match (11/11). MB Glatt note 261064790 (delivery b860b35c):
 * 14 cartons were booked under another line — the 5-digit item code in the
 * 25-digit Glatt barcode (1 · item 5 · mid 6 · weight 4 · serial 9) never
 * decided, and the box-OCR name named a neighbouring product. The lines and
 * barcodes below are that delivery's (box_inventory / pallet_items).
 */
const GLATT_NOTE: InvoiceItem[] = [
  { item_code: '1510', item_name_hebrew: 'שניצל עוף פרוס 100-מוסדי-קפוא', item_name_english: '' },
  { item_code: '1565', item_name_hebrew: 'שניצל עוף פרוס 120-מוסדי-קפוא', item_name_english: '' },
  { item_code: '5004', item_name_hebrew: 'קציצות בשר 60 גרם', item_name_english: '' },
  { item_code: '5035', item_name_hebrew: 'שניצל עוף אמיתי-120 גרם', item_name_english: '' },
  { item_code: '5045', item_name_hebrew: 'שניצל אמריקאי-מוסדי', item_name_english: '' },
  { item_code: '5075', item_name_hebrew: 'שניצלון הודו-ת. הזנה', item_name_english: '' },
  { item_code: '5086', item_name_hebrew: 'כדורי עוף-ת. הזנה', item_name_english: '' },
];
const line = (code: string) => GLATT_NOTE.find((l) => l.item_code === code)!;

// Real cartons of that delivery.
const C01510 = '1015101100100976069559252'; // booked 1510 (right)
const C01565 = '1015651100101200069572563'; // booked 1565 (right)
const C05035 = '1050351100101011067952479'; // booked 5035 (right)
const C05086_RIGHT = '1050861100101011067939359'; // booked 5086 (right)
const C05086_WRONG = '1050861100101014067939346'; // booked 1510 (wrong)
const C05076_AS_5035 = '1050761100101017067924891'; // no 5076 line; booked 5035 (wrong)

const ON = { glattCodeMatch: true };

describe('glatt_code_match off: exactly as before', () => {
  it('a 05086 carton whose sticker name is the 1510 line goes by the name', () => {
    expect(matchInvoiceItem(line('1510').item_name_hebrew, '', GLATT_NOTE, [C05086_WRONG])?.item_code).toBe('1510');
  });

  it('the short codes never decide by code', () => {
    expect(matchInvoiceItemByCode([C01510], GLATT_NOTE)).toBeNull();
    expect(invoiceNameConflict(line('1510').item_name_hebrew, '', GLATT_NOTE, [C05086_WRONG])).toBeNull();
  });

  it('options without the switch change nothing', () => {
    expect(matchInvoiceItem(line('5035').item_name_hebrew, '', GLATT_NOTE, [C05076_AS_5035], {
      sessionCodes: [C05035],
    })?.item_code).toBe('5035');
  });
});

describe('glatt_code_match on: the Glatt item code decides', () => {
  it('01510 → 1510 (leading zero stripped)', () => {
    expect(matchGlattItemCode([C01510], GLATT_NOTE)?.item_code).toBe('1510');
    expect(matchInvoiceItem('', '', GLATT_NOTE, [C01510], ON)?.item_code).toBe('1510');
  });

  it('05086 → 5086 even when the sticker name is the 1510 line', () => {
    expect(matchInvoiceItem(line('1510').item_name_hebrew, '', GLATT_NOTE, [C05086_WRONG], ON)?.item_code).toBe('5086');
    expect(matchInvoiceItem(line('5086').item_name_hebrew, '', GLATT_NOTE, [C05086_RIGHT], ON)?.item_code).toBe('5086');
  });

  it('a disagreeing name is the soft name conflict, as for long codes', () => {
    const c = invoiceNameConflict(line('1510').item_name_hebrew, '', GLATT_NOTE, [C05086_WRONG], ON);
    expect(c?.byCode.item_code).toBe('5086');
    expect(c?.byName.item_code).toBe('1510');
    expect(invoiceNameConflict(line('5086').item_name_hebrew, '', GLATT_NOTE, [C05086_RIGHT], ON)).toBeNull();
  });

  it('a line code written with its leading zero matches too', () => {
    const zeroed = GLATT_NOTE.map((l) => (l.item_code === '1510' ? { ...l, item_code: '01510' } : l));
    expect(matchInvoiceItem('', '', zeroed, [C01510], ON)?.item_code).toBe('01510');
  });

  it('exact compare only: 5076 never matches 5075, 507 or 50760', () => {
    const near: InvoiceItem[] = [
      { item_code: '5075', item_name_hebrew: 'א', item_name_english: '' },
      { item_code: '507', item_name_hebrew: 'ב', item_name_english: '' },
      { item_code: '50760', item_name_hebrew: 'ג', item_name_english: '' },
    ];
    expect(matchGlattItemCode([C05076_AS_5035], near)).toBeNull();
  });

  it('not a Glatt code (mid not Glatt, wrong length, a 31-digit label) → no Glatt match', () => {
    const badMid = '1050861400201011067939359'; // mid 140020 is not a Glatt mid
    expect(matchGlattItemCode([badMid], GLATT_NOTE)).toBeNull();
    expect(matchGlattItemCode([C05086_RIGHT.slice(0, 24)], GLATT_NOTE)).toBeNull();
    expect(matchGlattItemCode(['7290002195832012570130622102027'], GLATT_NOTE)).toBeNull();
  });

  it("codes naming two different lines → no code match (the names decide)", () => {
    expect(matchGlattItemCode([C01510, C05086_RIGHT], GLATT_NOTE)).toBeNull();
  });

  it('the 12+ digit rule still comes first', () => {
    const lines: InvoiceItem[] = [
      { item_code: '2000097200258', item_name_hebrew: 'קציצות בקר 35 גרם', item_name_english: '' },
      ...GLATT_NOTE,
    ];
    expect(matchInvoiceItem('', '', lines, ['2000097200258'], ON)?.item_code).toBe('2000097200258');
  });

  it("the worker's own choice of product (no own codes) still decides by name", () => {
    expect(matchInvoiceItem(line('1510').item_name_hebrew, '', GLATT_NOTE, [], ON)?.item_code).toBe('1510');
  });
});

describe('glatt_code_match on: a Glatt code on no line falls back by name', () => {
  it('05076 (no 5076 line), no session codes → today’s name ladder', () => {
    expect(matchInvoiceItem(line('5035').item_name_hebrew, '', GLATT_NOTE, [C05076_AS_5035], ON)?.item_code).toBe('5035');
  });

  it('…but never onto a line other cartons in the session carry the Glatt code of', () => {
    const got = matchInvoiceItem(line('5035').item_name_hebrew, '', GLATT_NOTE, [C05076_AS_5035], {
      ...ON, sessionCodes: [C05035, C05076_AS_5035],
    });
    expect(got?.item_code).not.toBe('5035');
  });

  it('with the whole note counted, the only schnitzel line left is 5075', () => {
    const session = [C01510, C01565, C05035, '1050451100101003067880306', C05086_RIGHT];
    expect(matchInvoiceItem(line('1510').item_name_hebrew, '', GLATT_NOTE, [C05076_AS_5035], {
      ...ON, sessionCodes: session,
    })?.item_code).toBe('5075');
  });

  it('every line taken → no line (the raw name is kept)', () => {
    const one: InvoiceItem[] = [line('5035')];
    expect(matchInvoiceItem(line('5035').item_name_hebrew, '', one, [C05076_AS_5035], {
      ...ON, sessionCodes: [C05035],
    })).toBeNull();
  });

  it('the fallback list is untouched when the carton has no Glatt code, or its code has a line', () => {
    expect(glattFallbackLines(['7290002195832012570130622102027'], GLATT_NOTE, { ...ON, sessionCodes: [C05035] })).toBe(GLATT_NOTE);
    expect(glattFallbackLines([C05086_RIGHT], GLATT_NOTE, { ...ON, sessionCodes: [C05035] })).toBe(GLATT_NOTE);
    expect(glattFallbackLines([C05076_AS_5035], GLATT_NOTE, { sessionCodes: [C05035] })).toBe(GLATT_NOTE);
  });
});

describe('rowCartonCodes', () => {
  it("a row's barcode and the supplier code a minted label stands in for", () => {
    expect(rowCartonCodes([
      { barcode: '2826111165320916', source_barcode: C01565 },
      { barcode: C05035 },
      { barcode: '', source_barcode: null },
    ])).toEqual(['2826111165320916', C01565, C05035]);
  });
});
