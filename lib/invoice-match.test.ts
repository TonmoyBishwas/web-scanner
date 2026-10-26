import { describe, it, expect } from 'vitest';
import { cartonOwnCodes, matchInvoiceItem, matchInvoiceItemByCode, invoiceNameConflict, type InvoiceItem } from './invoice-match';

// Invoice 12083843 (Netto Melinda, 2026-10-04): the invoice names the
// product one way ("... תפ לנדא"), the carton sticker another, led by a
// brand ("אחדות ..."). 3 breast cartons + 1 thigh carton were left on no
// invoice line, so Priority would have been told 0 kg of breast.
const NETTO: InvoiceItem[] = [
  { item_code: '34867', item_name_hebrew: 'חזה עוף גדול תפ לנדא', item_name_english: '' },
  { item_code: '34884', item_name_hebrew: 'שוקיים גדול תפ לנדא', item_name_english: '' },
  { item_code: '88000', item_name_hebrew: 'הובלה', item_name_english: '' },
  { item_code: '90004', item_name_hebrew: 'משטחי עץ', item_name_english: '' },
];

describe('matchInvoiceItem — brand-led sticker names', () => {
  it('matches a brand-led breast sticker to the breast line', () => {
    expect(matchInvoiceItem('אחדות חזה עוף גדול קפוא', '', NETTO)?.item_code).toBe('34867');
  });

  it("matches a brand-led thigh sticker to the thigh line", () => {
    expect(matchInvoiceItem("אחדות שוקיים ג'ל", '', NETTO)?.item_code).toBe('34884');
  });

  it('still matches the exact invoice name', () => {
    expect(matchInvoiceItem('שוקיים גדול תפ לנדא', '', NETTO)?.item_code).toBe('34884');
  });

  it('does not snap a different species onto the line', () => {
    const only = [{ item_code: '1', item_name_hebrew: 'חזה עוף גדול', item_name_english: '' }];
    expect(matchInvoiceItem('אחדות חזה הודו', '', only)).toBeNull();
  });

  it('does not snap frozen onto a fresh line', () => {
    const only = [{ item_code: '1', item_name_hebrew: 'חזה עוף טרי', item_name_english: '' }];
    expect(matchInvoiceItem('אחדות חזה עוף קפוא', '', only)).toBeNull();
  });

  it('refuses when the shared words point at two lines', () => {
    const two: InvoiceItem[] = [
      { item_code: 'a', item_name_hebrew: 'חזה עוף שלם', item_name_english: '' },
      { item_code: 'b', item_name_hebrew: 'שוקיים עוף', item_name_english: '' },
    ];
    // "חזה" points at a, "שוקיים" at b: ambiguous → no match.
    expect(matchInvoiceItem('אחדות חזה ושוקיים', '', two)).toBeNull();
  });

  it('does not match on a word every line shares', () => {
    const two: InvoiceItem[] = [
      { item_code: 'a', item_name_hebrew: 'כנפיים עוף', item_name_english: '' },
      { item_code: 'b', item_name_hebrew: 'כבד עוף', item_name_english: '' },
    ];
    expect(matchInvoiceItem('אחדות עוף מעורב', '', two)).toBeNull();
  });

  // IN264172698 (2026-10): fish cartons the old ladder left unmatched.
  const FISH: InvoiceItem[] = [
    { item_code: '7290002195832', item_name_hebrew: "פרגית קפוא תפז' עדה החרדית", item_name_english: '' },
    { item_code: '90500010', item_name_hebrew: 'סלמון פילה פרימיום 1.8-2.2 ק"ג -ללא קשקשים- בד"ץ עדה חרדית', item_name_english: '' },
    { item_code: '90500090', item_name_hebrew: 'אמנון פילה 3-5 תפזורת - בד"ץ עדה חרדית', item_name_english: '' },
  ];

  it('a shared "frozen" does not make a fish sticker ambiguous', () => {
    expect(matchInvoiceItem('פילה סלמון עם עור קפוא', '', FISH)?.item_code).toBe('90500010');
    expect(
      matchInvoiceItem('פילה אמנון עם עור קפוא בציפוי קרח מכיל לפחות 80% דג', '', FISH)?.item_code,
    ).toBe('90500090');
  });

  // IN264184055 (Baladi, 2026-10-07): the invoice misspells the product
  // "שינצלון" (two letters swapped); the sticker prints "שניצלון". 33 cartons
  // matched no line, so Priority got the line with no item code.
  const BALADI: InvoiceItem[] = [
    { item_code: '01135702', item_name_hebrew: 'טחון חזה הודו 500 גרם ארוז - בד"ץ העדה החרדית', item_name_english: '' },
    { item_code: '7290003670383', item_name_hebrew: 'שניצל עוף 150 קפוא תפזורת - בד"ץ העדה החרדית', item_name_english: '' },
    { item_code: '90300680', item_name_hebrew: 'שינצלון הודו זיווגו - מילגם - בד"ץ עדה חרדית', item_name_english: '' },
  ];

  it('matches a word whose two neighbouring letters are swapped', () => {
    expect(matchInvoiceItem('שניצלון הודו בציפוי פירורי לחם', '', BALADI)?.item_code).toBe('90300680');
  });

  it('does not stretch a short word to a neighbouring spelling', () => {
    const two: InvoiceItem[] = [
      { item_code: 'a', item_name_hebrew: 'חזה עוף', item_name_english: '' },
      { item_code: 'b', item_name_hebrew: 'כרעיים עוף', item_name_english: '' },
    ];
    // "זחה" is "חזה" with a swap, but 3-letter words get no tolerance.
    expect(matchInvoiceItem('זחה מיוחד', '', two)).toBeNull();
  });

  it('a swap tolerance does not turn a longer word into a shorter one', () => {
    const only = [{ item_code: '1', item_name_hebrew: 'שניצל עוף 150', item_name_english: '' }];
    expect(matchInvoiceItem('שניצלון הודו', '', only)).toBeNull();
  });
});

