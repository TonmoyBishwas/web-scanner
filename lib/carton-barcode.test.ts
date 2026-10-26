import { describe, it, expect } from 'vitest';
import { classifyRead, digitsOf, gtinCheckDigitValid, isInHouseCode, isIsraeliGtinPrefixed, labelConfirmsShortCode, matchInvoiceShortCode, noteRepeatedRead, printedDigitsIdentifyCarton, shortCodeDefaults } from './carton-barcode';

describe('carton-barcode', () => {
  it('digitsOf strips everything but digits', () => {
    expect(digitsOf(' 7290004456825 ')).toBe('7290004456825');
    expect(digitsOf(null)).toBe('');
  });

  it('GTIN check digit: the real kebabonim code passes, the misread fails', () => {
    expect(gtinCheckDigitValid('7290004456825')).toBe(true);   // the paper
    expect(gtinCheckDigitValid('7290001456825')).toBe(false);  // 4 → 1 misread
    expect(gtinCheckDigitValid('7290003570867')).toBe(true);
    expect(gtinCheckDigitValid('7290003670338')).toBe(true);
    expect(gtinCheckDigitValid('12345678')).toBe(false);
  });

  it('classifyRead refuses fragments and bad checksums, accepts GS1-128', () => {
    expect(classifyRead('15928481')).toEqual({ ok: false, reason: 'too_short' });
    expect(classifyRead('7290001456825')).toEqual({ ok: false, reason: 'checksum' });
    expect(classifyRead('7290004456825')).toEqual({ ok: true });
    // Baladi's shipping-pallet label: pallet identity, never a carton (MEV-10).
    expect(classifyRead('1000000000513550')).toEqual({ ok: false, reason: 'pallet_label' });
    expect(classifyRead('1000000000529677')).toEqual({ ok: false, reason: 'pallet_label' });
    expect(classifyRead('1000000000513')).toEqual({ ok: false, reason: 'checksum' });
    expect(classifyRead('7290003570867015320158115072027')).toEqual({ ok: true });
    // A warehouse-minted label (28 + YYMMDD + 8 digits) is 16 digits: accepted.
    expect(classifyRead('2826091622630531')).toEqual({ ok: true });
  });

  it('an in-house (prefix 2) 13-digit label is taken as printed (IN264175143, 2026-09-23)', () => {
    expect(gtinCheckDigitValid('2000090300667')).toBe(false); // GS1 says 8, Baladi prints 7
    expect(isInHouseCode('2000090300667')).toBe(true);
    expect(classifyRead('2000090300667')).toEqual({ ok: true });
    // A 729… (Israel GS1) misread is still refused.
    expect(isInHouseCode('7290001456825')).toBe(false);
    expect(classifyRead('7290001456825')).toEqual({ ok: false, reason: 'checksum' });
  });

  it('the same refused digits on a third capture are accepted', () => {
    const counts = new Map<string, number>();
    expect(noteRepeatedRead(counts, '7290001456825')).toBe(false);
    expect(noteRepeatedRead(counts, '7290001456825')).toBe(false);
    expect(noteRepeatedRead(counts, '7290001456825')).toBe(true);
    expect(noteRepeatedRead(counts, '7290001456826')).toBe(false);
  });

  it('SCN-13: a read with anything but digits is refused (2026-10-04 phantom 7290115351084)', () => {
    expect(classifyRead('729011535108401430767802907229:')).toEqual({ ok: false, reason: 'not_digits' });
    expect(classifyRead('7290004456825X')).toEqual({ ok: false, reason: 'not_digits' });
    expect(classifyRead('IN264184055')).toEqual({ ok: false, reason: 'not_digits' });
    expect(classifyRead('https://x.test/sticker/v1/LPN-20261004-IN264178-P1?sig=123456')).toEqual({ ok: false, reason: 'not_digits' });
    // Surrounding whitespace is not part of the read.
    expect(classifyRead(' 7290004456825 ')).toEqual({ ok: true });
  });

  it('SCN-13: a 15+ digit 729… read must start with a valid GTIN-13', () => {
    // Shifted read of 7290115351484… (2026-10-04, phantom box_sku 7290103514840).
    expect(classifyRead('729010351484015205456509092027')).toEqual({ ok: false, reason: 'checksum' });
    // The real labels pass (31-digit catch-weight codes seen in box_inventory).
    expect(classifyRead('7290115351484014307678029072029')).toEqual({ ok: true });
    expect(classifyRead('7290003570867015320158115072027')).toEqual({ ok: true });
    expect(classifyRead('7290002195832012340000101102026')).toEqual({ ok: true });
  });

  it('SCN-13: the zero-padded 7290000… supplier codes and other prefixes are untouched', () => {
    // Invoices 251068506 / 251068650: 7290000 + item 101 / 2283 / 550 — no valid check digit, real.
    expect(gtinCheckDigitValid('7290000000101')).toBe(false);
    expect(isIsraeliGtinPrefixed('72900000001011548304301120260003')).toBe(false);
    expect(classifyRead('72900000001011548304301120260003')).toEqual({ ok: true });
    expect(classifyRead('72900000022831976674301120260003')).toEqual({ ok: true });
    expect(classifyRead('7290000000550010000041220260001')).toEqual({ ok: true });
    // 10… and minted 28… codes keep the old rule (accepted at 15+ digits).
    expect(classifyRead('10147211001010123456789')).toEqual({ ok: true });
    expect(classifyRead('2826091622630531')).toEqual({ ok: true });
  });
});

