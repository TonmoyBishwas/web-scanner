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
  'priority.heading', 'priority.checking', 'priority.closing', 'priority.sending',
  'priority.awaiting', 'priority.unconfirmed', 'priority.unconfirmedOffice', 'priority.noWriteback',
  'priority.received', 'priority.receivedFinal', 'priority.cancelled', 'priority.already',
  'priority.held', 'priority.heldOffice', 'priority.waitingItems', 'priority.waitingSupplier',
  'priority.waitingNothing', 'priority.waitingOther', 'priority.failed', 'priority.failedOffice',
  'priority.expired', 'priority.expiredOffice', 'priority.test', 'priority.off', 'priority.unknown',
  'receive.saved',
]);

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

  it('the pending list holds only keys that still need it', () => {
    const stale = [...PRIORITY_WORDS_PENDING].filter((k) => !PRIORITY_WORDS.test((he as Record<string, string>)[k] ?? ''));
    expect(stale).toEqual([]);
  });
});
