import { describe, expect, it } from 'vitest';
import { he } from './i18n/he';
import { PACKAGING_LABELS, PACKAGING_PLURAL, PACKAGING_SINGULAR } from './receipt-form';

// Mevaser 21/10, rule 2: no slash gender forms (מלא/י, ענה/י, לחץ/י); the
// plural imperative only (מלאו, ענו, לחצו).
const SLASH_GENDER = /[֐-׿]+\/[יהתו]{1,2}(?![֐-׿])/;

const HE = Object.entries(he as Record<string, string>);

// Mevaser 21/10, rule 1: the plural imperative, never the masculine one
// (סרוק → סרקו, הקש → הקישו, נסה שוב → נסו שוב).
const MASCULINE_IMPERATIVES = [
  'פתח', 'בחר', 'סרוק', 'לחץ', 'הקלד', 'שלח', 'אשר', 'בדוק', 'נסה', 'מלא', 'צלם', 'הדבק',
  'הדפס', 'סיים', 'בטל', 'הוסף', 'הזן', 'תקן', 'השתמש', 'ודא', 'חזור', 'הסר', 'ערוך', 'מחק',
  'גע', 'כוון', 'קרב', 'הצמד', 'הקש', 'החזק', 'החלף', 'רענן', 'סגור', 'הצג', 'שמור', 'בקש',
  'השווה', 'מזג', 'החלק', 'התחל', 'קבע', 'פתור', 'דלג', 'שתף', 'העתק', 'צור', 'נפק', 'גרור',
  'קח', 'עדכן', 'שחרר', 'סמן', 'ספור', 'נקה', 'הגדר', 'הגדל', 'חפש', 'טען',
];
// "שים לב" (שימו לב): the bare word is too common to list.
const MASCULINE_PHRASES = ['שים לב'];
// A clause starts the value, follows sentence punctuation or a quote, or
// follows a joining word (או סרוק, ואז הקש, קודם הדפס). A leading ו counts (ובדוק).
const CLAUSE_START = String.raw`(?:^|[.!?:,;·(\"״׳]\s*|(?:^|\s)(?:או|ואז|אז|קודם|אם לא,?)\s)`;
const IMPERATIVE_AT_CLAUSE_START = new RegExp(
  `${CLAUSE_START}ו?(?:${[...MASCULINE_PHRASES, ...MASCULINE_IMPERATIVES].join('|')})(?![֐-׿])`,
);
// Not an imperative of the worker's, so allowed.
const IMPERATIVE_ALLOWED: Record<string, string> = {
  // WhatsApp's own menu item, quoted as it reads there.
  'scanner.noCamerasDesc': 'פתח בדפדפן',
  // A first-person button ("Fix the number I entered"): the plural reads wrong; left for Mevaser.
  'palletVerify.overTotalFix': 'תקן',
};

// Mevaser 21/10, rule 3: no sentence dash (— / –, or a spaced " - "); a period
// or a comma instead. A bare "—" is the no-value placeholder and stays.
const SENTENCE_DASH = /[—–]| - /;
const PLACEHOLDER = '—';

// Mevaser 21/10, rule 4: the worker never reads קבלה / טיוטא / פריוריטי
// (the note is תעודה, receiving is קליטה). Office screens may.
const PRIORITY_WORDS = /(?<![֐-׿])[ובלמהשכ]{0,2}(?:קבלה|קבלות|קבלת|טיוטא|טיוטה|טיוטת|פריוריטי)(?![֐-׿])/;
const OFFICE_ONLY_PREFIXES = ['receipts.']; // /priority/receipts, the owner's board
// Worker-facing keys that still carry one of the words, each listed for Mevaser
// (the default word does not fit; scratchpad report oct21b). Explicit keys, so a
// new worker text with one of the words fails here.
const PRIORITY_WORDS_PENDING = new Set([
  'errors.lockFailed', // קבלת נעילה = acquiring a lock, not a receipt
]);

// Mevaser 21/10, sweep reply A.5: no system or tool name in any user text
// (David's screens and the office's). Explicit pending keys (no wording from
// Mevaser yet, scratchpad oct21c/scanner_release.md), so a new one fails here.
const SYSTEM_NAMES = new RegExp(
  String.raw`(?<![A-Za-z])(?:Airtable|Railway|Make|LeonAI|Supabase|Gemini|Vercel|Cloudinary|OpenRouter|webhook)(?![A-Za-z])` +
    String.raw`|(?<![֐-׿])[ובלמהשכ]{0,2}(?:לוגים|לוג|אדמין)(?![֐-׿])`,
  'i',
);
const SYSTEM_NAMES_PENDING = new Set([
  'errors.botWebhookNotConfigured', // "the bot's webhook is not configured"
  'ocr.extractingData', // "… using Gemini AI" (legacy /scan page)
  'ocr.geminiAnalyzing', // "Gemini is analysing the image…" (legacy /scan page)
  'receipts.reason.make_crash', // owner's board: "a fault in Make"
  'receipts.reason.make_no_ok', // owner's board: "Make did not confirm"
  'receipts.reason.no_reply', // owner's board: "no answer from Make"
]);

// Mevaser 21/10, sweep reply A.2: the supplier's paper is a תעודה (note), never
// a חשבונית (invoice), on the worker's screens.
const INVOICE_WORD = /חשבונית/;
const INVOICE_WORD_PENDING = new Set([
  'issue.invoiceLabel', // outbound issue screen: the customer's document, not the supplier's note
  'terminal.docsSearch', // documents archive search: "invoice OR delivery note" are two different numbers
]);

