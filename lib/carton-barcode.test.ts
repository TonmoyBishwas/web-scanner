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
  it('a units line offers no weight: 126 portions / 7 is not 18 kg (note 008955)', () => {
    expect(shortCodeDefaults({ quantity_kg: 126, box_count: 7, unit: 'units' }, 2))
      .toEqual({ weight: null, quantity: 5, lineTotal: 7 });
    expect(shortCodeDefaults({ quantity_kg: 126, box_count: 7, unit_weight_kg: 4, unit: 'units' }, 0).weight).toBeNull();
    // An explicit kg line is the kg path, unchanged.
    expect(shortCodeDefaults({ quantity_kg: 126, box_count: 7, unit: 'kg' }, 0).weight).toBe(18);
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

// ── 01/11, Glatt note 261062322 (session hceJxe4obaK2TgXOdVXfu) ──
import {
  barcodeFormatOk,
  hasCartonCode,
  inboundReadPolicy,
  isGlattMisread,
  looksLikeDamagedGlatt,
  parseGlattCode,
  sameGlattCarton,
  trustedSingleRead,
} from './carton-barcode';

const NOTE_LINES = [{ item_code: '1472' }, { item_code: '1578' }, { item_code: '5086' }];
const VALID_MEATBALL = '1050861100101011067936150';
const VALID_THIGH_A = '1014721100101530065729703';
const VALID_THIGH_B = '1014721100101409065729707';
const DOUBLE_MISREAD = '1050861115101001067936150'; // mid 111510
const REGEX_VALID_MISREADS = ['1006781100101369069565401', '1120671100101720069560708'];
const PHOTO_DIGITS = ['10147211001409065729707', '4721100101530065729703', '10157811001012830565414'];

describe('Glatt mid check (classifyRead)', () => {
  it('refuses a 25-digit 1… read whose mid Glatt never prints, as a misread', () => {
    expect(classifyRead(DOUBLE_MISREAD)).toEqual({ ok: false, reason: 'misread' });
    expect(classifyRead('1050861153020312067935192')).toEqual({ ok: false, reason: 'misread' });
    expect(classifyRead('1014821100022433074260935')).toEqual({ ok: false, reason: 'misread' });
    expect(isGlattMisread(DOUBLE_MISREAD)).toBe(true);
  });

  it('accepts every Glatt mid, the units mid 140010 included', () => {
    for (const code of [VALID_MEATBALL, VALID_THIGH_A, '1023530100101319071320494', '1002721106101527069546340', '1043041400100001178251135']) {
      expect(classifyRead(code)).toEqual({ ok: true });
      expect(isGlattMisread(code)).toBe(false);
    }
  });

  it('leaves other lengths and families alone', () => {
    expect(classifyRead('7290115351484014085456309092027')).toEqual({ ok: true }); // gs31
    expect(classifyRead('2826110119842666')).toEqual({ ok: true }); // minted label
    expect(classifyRead('10508611001010140679351090')).toEqual({ ok: true }); // 26 digits: not this rule
    expect(isGlattMisread('2050861115101001067936150')).toBe(false); // does not start with 1
  });
});

describe('parseGlattCode / sameGlattCarton / hasCartonCode', () => {
  it('parses item, mid and serial', () => {
    expect(parseGlattCode(VALID_MEATBALL)).toEqual({ item: '05086', mid: '110010', weight: '1011', serial: '067936150' });
    expect(parseGlattCode(DOUBLE_MISREAD)).toBeNull();
  });

  it('the photo digits of 01/11 look like damaged Glatt codes; valid codes and other families do not', () => {
    for (const d of PHOTO_DIGITS) expect(looksLikeDamagedGlatt(d)).toBe(true);
    expect(looksLikeDamagedGlatt(VALID_THIGH_A)).toBe(false);
    expect(looksLikeDamagedGlatt('729011535148401502521600802027')).toBe(false);
    expect(looksLikeDamagedGlatt('7290115351484014085456309092027')).toBe(false);
  });

  it('one carton: a valid code and a damaged one sharing weight + serial (last 13), or two valid codes sharing the serial', () => {
    expect(sameGlattCarton(VALID_THIGH_A, '4721100101530065729703')).toBe(true);
    expect(sameGlattCarton('10147211001409065729707', VALID_THIGH_B)).toBe(true);
    expect(sameGlattCarton('1015781100101369069565401', REGEX_VALID_MISREADS[0])).toBe(true);
  });

  it('a damaged string matching only the 9-digit serial is NOT the same carton (review 01/11)', () => {
    // The double misread hit the weight digits too: refused anyway, no match needed.
    expect(sameGlattCarton(VALID_MEATBALL, DOUBLE_MISREAD)).toBe(false);
    // Another item's damaged string, or an unrelated 24-digit 1… string, ending in the same serial.
    expect(sameGlattCarton(VALID_THIGH_A, '109999110010999065729703')).toBe(false);
    expect(sameGlattCarton(VALID_THIGH_A, '100000000000000065729703')).toBe(false);
    // Photo digits of carton …703 whose serial was misread as its neighbour …707:
    // the neighbour's real carton (14.09 kg) is not "already counted".
    expect(sameGlattCarton('4721100101530065729707', VALID_THIGH_B)).toBe(false);
    expect(hasCartonCode(new Set(['4721100101530065729707']), VALID_THIGH_B)).toBe(false);
  });

  it('never matches two damaged strings, two serials, or non-Glatt codes', () => {
    expect(sameGlattCarton(VALID_THIGH_A, VALID_THIGH_B)).toBe(false);
    expect(sameGlattCarton('4721100101530065729703', '9994721100101530065729703')).toBe(false);
    expect(sameGlattCarton('7290115351484014085456309092027', '1014721100101530085456309092027')).toBe(false);
    expect(sameGlattCarton(VALID_THIGH_A, '')).toBe(false);
  });

  it('hasCartonCode: the exact code, or the same Glatt carton', () => {
    const listed = new Set(['4721100101530065729703', '7290115351484014085456309092027']);
    expect(hasCartonCode(listed, VALID_THIGH_A)).toBe(true);
    expect(hasCartonCode(listed, '7290115351484014085456309092027')).toBe(true);
    expect(hasCartonCode(listed, VALID_THIGH_B)).toBe(false);
    expect(hasCartonCode(listed, '')).toBe(false);
  });
});

describe('trustedSingleRead / inboundReadPolicy', () => {
  // Cartons of this note already counted (session hceJxe4obaK2TgXOdVXfu neighbours).
  const MEATBALLS = ['1050861100101012067936148', '1050861100101013067936149', '1050861100101010067936151'];
  const THIGHS = ['1014721100101420065729702', '1014721100101455065729704', '1014721100101399065729705'];
  const anchors = [...MEATBALLS, ...THIGHS];
  // Read once in session LGUtpTw2 for the real 1050861100101014067935118:
  // valid mid, item on the note, serial 33 000 from any meatball carton, 8.14 kg.
  const PHANTOM = '1050861100100814067902118';

  it('trusts a valid Glatt code of a note line next to a counted carton of its item (zeros ignored)', () => {
    expect(trustedSingleRead(VALID_MEATBALL, NOTE_LINES, { anchors })).toBe(true);
    expect(trustedSingleRead(VALID_THIGH_A, NOTE_LINES, { anchors })).toBe(true);
    expect(trustedSingleRead(VALID_THIGH_A, [{ item_code: '01472' }], { anchors })).toBe(true);
  });

  it('the first carton of an item needs two reads, unless another waiting read shares its serial', () => {
    expect(trustedSingleRead(VALID_MEATBALL, NOTE_LINES)).toBe(false);
    expect(trustedSingleRead(VALID_MEATBALL, NOTE_LINES, { anchors: THIGHS })).toBe(false);
    expect(trustedSingleRead(VALID_MEATBALL, NOTE_LINES, { pending: [DOUBLE_MISREAD] })).toBe(true);
    expect(trustedSingleRead(VALID_MEATBALL, NOTE_LINES, { pending: ['7290115351484014085456309092027'] })).toBe(false);
  });

  it('does not trust a serial misread: far from every carton of its item, or the wrong weight', () => {
    expect(trustedSingleRead(PHANTOM, NOTE_LINES, { anchors })).toBe(false);
    // Even right next to a counted serial, 8.14 kg is 20 % off meatballs' ~10.12 kg.
    const near = [...anchors, '1050861100101012067902120'];
    expect(trustedSingleRead(PHANTOM, NOTE_LINES, { anchors: near })).toBe(false);
    // The note line's kg per carton, when known, is the typical weight.
    expect(trustedSingleRead(VALID_MEATBALL, [{ item_code: '5086', quantity_kg: 160, expected_boxes: 20 }], { anchors })).toBe(false);
    expect(trustedSingleRead(VALID_MEATBALL, [{ item_code: '5086', quantity_kg: 202, expected_boxes: 20 }], { anchors })).toBe(true);
  });

  it('does not trust the regex-valid misreads (items 00678 / 12067 are on no line)', () => {
    for (const v of REGEX_VALID_MISREADS) expect(trustedSingleRead(v, NOTE_LINES, { anchors })).toBe(false);
  });

  it('does not trust a misread mid, a 31-digit code, or anything without note lines', () => {
    expect(trustedSingleRead(DOUBLE_MISREAD, NOTE_LINES, { anchors })).toBe(false);
    expect(trustedSingleRead('7290115351484014085456309092027', [{ item_code: '7290115351484' }], { anchors })).toBe(false);
    expect(trustedSingleRead(VALID_MEATBALL, [], { anchors })).toBe(false);
    expect(trustedSingleRead(VALID_MEATBALL, null, { anchors })).toBe(false);
  });

  it('policy: ignore a misread mid; trust a corroborated note carton once; a carton already listed needs two reads', () => {
    const listed = new Set<string>(anchors);
    const policy = inboundReadPolicy(() => NOTE_LINES, () => listed);
    expect(policy(DOUBLE_MISREAD)).toBe('ignore');
    expect(policy(VALID_MEATBALL)).toBe('trust');
    expect(policy(PHANTOM)).toBeUndefined();
    expect(policy(REGEX_VALID_MISREADS[0])).toBeUndefined();
    expect(policy('7290115351484014085456309092027')).toBeUndefined();
    listed.add(VALID_MEATBALL);
    expect(policy(VALID_MEATBALL)).toBeUndefined();
    listed.add('4721100101530065729703');
    expect(policy(VALID_THIGH_A)).toBeUndefined(); // same carton by weight + serial
    // Session anchors (other pallets) vouch even when this pallet's list is empty.
    const empty = new Set<string>();
    const p2 = inboundReadPolicy(() => NOTE_LINES, () => empty, () => anchors);
    expect(p2(VALID_THIGH_B)).toBe('trust');
    expect(inboundReadPolicy(() => NOTE_LINES, () => empty)(VALID_THIGH_B)).toBeUndefined();
    // The confirmer's other waiting reads.
    expect(inboundReadPolicy(() => NOTE_LINES, () => empty)(VALID_MEATBALL, { pending: [DOUBLE_MISREAD] })).toBe('trust');
  });
});

describe('barcodeFormatOk (silent check, sent to the bot)', () => {
  it('true for valid codes of every family', () => {
    for (const c of [VALID_MEATBALL, '1043041400100001178251135', '7290115351484014085456309092027', '7290004456825', '2000090300667', '72900000001011500004301120260001']) {
      expect(barcodeFormatOk(c)).toBe(true);
    }
  });

  it('false for the 01/11 photo digits, misread mids and shortened 729 codes', () => {
    for (const d of PHOTO_DIGITS) expect(barcodeFormatOk(d)).toBe(false);
    expect(barcodeFormatOk(DOUBLE_MISREAD)).toBe(false);
    expect(barcodeFormatOk('105045110010101606788245')).toBe(false);
    expect(barcodeFormatOk('729011535148401502521600802027')).toBe(false);
    expect(barcodeFormatOk('7290001456825')).toBe(false); // check digit
  });

  it('null when there is nothing to check', () => {
    expect(barcodeFormatOk('')).toBeNull();
    expect(barcodeFormatOk(null)).toBeNull();
    expect(barcodeFormatOk('408274')).toBeNull(); // a photo-confirmed serial
  });
});