describe('matchInvoiceShortCode (IN26013461, 2026-10-15)', () => {
  const lines = [
    { item_code: '300', item_name_hebrew: 'פלאפל', quantity_kg: 620, box_count: 62 },
    { item_code: '501004', item_name_hebrew: 'שניצל תירס', quantity_kg: 100, box_count: 10 },
  ];

  it('matches the exact item code', () => {
    expect(matchInvoiceShortCode('501004', lines)?.item_name_hebrew).toBe('שניצל תירס');
  });

  it('matches with leading zeros on either side', () => {
    expect(matchInvoiceShortCode('0501004', lines)?.item_code).toBe('501004');
    expect(matchInvoiceShortCode('501004', [{ item_code: '00501004' }])?.item_code).toBe('00501004');
  });

  it('refuses fragments that are not an item code', () => {
    expect(matchInvoiceShortCode('15928481', lines)).toBeNull();
    expect(matchInvoiceShortCode('50100', lines)).toBeNull();
  });

  it('needs at least 4 digits, also after stripping zeros', () => {
    expect(matchInvoiceShortCode('300', lines)).toBeNull();
    expect(matchInvoiceShortCode('0300', lines)).toBeNull();
  });

  it('refuses non-digits and empty input', () => {
    expect(matchInvoiceShortCode('5010a4', lines)).toBeNull();
    expect(matchInvoiceShortCode('', lines)).toBeNull();
    expect(matchInvoiceShortCode('501004', null)).toBeNull();
  });

  it('matches a supplier code field when present', () => {
    expect(matchInvoiceShortCode('7788', [{ item_code: 'G17015', supplier_code: '7788' }])?.item_code).toBe('G17015');
  });

  it('two different items with the same code are ambiguous', () => {
    expect(matchInvoiceShortCode('5010', [{ item_code: '5010' }, { item_code: '005010', supplier_code: 'x' }])).not.toBeNull();
    expect(matchInvoiceShortCode('7788', [
      { item_code: 'A1', supplier_code: '7788' },
      { item_code: 'B2', supplier_code: '7788' },
    ])).toBeNull();
  });

  it('the same item on two lines (multi-invoice) still matches', () => {
    expect(matchInvoiceShortCode('501004', [{ item_code: '501004' }, { item_code: '501004' }])?.item_code).toBe('501004');
  });
});