// IN264191356 (19/10): a photo of a meatball carton read the meatball line's
// own code and the kebab sticker's name beside it; the name ladder snapped it
// to kebab and 7 meatball labels were minted as kebab.
const GOURMET: InvoiceItem[] = [
  { item_code: '7290004456856', item_name_hebrew: 'קבב מוסדי 8 קג - גורמה העדה החרדית', item_name_english: 'Frozen kebab 8g' },
  { item_code: '2000097200258', item_name_hebrew: 'קציצות בקר 35 גרם', item_name_english: 'Beef meatballs 35g' },
  { item_code: '7290006289360', item_name_hebrew: 'שוקיים וול דאן בדץ', item_name_english: '' },
  { item_code: '501004', item_name_hebrew: 'כנפיים', item_name_english: '' },
];

describe('matchInvoiceItem — the carton code comes first (19/10)', () => {
  it('names alone snap the kebab name to the kebab line (unchanged)', () => {
    expect(matchInvoiceItem('קבב -גורמה', '', GOURMET)?.item_code).toBe('7290004456856');
  });

  it("the carton's own code wins over the name read beside it", () => {
    expect(matchInvoiceItem('קבב -גורמה', '', GOURMET, ['2000097200258'])?.item_code).toBe('2000097200258');
  });

  it('a code that is the GS1 prefix of a 31-digit label counts', () => {
    expect(matchInvoiceItem('', '', GOURMET, ['7290006289360012350128430052027'])?.item_code).toBe('7290006289360');
  });

  it('no code on the invoice in the barcode → the name ladder as before', () => {
    expect(matchInvoiceItem('שוקיים', '', GOURMET, ['7290002195832012350128430052027'])?.item_code).toBe('7290006289360');
  });

  it('a short item code is never looked for inside a barcode', () => {
    expect(matchInvoiceItemByCode(['5010041234567'], GOURMET)).toBeNull();
  });

  it('two different lines that both fit → no code match', () => {
    const lines: InvoiceItem[] = [
      { item_code: '729000445685', item_name_hebrew: 'א', item_name_english: '' },
      { item_code: '7290004456856', item_name_hebrew: 'ב', item_name_english: '' },
    ];
    expect(matchInvoiceItemByCode(['7290004456856'], lines)).toBeNull();
  });

  it('empty / provisional codes are ignored', () => {
    expect(matchInvoiceItemByCode(['', null, undefined, 'MANUAL-17-abc'], GOURMET)).toBeNull();
  });
});

describe('invoiceNameConflict', () => {
  it('code says meatballs, name says kebab → both lines', () => {
    const c = invoiceNameConflict('קבב -גורמה', '', GOURMET, ['2000097200258']);
    expect(c?.byCode.item_code).toBe('2000097200258');
    expect(c?.byName.item_code).toBe('7290004456856');
  });

  it('code and name agree → null', () => {
    expect(invoiceNameConflict('קציצות בקר', '', GOURMET, ['2000097200258'])).toBeNull();
  });

  it('no code match or no name match → null', () => {
    expect(invoiceNameConflict('קבב', '', GOURMET, ['7290002195832'])).toBeNull();
    expect(invoiceNameConflict('', '', GOURMET, ['2000097200258'])).toBeNull();
  });
});

