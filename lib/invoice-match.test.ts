import { describe, it, expect } from 'vitest';
import { matchInvoiceItem, type InvoiceItem } from './invoice-match';

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
