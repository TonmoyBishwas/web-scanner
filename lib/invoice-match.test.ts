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

// PB1 (e2e harness run r2610241328-etnz, 24/10): step 2 prefix-matched the
// sticker's first word against the line's name with its spaces removed and
// took the FIRST line that fit. "קוסאלאבא" fits both "קוסאלאב אנטריקוט …"
// and "קוסאלאב אסאדו …" across the space, so an asado carton was booked as
// entrecote. Step 2 now answers only when exactly one line fits (a whole
// first word first); otherwise the later steps decide.
describe('matchInvoiceItem — first word answers only when one line fits (PB1)', () => {
  const RUN5: InvoiceItem[] = [
    { item_code: 'A', item_name_hebrew: 'קוסאלאב אנטריקוט טרי', item_name_english: '' },
    { item_code: 'B', item_name_hebrew: 'קוסאלאב אסאדו בקר טרי', item_name_english: '' },
    { item_code: 'C', item_name_hebrew: 'קוסאלאגא בשר טחון טרי', item_name_english: '' },
  ];

  it('an asado sticker whose first word fits two lines is not booked as the first of them', () => {
    expect(matchInvoiceItem('קוסאלאבא אסאדו בקר טרי', '', RUN5)?.item_code).toBe('B');
  });

  it('the other run-5 stickers still land on their own lines', () => {
    expect(matchInvoiceItem('קוסאבלאב אנטריקוט טרי', '', RUN5)?.item_code).toBe('A');
    expect(matchInvoiceItem('קופסאגלג בשר טחון טרי', '', RUN5)?.item_code).toBe('C');
    expect(matchInvoiceItem('קסבאלגא בשר טחון טרי', '', RUN5)?.item_code).toBe('C');
    expect(matchInvoiceItem('סבאלגא בשר טחון טרי', '', RUN5)?.item_code).toBe('C');
  });

  it('a first word that names exactly one line still decides (run 5, its 3rd sticker)', () => {
    // "קוסאלאגא" is the minced line's own first word and no other line's, so
    // step 2 answers with it, whatever the rest of the sticker says. Kept as
    // the rule; the harness's noisy item words are what make this one wrong.
    expect(matchInvoiceItem('קוסאלאגא אסאדו בקר טרי', '', RUN5)?.item_code).toBe('C');
  });

  it('a brand first word shared by two lines falls through to the fuzzy step', () => {
    const lines: InvoiceItem[] = [
      { item_code: 'breast', item_name_hebrew: 'אחדות חזה עוף גדול', item_name_english: '' },
      { item_code: 'wings', item_name_hebrew: 'אחדות כנפיים עוף', item_name_english: '' },
    ];
    expect(matchInvoiceItem('אחדות כנפים עוף', '', lines)?.item_code).toBe('wings');
  });

  it('a whole first word beats a line it is only the start of', () => {
    const lines: InvoiceItem[] = [
      { item_code: 'livers', item_name_hebrew: 'כבדים קפוא', item_name_english: '' },
      { item_code: 'liver', item_name_hebrew: 'כבד עוף טרי', item_name_english: '' },
    ];
    expect(matchInvoiceItem('כבד טרי', '', lines)?.item_code).toBe('liver');
  });

  // IN 261048511 (the bot's port): two schnitzel lines differ only by size.
  const SCHNITZEL: InvoiceItem[] = [
    { item_code: '100', item_name_hebrew: 'שניצל עוף פרוס 100', item_name_english: '' },
    { item_code: '120', item_name_hebrew: 'שניצל עוף פרוס 120', item_name_english: '' },
  ];

  it('the same first word on two lines and nothing else to go on → no line', () => {
    expect(matchInvoiceItem('שניצל מיוחד', '', SCHNITZEL)).toBeNull();
  });

  it('a number on the sticker that names one of them decides', () => {
    expect(matchInvoiceItem('שניצל 120 קפוא', '', SCHNITZEL)?.item_code).toBe('120');
  });

  it('an ambiguous name raises no "which product?" against the carton code', () => {
    const coded: InvoiceItem[] = [
      { item_code: '7290000000100', item_name_hebrew: 'שניצל עוף פרוס 100', item_name_english: '' },
      { item_code: '7290000000120', item_name_hebrew: 'שניצל עוף פרוס 120', item_name_english: '' },
    ];
    expect(invoiceNameConflict('שניצל מיוחד', '', coded, ['7290000000120'])).toBeNull();
  });
});

// PB2 (e2e harness run r2610241337-ag6d, 24/10): a loose carton OCR'd with
// niqqud was credited to no line. Vowel points are not letters: they are
// stripped before matching.
describe('matchInvoiceItem — niqqud is ignored (PB2)', () => {
  const RUN6: InvoiceItem[] = [
    { item_code: 'A', item_name_hebrew: 'קוסלגאב אנטריקוט טרי', item_name_english: '' },
    { item_code: 'B', item_name_hebrew: 'קוסלגאב אסאדו בקר טרי', item_name_english: '' },
    { item_code: 'C', item_name_hebrew: 'קוסלגאב בשר טחון טרי', item_name_english: '' },
  ];

  it('a vowelled sticker lands on its line', () => {
    expect(matchInvoiceItem('קִסְבֶּלָגָה בְּשַׂר טָחוּן טָרִי', '', RUN6)?.item_code).toBe('C');
  });

  it('the run-6 unvowelled stickers still land on their lines', () => {
    expect(matchInvoiceItem('קופסלבלא בשר טחון טרי', '', RUN6)?.item_code).toBe('C');
    expect(matchInvoiceItem('סקלבגלא בשר טחון טרי', '', RUN6)?.item_code).toBe('C');
  });

  it('a vowelled name equals its plain spelling exactly', () => {
    const lines: InvoiceItem[] = [
      { item_code: 'x', item_name_hebrew: 'בשר טחון', item_name_english: '' },
      { item_code: 'y', item_name_hebrew: 'בשר טחון מיוחד', item_name_english: '' },
    ];
    expect(matchInvoiceItem('בָּשָׂר טָחוּן', '', lines)?.item_code).toBe('x');
  });
});