// IN264194413 (Baladi, 25/10): the invoice OCR put the two turkey lines'
// English the wrong way round (ירכיים = thighs is "Drumsticks", שוקיים =
// drumsticks is "Thighs"). The box OCR read a ירכיים carton right and copied
// the candidate English "Frozen Turkey Thighs…" — the שוקיים line's — so the
// exact-English step named the other line and 23 false popups fired.
const BALADI: InvoiceItem[] = [
  { item_code: '03141230', item_name_hebrew: 'רולדה הודו אדום מעובד תפזורת בד"ץ העדה החרדית', item_name_english: 'Red Turkey Roulade, processed meat products, Badatz Haredit' },
  { item_code: '7290003670321', item_name_hebrew: "ירכיים בינוני קפוא תפז' עדה החרדית", item_name_english: 'Frozen Turkey Drumsticks, Badatz Haredit' },
  { item_code: '7290003670444', item_name_hebrew: "שוקיים עוף בינוני קפוא תפז' עדה החרדית", item_name_english: 'Frozen Turkey Thighs, Badatz Haredit' },
];
const THIGHS_LABEL = '7290003670321015084304406102027';
const DRUMSTICKS_LABEL = '7290003670444014410981902082027';

describe('invoiceNameConflict — the Hebrew on the sticker judges (25/10)', () => {
  it('Hebrew agrees with the code, English names the swapped line → null', () => {
    expect(invoiceNameConflict(
      "ירכיים עוף בינוני קפוא תפז' עדה החרדית", 'Frozen Turkey Thighs, Badatz Haredit', BALADI, [THIGHS_LABEL],
    )).toBeNull();
  });

  it('Hebrew names the other line → still a conflict', () => {
    const c = invoiceNameConflict(
      "שוקיים עוף בינוני קפוא תפז' עדה החרדית", 'Frozen Chicken Drumsticks, Badatz Haredit', BALADI, [THIGHS_LABEL],
    );
    expect(c?.byCode.item_code).toBe('7290003670321');
    expect(c?.byName.item_code).toBe('7290003670444');
  });

  it('the mirror case on a drumsticks label → null', () => {
    // The 08:12:14 read, word doubled as the model returned it.
    expect(invoiceNameConflict(
      "שוקיים עוף בינוני קפוא תפז' קפוא תפז' עדה החרדית", 'Frozen Turkey Drumsticks, Badatz Haredit', BALADI, [DRUMSTICKS_LABEL],
    )).toBeNull();
  });

  it('no Hebrew read → the English still judges', () => {
    const c = invoiceNameConflict('', 'Frozen Turkey Thighs, Badatz Haredit', BALADI, [THIGHS_LABEL]);
    expect(c?.byName.item_code).toBe('7290003670444');
    // Latin text in the Hebrew field is no Hebrew read either.
    const latin = invoiceNameConflict('Turkey Thighs', 'Frozen Turkey Thighs, Badatz Haredit', BALADI, [THIGHS_LABEL]);
    expect(latin?.byName.item_code).toBe('7290003670444');
  });
});

describe("cartonOwnCodes — the worker's choice of product beats the code", () => {
  const GOURMET2: InvoiceItem[] = [
    { item_code: '7290004456856', item_name_hebrew: 'קבב מוסדי 8 קג - גורמה העדה החרדית', item_name_english: 'Frozen kebab 8g' },
    { item_code: '2000097200258', item_name_hebrew: 'קציצות בקר 35 גרם', item_name_english: 'Beef meatballs 35g' },
  ];
  const kebabNames = { item_name_hebrew: 'קבב מוסדי 8 קג - גורמה העדה החרדית', item_name: 'Frozen kebab 8g' };
  const line = (b: { barcode: string; source_barcode?: string; named_by_worker?: boolean; item_name_hebrew: string; item_name: string }) =>
    matchInvoiceItem(b.item_name_hebrew, b.item_name, GOURMET2, cartonOwnCodes(b))?.item_code;

  it('a carton nobody settled follows its code (barcode, or the code a label stands in for)', () => {
    expect(cartonOwnCodes({ barcode: '2826101900000123', source_barcode: '2000097200258' })).toEqual(['2826101900000123', '2000097200258']);
    expect(line({ barcode: '2826101900000123', source_barcode: '2000097200258', ...kebabNames })).toBe('2000097200258');
  });

  it('a carton he settled as kebab follows the name he chose', () => {
    expect(cartonOwnCodes({ barcode: '2000097200258', named_by_worker: true })).toEqual([]);
    expect(line({ barcode: '2826101900000123', source_barcode: '2000097200258', named_by_worker: true, ...kebabNames })).toBe('7290004456856');
  });
});