// Mevaser 21/10, sweep reply A.1: no second-person singular past or possessive
// (ענית → עניתם, הזנת → הזנתם, שלך → שלכם).
const SINGULAR_SECOND_PERSON = new RegExp(
  String.raw`(?<![֐-׿])(?:` +
    [
      'שלך', 'לך', 'ממך', 'אצלך', 'אותך', 'עליך', 'אליך',
      'ענית', 'הזכרת', 'שקלת', 'אמרת', 'נתת', 'סרקת', 'סיימת', 'הזנת', 'בחרת', 'הקלדת', 'צילמת',
      'הוספת', 'מחקת', 'הדפסת', 'ספרת', 'שלחת', 'אישרת', 'שמרת', 'שינית', 'תיקנת', 'ביטלת', 'יצרת',
    ].join('|') +
    String.raw`)(?![֐-׿])`,
);
// Nouns that look like the verb (construct state), not the worker's action.
const SINGULAR_ALLOWED: Record<string, string> = {
  'meatManual.title': 'הזנת כמויות', // "quantity entry"
  'terminal.barcodeMisread': 'ספרת הביקורת', // "the check digit"
};

describe('Hebrew style rules (Mevaser 21/10)', () => {
  it('no slash gender form in any Hebrew text', () => {
    const texts: [string, string][] = [
      ...HE,
      ...[PACKAGING_LABELS, PACKAGING_PLURAL, PACKAGING_SINGULAR].flatMap((m) =>
        Object.entries(m).map(([k, v]) => [k, v.he] as [string, string]),
      ),
    ];
    expect(texts.filter(([, v]) => SLASH_GENDER.test(v))).toEqual([]);
  });

  it('no masculine-only imperative at the start of a sentence or clause', () => {
    const bad = HE.filter(([k, v]) => {
      const allowed = IMPERATIVE_ALLOWED[k];
      return IMPERATIVE_AT_CLAUSE_START.test(allowed ? v.split(allowed).join('') : v);
    });
    expect(bad).toEqual([]);
  });

  it('the imperative check catches the old wording', () => {
    for (const old of ['סרוק שוב', 'קריאה שגויה. סרוק שוב', 'בדוק את המדבקה', 'או הדפס מדבקה', 'הקש "אישור"', 'שים לב: הברקוד', 'ובדוק']) {
      expect(IMPERATIVE_AT_CLAUSE_START.test(old), old).toBe(true);
    }
    for (const ok of ['סרקו שוב', 'בגודל מלא', 'מחיקה', 'שמירה', 'הקישו "אישור"', 'שימו לב']) {
      expect(IMPERATIVE_AT_CLAUSE_START.test(ok), ok).toBe(false);
    }
  });

  it('no sentence dash in any Hebrew text, the bare placeholder aside', () => {
    expect(HE.filter(([, v]) => v !== PLACEHOLDER && SENTENCE_DASH.test(v))).toEqual([]);
  });

  it('no קבלה / טיוטא / פריוריטי on a worker screen', () => {
    const bad = HE.filter(
      ([k, v]) =>
        !OFFICE_ONLY_PREFIXES.some((p) => k.startsWith(p)) && !PRIORITY_WORDS_PENDING.has(k) && PRIORITY_WORDS.test(v),
    );
    expect(bad).toEqual([]);
  });

  it('no system or tool name in any Hebrew text', () => {
    expect(HE.filter(([k, v]) => !SYSTEM_NAMES_PENDING.has(k) && SYSTEM_NAMES.test(v))).toEqual([]);
    const stale = [...SYSTEM_NAMES_PENDING].filter((k) => !SYSTEM_NAMES.test((he as Record<string, string>)[k] ?? ''));
    expect(stale).toEqual([]);
    for (const old of ['בדקו ב-Airtable', 'הלוגים של Railway', 'לבדיקת אדמין', 'בדקו את הלוגים', 'תקלה ב-Make']) {
      expect(SYSTEM_NAMES.test(old), old).toBe(true);
    }
    for (const ok of ['מדבקת משטח', 'המשרד יבדוק', 'הזמנת רכש']) expect(SYSTEM_NAMES.test(ok), ok).toBe(false);
  });

  it('no חשבונית on a worker screen', () => {
    expect(HE.filter(([k, v]) => !INVOICE_WORD_PENDING.has(k) && INVOICE_WORD.test(v))).toEqual([]);
    const stale = [...INVOICE_WORD_PENDING].filter((k) => !INVOICE_WORD.test((he as Record<string, string>)[k] ?? ''));
    expect(stale).toEqual([]);
  });

  it('no second-person singular past or possessive', () => {
    const bad = HE.filter(([k, v]) => {
      const allowed = SINGULAR_ALLOWED[k];
      return SINGULAR_SECOND_PERSON.test(allowed ? v.split(allowed).join('') : v);
    });
    expect(bad).toEqual([]);
    for (const old of ['כבר ענית', 'הספירה שלך', 'הזנת 40.']) expect(SINGULAR_SECOND_PERSON.test(old), old).toBe(true);
    for (const ok of ['כבר עניתם', 'הספירה שלכם', 'הזנתם 40.', 'תודה לכם']) expect(SINGULAR_SECOND_PERSON.test(ok), ok).toBe(false);
  });

  it('the pending list holds only keys that still need it', () => {
    const stale = [...PRIORITY_WORDS_PENDING].filter((k) => !PRIORITY_WORDS.test((he as Record<string, string>)[k] ?? ''));
    expect(stale).toEqual([]);
  });
});