describe('shortCodeDefaults', () => {
  it('weight per carton = kg / cartons; count = cartons still to count', () => {
    expect(shortCodeDefaults({ quantity_kg: 100, box_count: 10 }, 0)).toEqual({ weight: 10, quantity: 10, lineTotal: 10 });
    expect(shortCodeDefaults({ quantity_kg: 100, box_count: 10 }, 4)).toEqual({ weight: 10, quantity: 6, lineTotal: 10 });
  });
  it('unit weight wins; at least 1 carton; no weight when not derivable', () => {
    expect(shortCodeDefaults({ quantity_kg: 100, box_count: 10, unit_weight_kg: 8 }, 0).weight).toBe(8);
    expect(shortCodeDefaults({ quantity_kg: 100, box_count: 10 }, 12).quantity).toBe(1);
    expect(shortCodeDefaults({ quantity_kg: 100 }, 0)).toEqual({ weight: null, quantity: 1, lineTotal: null });
    expect(shortCodeDefaults({ quantity_kg: 10, box_count: 3 }, 0).weight).toBe(3.333);
  });
  it('a line that may sit on other pallets / loose / earlier labels defaults to 1, total only as a hint', () => {
    // 80 cartons over 2 pallets: pallet 2's empty list must not offer 80 again.
    expect(shortCodeDefaults({ quantity_kg: 800, box_count: 80 }, 0, { lineMaySpread: true }))
      .toEqual({ weight: 10, quantity: 1, lineTotal: 80 });
    expect(shortCodeDefaults({ quantity_kg: 800, box_count: 80 }, 0, { lineMaySpread: false }).quantity).toBe(80);
  });
});

describe('labelConfirmsShortCode (Wall Dan 48534, 2026-10-25)', () => {
  // Wall Dan prints a 6-digit running serial per carton; the decoder read
  // 408274 and the label photo read 408274 under the bars.
  const lines = [
    { item_code: '501004' },
    { item_code: '1200' },
  ];
  // Well Done 48288 (11/10): `020926` is a fragment of this 30-digit code.
  const SOKOLOW = '388432467020926171026048702036';
  // A 30-digit catch-weight code that carries `15928481` (IN264171048).
  const CATCH_WEIGHT = '729000357086701592848115072027';

  it('the decoder and the label agree on a 6-digit serial → confirmed', () => {
    expect(labelConfirmsShortCode('408274', new Set(['408274']), lines, [])).toBe(true);
    expect(labelConfirmsShortCode('399577', new Set(['408274', '399577']), lines, ['408274'])).toBe(true);
  });

  it('the decoder never read that code on this page → not confirmed', () => {
    expect(labelConfirmsShortCode('408274', new Set(['408215']), lines, [])).toBe(false);
    expect(labelConfirmsShortCode('408274', new Set(), lines, [])).toBe(false);
  });

  it('a fragment of a long code: the label prints the long code → not confirmed', () => {
    expect(labelConfirmsShortCode(SOKOLOW, new Set(['020926']), lines, [])).toBe(false);
    expect(labelConfirmsShortCode('7290003570867015928481150720277', new Set(['15928481']), lines, [])).toBe(false);
  });

  it('a short code a long code on the list carries → not confirmed', () => {
    expect(labelConfirmsShortCode('020926', new Set(['020926']), lines, [SOKOLOW])).toBe(false);
    expect(labelConfirmsShortCode('15928481', new Set(['15928481']), lines, [CATCH_WEIGHT])).toBe(false);
  });

  it('an invoice item code keeps its New-carton route → not confirmed', () => {
    expect(labelConfirmsShortCode('501004', new Set(['501004']), lines, [])).toBe(false);
  });

  it('fewer than 6 or more than 11 digits, or not digits → not confirmed', () => {
    expect(labelConfirmsShortCode('24755', new Set(['24755']), lines, [])).toBe(false);
    expect(labelConfirmsShortCode('40827400011', new Set(['40827400011']), lines, [])).toBe(true);
    expect(labelConfirmsShortCode('408274000112', new Set(['408274000112']), lines, [])).toBe(false);
    expect(labelConfirmsShortCode('4082a4', new Set(['4082a4']), lines, [])).toBe(false);
    expect(labelConfirmsShortCode('', new Set(['']), lines, [])).toBe(false);
  });
});

describe('printedDigitsIdentifyCarton', () => {
  it('13+ printed digits identify the carton as before', () => {
    expect(printedDigitsIdentifyCarton('7290003570867015320158115072027', new Set(), [], [])).toBe(true);
    expect(printedDigitsIdentifyCarton('7290004456825', new Set(), [], [])).toBe(true);
  });

  it('a short serial only when the decoder confirmed it', () => {
    expect(printedDigitsIdentifyCarton('408274', new Set(['408274']), [], [])).toBe(true);
    expect(printedDigitsIdentifyCarton('408274', new Set(), [], [])).toBe(false);
  });

  it('nothing read → not identified', () => {
    expect(printedDigitsIdentifyCarton('', new Set(['']), [], [])).toBe(false);
  });
});
