import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// next/font only works inside a Next build; the render needs just the class name.
vi.mock('@/components/receive/v3/font', () => ({ rubik: { variable: 'v3font', className: 'v3font' } }));

import { BottomBar } from '@/components/receive/v3/BottomBar';
import { ConfirmScreen } from '@/components/receive/v3/ConfirmScreen';
import { LineCard, type OpenCardApi } from '@/components/receive/v3/LineCard';
import { HeaderRow, SearchRow, TabToggle } from '@/components/receive/v3/ListHeader';
import { LooseScreen } from '@/components/receive/v3/LooseScreen';
import { NotePhotoViewer } from '@/components/receive/v3/NotePhotoViewer';
import { NoticeScreen } from '@/components/receive/v3/NoticeScreen';
import { ReceiveFormV3 } from '@/components/receive/v3/ReceiveFormV3';
import { ErrorSheet, ExtraSheet, PackagingSheet, PalletListSheet, PalletsSheet } from '@/components/receive/v3/Sheets';
import { StatusScreen } from '@/components/receive/v3/StatusScreen';
import { StepPallets } from '@/components/receive/v3/StepPallets';
import { makeTr } from '@/components/receive/v3/texts';
import { en } from './i18n/en';
import { he } from './i18n/he';
import type { FormHeader, FormLine } from './receipt-form';
import {
  initialV3Draft,
  lineStatusV3,
  type ReceiveFormV3Props,
  type V3Draft,
  type V3LineDraft,
  type V3NoticeKind,
} from './receive-v3';

/**
 * Receive form v3 (06/11, flag receive_form_v3), rendered to HTML: each
 * screen shows the prototype's Hebrew verbatim, carries its aria labels and
 * numeric keyboards, and every overlay has a visible × ("סגירה"). The
 * receive.v3.* Hebrew block is pinned to the build spec's text table (9.1),
 * which was copied from the approved Claude Design prototype (text freeze).
 */

const TODAY = '2026-11-06';
const noop = () => {};
const tr = makeTr('Hebrew');

/** Bidi isolates out, so a test can read "2 משטחים" as the worker sees it. */
const plain = (html: string) => html.replace(/[\u2068\u2069]/g, '').replace(/&quot;/g, '"');
const render = <P extends object>(c: ComponentType<P>, props: P) => plain(renderToStaticMarkup(createElement(c, props)));

// Lines from the Bnei Darom test note (88010195), one per layout.
const L: FormLine[] = [
  // same: counted in cans, one field
  { index: 1, code: '92028', name_he: 'קסיבשאב גמבה קוביות פח 9 ליטר בד"ץ', name_en: 'Roasted Pepper Cubes 9L tin', qty: 7, unit: 'units', unit_label: 'יחידות', weighed: false, cartons: 7, packaging: 'can', per_pack: null, inner: null, needs_expiry: true },
  // pack: 1 carton × 3 gallons
  { index: 3, code: '92030', name_he: 'קסיבשאג חומץ 5% מכוהל בני דרום גלון בד"ץ', name_en: 'Vinegar 5% Bnei Darom gallon', qty: 3, unit: 'units', unit_label: 'יחידות', weighed: false, cartons: 1, packaging: 'carton', per_pack: 3, inner: 'gallon', needs_expiry: true },
  // two: weighed kg + sacks
  { index: 5, code: '92032', name_he: 'סוכר לבן 1 ק"ג', name_en: 'White sugar', qty: 20, unit: 'kg', unit_label: 'ק"ג', weighed: true, cartons: 20, packaging: 'sack', per_pack: null, inner: null, needs_expiry: true },
  // same: buckets
  { index: 4, code: '340113', name_he: 'מיונז 5 ק"ג תלמה', name_en: 'Mayonnaise 5kg', qty: 3, unit: 'units', unit_label: 'יחידות', weighed: false, cartons: 3, packaging: 'bucket', per_pack: null, inner: null, needs_expiry: true },
];
const HEADER: FormHeader = {
  supplier: 'שיווק והפצה בני דרום אגש"ח בע"מ',
  invoice_number: '88010195',
  invoice_date: TODAY,
  line_count: L.length,
  rev: 1,
};

function draftWith(patch: Record<number, Partial<V3LineDraft>> = {}, over: Partial<V3Draft> = {}): V3Draft {
  const d = initialV3Draft(L);
  return { ...d, ...over, lines: d.lines.map((x) => ({ ...x, ...(patch[x.index] ?? {}) })) };
}
const lineD = (draft: V3Draft, index: number) => draft.lines.find((x) => x.index === index)!;
const line = (index: number) => L.find((x) => x.index === index)!;

const API: OpenCardApi = {
  kb: { onFocus: noop, onBlur: noop },
  kbOpen: false,
  qtyEdit: false,
  onQtyEdit: noop,
  onCartons: noop,
  onQty: noop,
  onOpenPackaging: noop,
  onReset: noop,
  onGap: noop,
  onGapNote: noop,
  onGapNoteBlur: noop,
  onDateType: noop,
  onDatePick: noop,
  onDateFocus: noop,
  onDateBlur: noop,
  onToggleNoExpiry: noop,
  onStartSplit: noop,
  onSplitQty: noop,
  onSplitType: noop,
  onSplitBlur: noop,
  onSplitRemove: noop,
  onSplitAdd: noop,
  palletListOpen: false,
  onPalletChange: noop,
  onPalletClose: noop,
  onPalletPick: noop,
};

function card(index: number, draft: V3Draft, api: OpenCardApi | null = null): string {
  const l = line(index);
  const d = lineD(draft, index);
  return render(LineCard, { line: l, d, draft, status: lineStatusV3(l, d, draft, TODAY), today: TODAY, lang: 'he', tr, onToggle: noop, api });
}

const BOOT = { notePhotos: ['https://example.invalid/a.jpg', 'https://example.invalid/b.jpg'], erp: 'priority' as const, botWaNumber: '972500000000', today: TODAY };
function form(initialView: ReceiveFormV3Props['initialView'], boot = BOOT): string {
  return render(ReceiveFormV3, {
    formId: 'f1',
    exp: '1',
    sig: 's',
    language: 'Hebrew',
    header: HEADER,
    lines: L,
    previousFormIds: [],
    boot,
    initialView,
  });
}

/** Every <input> in the markup that is not a date picker / text field carries a numeric keyboard. */
function numberInputs(html: string): string[] {
  return (html.match(/<input[^>]*>/g) ?? []).filter((t) => /data-keyboard=/.test(t));
}

/** Count of visible × buttons (aria-label "סגירה"). */
const closeButtons = (html: string) => (html.match(/aria-label="סגירה"/g) ?? []).length;

// ── The text block ──────────────────────────────────────────────────────

/** Section 9.1 of the build spec: key → Hebrew, verbatim from the prototype. */
const SPEC_9_1: Record<string, string> = {
  "receive.v3.receiving": "קליטת סחורה",
  "receive.v3.noteLines": "תעודה {n} · {k} שורות",
  "receive.v3.palletsQ": "כמה משטחים?",
  "receive.v3.palletLess": "משטח אחד פחות",
  "receive.v3.palletMore": "משטח אחד יותר",
  "receive.v3.looseCheck": "יש גם פריטים מחוץ למשטח",
  "receive.v3.looseSummaryOne": "מחוץ למשטח: פריט אחד",
  "receive.v3.looseSummary": "מחוץ למשטח: {n} פריטים",
  "receive.v3.edit": "ערוך",
  "receive.v3.continue": "המשך",
  "receive.v3.enterPallets": "הזינו מספר משטחים",
  "receive.v3.looseTitle": "מה הגיע מחוץ למשטח?",
  "receive.v3.close": "סגירה",
  "receive.v3.search": "חיפוש פריט או מק\"ט",
  "receive.v3.clear": "ניקוי",
  "receive.v3.looseSub": "מק\"ט {code} · {packs}",
  "receive.v3.looseOf": "מתוך {packs}",
  "receive.v3.notFound": "לא נמצא בתעודה",
  "receive.v3.confirmBtn": "אישור",
  "receive.v3.headNote": "· תעודה {n}",
  "receive.v3.notePhoto": "צילום התעודה",
  "receive.v3.palletsOne": "משטח אחד",
  "receive.v3.palletsN": "{n} משטחים",
  "receive.v3.filter": "סינון",
  "receive.v3.tabNeed": "לא מולאו {n}",
  "receive.v3.tabDone": "מולאו {n}",
  "receive.v3.searchCount": "{n} מתוך {total}",
  "receive.v3.code": "מק\"ט {code}",
  "receive.v3.codeLabel": "מק\"ט",
  "receive.v3.st.expiry": "חסר תוקף",
  "receive.v3.st.gap": "חסר: ציינו למה",
  "receive.v3.st.pallet": "חסר משטח",
  "receive.v3.st.fix": "בדקו את השורה",
  "receive.v3.noExpiry": "אין תוקף",
  "receive.v3.loose": "מחוץ למשטח",
  "receive.v3.looseN": "{n} מחוץ למשטח",
  "receive.v3.palletN": "משטח {n}",
  "receive.v3.short": "חסר: {amount}",
  "receive.v3.gapQ": "למה חסר?",
  "receive.v3.gapWill": "יגיע בהמשך",
  "receive.v3.gapWont": "לא יגיע",
  "receive.v3.gapOther": "סיבה אחרת",
  "receive.v3.gapNote": "כתבו את הסיבה",
  "receive.v3.doneEmpty": "עוד לא מולאו שורות",
  "receive.v3.extrasTitle": "לא בתעודה",
  "receive.v3.remove": "הסירו",
  "receive.v3.addExtra": "פריט שלא מופיע בתעודה",
  "receive.v3.remaining": "לא מולאו {k} שורות",
  "receive.v3.remainingOne": "לא מולאה שורה אחת",
  "receive.v3.submit": "אישור ושליחה",
  "receive.v3.stepQty": "אריזה וכמות",
  "receive.v3.stepExpiry": "תוקף",
  "receive.v3.stepPallet": "משטח",
  "receive.v3.pkgType": "סוג אריזה",
  "receive.v3.qtyIn": "כמות ({pkgs})",
  "receive.v3.pkgCount": "מספר אריזות",
  "receive.v3.weight": "משקל (ק\"ג)",
  "receive.v3.qtyUnit": "כמות ({unit})",
  "receive.v3.asOnNote": "כמו בתעודה",
  "receive.v3.expiryDate": "תאריך תפוגה",
  "receive.v3.datePlaceholder": "__.__.____",
  "receive.v3.openCalendar": "פתיחת לוח שנה",
  "receive.v3.err.dateInvalid": "תאריך לא תקין",
  "receive.v3.err.datePast": "תאריך תפוגה חייב להיות אחרי היום",
  "receive.v3.err.dateFar": "יותר מ-15 שנה קדימה. בדקו את התאריך",
  "receive.v3.split": "פיצול לפי תוקף",
  "receive.v3.splitQty": "כמות",
  "receive.v3.splitNoDate": "חסר תאריך",
  "receive.v3.splitAdd": "+ תוקף נוסף",
  "receive.v3.splitLeft": "נשארו {left} מתוך {amount}",
  "receive.v3.splitAll": "{n} מתוך {amount}",
  "receive.v3.splitOver": "יותר מהכמות: {sum} מתוך {n}",
  "receive.v3.choose": "בחירה",
  "receive.v3.change": "שנה",
  "receive.v3.pkgSearch": "חיפוש סוג אריזה",
  "receive.v3.onNote": "בתעודה",
  "receive.v3.extraName": "שם הפריט",
  "receive.v3.extraQty": "כמות",
  "receive.v3.extraUnit": "יחידה",
  "receive.v3.err.name": "חסר שם",
  "receive.v3.err.qty": "חסרה כמות",
  "receive.v3.err.maxExtras": "עד 20 פריטים נוספים",
  "receive.v3.closeLink": "סגרו",
  "receive.v3.add": "הוספה",
  "receive.v3.confirmTitle": "אישור קליטה",
  "receive.v3.backToList": "חזרה לרשימה",
  "receive.v3.statusHead": "{supplier} · תעודה {n}",
  "receive.v3.savedTitle": "נשמר. תודה! אפשר לחזור לוואטסאפ.",
  "receive.v3.stepSaving": "שומר את הקליטה",
  "receive.v3.stepStock": "נקלט במלאי",
  "receive.v3.erp.stepSending": "שולח לפריוריטי",
  "receive.v3.erp.stepReceived": "נקלט בפריוריטי",
  "receive.v3.erp.grLine": "קליטה {docno}",
  "receive.v3.erp.partial": "נקלט בפריוריטי · {n} שורות יושלמו במשרד",
  "receive.v3.erp.timeout": "עדיין לא התקבל אישור מפריוריטי. המשרד קיבל הודעה",
  "receive.v3.erp.failed": "לא נקלט בפריוריטי. המשרד קיבל הודעה",
  "receive.v3.returning": "תודה! חוזרים לוואטסאפ…",
  "receive.v3.errGeneric": "השמירה נכשלה. נסו שוב.",
  "receive.v3.errBot": "המערכת לא ענתה. לא נשמר כלום. נסו שוב.",
  "receive.v3.errNetwork": "אין חיבור. בדקו קליטה ונסו שוב.",
  "receive.v3.retry": "נסו שוב",
  "receive.v3.pageOf": "{i} / {n}",
  "receive.v3.n.alreadySavedTitle": "התעודה הזו כבר נשמרה",
  "receive.v3.n.alreadySavedBody": "אין צורך לעשות כאן עוד דבר. אפשר לחזור לוואטסאפ.",
  "receive.v3.n.beingSavedTitle": "התעודה נשמרת ממש עכשיו",
  "receive.v3.n.beingSavedBody": "חכו רגע ורעננו.",
  "receive.v3.n.failedTitle": "לא ניתן היה לשמור את התעודה כאן",
  "receive.v3.n.failedBody": "המשרד עודכן. חזרו לוואטסאפ כדי להשלים אותה.",
  "receive.v3.n.linkInvalidTitle": "הקישור לא תקין או שפג תוקפו",
  "receive.v3.n.linkInvalidBody": "חזרו לוואטסאפ והשלימו שם את התעודה, או בקשו קישור חדש.",
  "receive.v3.n.cancelledTitle": "הקליטה בוטלה",
  "receive.v3.n.cancelledBody": "אם הסחורה הגיעה, שלחו שוב צילום של התעודה.",
  "receive.v3.n.duplicateTitle": "טופס כפול, נסגר",
  "receive.v3.n.duplicateBody": "ממשיכים בטופס השני.",
  "receive.v3.n.replacedTitle": "יש קישור חדש לתעודה",
  "receive.v3.n.replacedBody": "פתחו את הקישור האחרון בוואטסאפ.",
  "receive.v3.n.refresh": "רענון",
  "receive.v3.n.openNewer": "לטופס החדש",
};

describe('receive.v3 texts', () => {
  const v3he = Object.fromEntries(Object.entries(he).filter(([k]) => k.startsWith('receive.v3.')));
  const v3en = Object.keys(en).filter((k) => k.startsWith('receive.v3.'));

  it('every Hebrew value equals the spec table (copied from the prototype)', () => {
    expect(v3he).toEqual(SPEC_9_1);
  });

  it('English has the same keys', () => {
    expect(new Set(v3en)).toEqual(new Set(Object.keys(SPEC_9_1)));
  });

  it('reused approved strings exist unchanged (spec 9.3)', () => {
    expect(he['receive.errorInvalid']).toBe('יש שורות שצריך לתקן. הן מסומנות באדום.');
    expect(he['receive.linesChanged']).toBe('נוספו {n} שורות. מלאו ואשרו שוב.');
    expect(he['receive.linesChangedOne']).toBe('נוספה שורה אחת. מלאו ואשרו שוב.');
  });
});

// ── Step 1 and the loose sub-screen ─────────────────────────────────────

describe('step 1 · pallets', () => {
  it('opens on step 1 with the prototype texts, nothing entered', () => {
    const html = form({ kind: 'form' });
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('קליטת סחורה');
    expect(html).toContain(HEADER.supplier);
    expect(html).toContain('תעודה 88010195 · 4 שורות');
    expect(html).toContain('כמה משטחים?');
    expect(html).toContain('aria-label="משטח אחד פחות"');
    expect(html).toContain('aria-label="משטח אחד יותר"');
    expect(html).toContain('יש גם פריטים מחוץ למשטח');
    expect(html).toMatch(/role="checkbox"[^>]*aria-checked="false"|aria-checked="false"[^>]*role="checkbox"/);
    expect(html).toContain('הזינו מספר משטחים');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>הזינו מספר משטחים/);
    const count = html.match(/<input[^>]*aria-label="כמה משטחים\?"[^>]*>/)?.[0] ?? '';
    expect(count).toContain('inputMode="numeric"');
    expect(count).toContain('pattern="[0-9]*"');
    expect(count).toContain('dir="ltr"');
  });

  it('with pallets and loose items: המשך and the summary with ערוך', () => {
    const p = { header: HEADER, lineCount: 4, rtl: true, tr, onPallets: noop, onToggleLoose: noop, onEditLoose: noop, onContinue: noop };
    const two = render(StepPallets, { ...p, pallets: 2, looseOn: true, looseCount: 2 });
    expect(two).toContain('המשך');
    expect(two).not.toContain('הזינו מספר משטחים');
    expect(two).toContain('מחוץ למשטח: 2 פריטים');
    expect(two).toContain('ערוך');
    const one = render(StepPallets, { ...p, pallets: 0, looseOn: true, looseCount: 1 });
    expect(one).toContain('מחוץ למשטח: פריט אחד');
    expect(one).toContain('המשך');
  });

  it('loose sub-screen: title, ×, search, rows with their packages; אישור disabled with none', () => {
    const packs = { 1: { n: 7, text: '7 פחים' }, 3: { n: 1, text: '1 קרטון' }, 5: { n: 20, text: '20 שקים' }, 4: { n: 3, text: '3 דליים' } };
    const base = { lines: L, packs, query: '', lang: 'he' as const, rtl: true, tr, onQuery: noop, onToggle: noop, onStep: noop, onConfirm: noop, onClose: noop };
    const none = render(LooseScreen, { ...base, loose: {} });
    expect(none).toContain('מה הגיע מחוץ למשטח?');
    expect(closeButtons(none)).toBeGreaterThanOrEqual(1);
    expect(none).toContain('placeholder="חיפוש פריט או מק"ט"');
    expect(none).toContain('מק"ט 340113 · 3 דליים');
    expect(none).toMatch(/<button[^>]*disabled=""[^>]*>אישור</);
    const some = render(LooseScreen, { ...base, loose: { 4: 2 } });
    expect(some).toContain('מתוך 3 דליים');
    expect(some).toContain('aria-label="-1"');
    expect(some).toContain('aria-label="+1"');
    expect(some).not.toMatch(/<button[^>]*disabled=""[^>]*>אישור</);
    const nothing = render(LooseScreen, { ...base, loose: {}, query: 'zzzzqqq' });
    expect(nothing).toContain('לא נמצא בתעודה');
  });
});

// ── The list ────────────────────────────────────────────────────────────

describe('list', () => {
  it('header row: supplier, note number, note photo and the pallets badge', () => {
    const html = render(HeaderRow, { supplier: HEADER.supplier, invoiceNumber: HEADER.invoice_number, pallets: 2, hasPhoto: true, tr, onNotePhoto: noop, onPallets: noop });
    expect(html).toContain('· תעודה 88010195');
    expect(html).toContain('aria-label="צילום התעודה"');
    expect(html).toContain('aria-label="2 משטחים"');
    const one = render(HeaderRow, { supplier: 'x', invoiceNumber: '1', pallets: 1, hasPhoto: false, tr, onNotePhoto: noop, onPallets: noop });
    expect(one).toContain('aria-label="משטח אחד"');
    expect(one).not.toContain('צילום התעודה');
  });

  it('search row (always visible) and the toggle', () => {
    const s = render(SearchRow, { query: 'מיונז', onQuery: noop, collapsed: false, shown: 1, total: 4, rtl: true, tr });
    expect(s).toContain('role="search"');
    expect(s).toContain('1 מתוך 4');
    expect(s).toContain('aria-label="ניקוי"');
    const t = render(TabToggle, { tab: 'need', need: 3, done: 1, tr, onTab: noop });
    expect(t).toContain('role="group"');
    expect(t).toContain('aria-label="סינון"');
    expect(t).toContain('לא מולאו 3');
    expect(t).toContain('מולאו 1');
    expect(t).toMatch(/aria-pressed="true"[^>]*>לא מולאו 3/);
  });

  it('collapsed card: number, name, code, status line', () => {
    const d = draftWith({}, { pallets: 2 });
    const html = card(1, d);
    expect(html).toContain('קסיבשאב גמבה קוביות פח 9 ליטר בד"ץ');
    expect(html).toContain('מק"ט 92028');
    expect(html).toContain('7 פחים · חסר תוקף');
    const ready = draftWith({ 1: { expiry: '12.05.2027', pallet: 2, ack: true } }, { pallets: 2 });
    expect(card(1, ready)).toContain('7 פחים · 12.05.2027 · משטח 2');
    const loose = draftWith({ 4: { expiry: '12.05.2027', ack: true } }, { pallets: 2, loose: { 4: 1 } });
    expect(card(4, loose)).toContain('1 מחוץ למשטח');
    const noPal = draftWith({ 1: { expiry: '12.05.2027', ack: true } }, { pallets: 2 });
    expect(card(1, noPal)).toContain('חסר משטח');
  });

  it('open card, same mode: the rail, the steppers, date, actions; every number field is numeric', () => {
    const d = draftWith({}, { pallets: 2 });
    const html = card(4, d, API);
    expect(closeButtons(html)).toBe(1);
    for (const s of ['אריזה וכמות', 'תוקף', 'משטח', 'בחירה', 'אין תוקף', 'פיצול לפי תוקף']) expect(html).toContain(s);
    expect(html).toContain('aria-label="כמות (דליים)"');
    expect(html).toContain('aria-haspopup="listbox"');
    expect(html).toContain('aria-label="סוג אריזה"');
    expect(html).toContain('aria-label="תאריך תפוגה"');
    expect(html).toContain('placeholder="__.__.____"');
    expect(html).toContain('aria-label="פתיחת לוח שנה"');
    const nums = numberInputs(html);
    expect(nums.length).toBeGreaterThanOrEqual(2);
    for (const t of nums) expect(t).toMatch(/inputMode="(numeric|decimal)"/);
  });

  it('open card, pack mode: packages + the units total link', () => {
    const html = card(3, draftWith(), API);
    expect(html).toContain('aria-label="מספר אריזות"');
    expect(html).toContain('3 יחידות');
  });

  it('open card, two mode (weighed): kg field with the decimal keyboard + packages', () => {
    const html = card(5, draftWith(), API);
    const kg = html.match(/<input[^>]*aria-label="משקל \(ק"ג\)"[^>]*>/)?.[0] ?? '';
    expect(kg).toContain('inputMode="decimal"');
    expect(html).toContain('aria-label="מספר אריזות"');
  });

  it('short line: חסר, the reason chips, כמו בתעודה', () => {
    const html = card(4, draftWith({ 4: { qty: '2', cartons: '2', edited: true } }), API);
    expect(html).toContain('חסר: 1 דלי');
    expect(html).toContain('aria-label="למה חסר?"');
    for (const s of ['יגיע בהמשך', 'לא יגיע', 'סיבה אחרת', 'כמו בתעודה']) expect(html).toContain(s);
    const other = card(4, draftWith({ 4: { qty: '2', cartons: '2', gap: 'other', edited: true } }), API);
    expect(other).toContain('placeholder="כתבו את הסיבה"');
  });

  it('split rows: qty + date per row, remove, add, balance', () => {
    const html = card(4, draftWith({ 4: { split: [{ qty: '2', date: '12.05.2027' }, { qty: '1', date: '' }] } }), API);
    expect(html).toContain('placeholder="חסר תאריך"');
    expect(html).toContain('aria-label="הסירו"');
    expect(html).toContain('+ תוקף נוסף');
    for (const t of numberInputs(html)) expect(t).toMatch(/inputMode="(numeric|decimal)"/);
  });

  it('inline pallet list (≥ 2 pallets): listbox with משטח 1…n and מחוץ למשטח, its own ×', () => {
    const d = draftWith({ 4: { expiry: '12.05.2027', ack: true } }, { pallets: 2, lastPallet: 2 });
    const html = card(4, d, { ...API, palletListOpen: true });
    expect(html).toContain('role="listbox"');
    expect(html).toContain('משטח 1');
    expect(html).toContain('משטח 2');
    expect(html).toContain('מחוץ למשטח');
    expect(closeButtons(html)).toBe(2);
  });

  it('bottom bar: left to fill / one left / submit', () => {
    const b = { rtl: true, tr, onNext: noop, onConfirm: noop };
    expect(render(BottomBar, { ...b, remaining: 3 })).toContain('לא מולאו 3 שורות');
    expect(render(BottomBar, { ...b, remaining: 1 })).toContain('לא מולאה שורה אחת');
    expect(render(BottomBar, { ...b, remaining: 0 })).toContain('אישור ושליחה');
  });
});

// ── Overlays: each has a visible × ──────────────────────────────────────

describe('overlays', () => {
  it('pallets sheet', () => {
    const html = render(PalletsSheet, { pallets: 2, looseOn: false, looseCount: 0, tr, onPallets: noop, onToggleLoose: noop, onEditLoose: noop, onConfirm: noop, onCancel: noop });
    expect(closeButtons(html)).toBe(1);
    expect(html).toContain('כמה משטחים?');
    expect(html).toContain('אישור');
    expect(html.match(/<input[^>]*>/)?.[0]).toContain('inputMode="numeric"');
  });

  it('pallet list sheet', () => {
    const html = render(PalletListSheet, { pallets: 1, value: 1, tr, onPick: noop, onClose: noop });
    expect(closeButtons(html)).toBe(1);
    expect(html).toContain('role="listbox"');
    expect(html).toContain('משטח 1');
    expect(html).toContain('מחוץ למשטח');
  });

  it('packaging list: the filter, the note type first with בתעודה', () => {
    const html = render(PackagingSheet, { notePkg: 'bucket', value: 'bucket', lang: 'he', rtl: true, tr, onPick: noop, onClose: noop });
    expect(closeButtons(html)).toBe(1);
    expect(html).toContain('placeholder="חיפוש סוג אריזה"');
    expect(html).toContain('בתעודה');
    expect(html.indexOf('דלי')).toBeLessThan(html.indexOf('קרטון'));
    expect(html).toContain('אחר');
  });

  it('item not on the note', () => {
    const html = render(ExtraSheet, { initialName: 'שמן', extrasCount: 0, lang: 'he', rtl: true, tr, onAdd: noop, onClose: noop });
    expect(closeButtons(html)).toBe(1);
    for (const s of ['פריט שלא מופיע בתעודה', 'שם הפריט', 'כמות', 'יחידה', 'הוספה', 'סגרו']) expect(html).toContain(s);
    expect(html).toContain('value="שמן"');
    expect(html).toMatch(/<input[^>]*inputMode="decimal"[^>]*>/);
  });

  it('save error', () => {
    const html = render(ErrorSheet, { text: tr('receive.v3.errNetwork'), tr, onRetry: noop, onClose: noop });
    expect(closeButtons(html)).toBe(1);
    expect(html).toContain('אין חיבור. בדקו קליטה ונסו שוב.');
    expect(html).toContain('נסו שוב');
    expect(html).toContain('סגרו');
  });

  it('note photo viewer', () => {
    const html = render(NotePhotoViewer, { photos: BOOT.notePhotos, tr, onClose: noop });
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-label="צילום התעודה"');
    expect(html).toContain('1 / 2');
    expect(closeButtons(html)).toBe(1);
  });
});

// ── Confirmation, status, notices ───────────────────────────────────────

describe('confirmation', () => {
  it('cards read-only, extras, back and submit', () => {
    const d = draftWith(
      { 1: { expiry: '12.05.2027', ack: true }, 4: { noExpiry: true, ack: true } },
      { pallets: 1, extras: [{ key: 'x1', name: 'שמן קנולה', quantity: '2', unit: 'cartons' }] },
    );
    const html = render(ConfirmScreen, { lines: L, draft: d, lang: 'he', tr, onGo: noop, onBack: noop, onSubmit: noop });
    for (const s of ['אישור קליטה', 'חזרה לרשימה', 'אישור ושליחה', 'לא בתעודה', 'שמן קנולה', '12.05.2027', 'אין תוקף']) expect(html).toContain(s);
  });
});

describe('status screen', () => {
  const base = { supplier: HEADER.supplier, invoiceNumber: HEADER.invoice_number, redirecting: false, redirectKey: 0, rtl: true, tr, onClose: noop };
  const flow = (o: Partial<Parameters<typeof StatusScreen>[0]['flow']> = {}) => ({
    sx: { phase: 0, done: -1, final: false },
    outcome: null,
    docno: null,
    officeLines: null,
    stillUpTo: -1,
    ...o,
  });

  it('with Priority: three steps, the saved title and the GR line once received', () => {
    const html = render(StatusScreen, {
      ...base,
      erp: 'priority',
      redirecting: true,
      flow: flow({ sx: { phase: 2, done: 2, final: true }, outcome: 'success', docno: 'GR26000190' }),
    });
    expect(html).toContain(`${HEADER.supplier} · תעודה 88010195`);
    for (const s of ['נשמר. תודה! אפשר לחזור לוואטסאפ.', 'שומר את הקליטה', 'שולח לפריוריטי', 'נקלט בפריוריטי', 'GR26000190', 'תודה! חוזרים לוואטסאפ…', 'סגרו']) {
      expect(html).toContain(s);
    }
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('data-action="open-bot-chat"');
  });

  it('partial, timeout and failed texts', () => {
    const one = (outcome: 'partial' | 'timeout' | 'failed') =>
      render(StatusScreen, { ...base, erp: 'priority', flow: flow({ sx: { phase: 2, done: outcome === 'partial' ? 2 : 1, final: true }, outcome, officeLines: 2 }) });
    expect(one('partial')).toContain('נקלט בפריוריטי · 2 שורות יושלמו במשרד');
    expect(one('timeout')).toContain('עדיין לא התקבל אישור מפריוריטי. המשרד קיבל הודעה');
    expect(one('failed')).toContain('לא נקלט בפריוריטי. המשרד קיבל הודעה');
  });

  it('without ERP: two steps, never the word Priority', () => {
    const html = render(StatusScreen, { ...base, erp: 'none', flow: flow({ sx: { phase: 1, done: 1, final: true }, outcome: 'success' }) });
    expect(html).toContain('שומר את הקליטה');
    expect(html).toContain('נקלט במלאי');
    expect(html).not.toMatch(/פריוריטי|Priority|GR|ERP/);
  });

  it('a reopened done form opens on the status screen', () => {
    const html = form({ kind: 'status' });
    expect(html).toContain('שומר את הקליטה');
    expect(html).toContain('שולח לפריוריטי');
  });
});

describe('notices', () => {
  const TEXTS: Record<V3NoticeKind, string[]> = {
    alreadySaved: ['התעודה הזו כבר נשמרה', 'אין צורך לעשות כאן עוד דבר. אפשר לחזור לוואטסאפ.', 'סגרו'],
    beingSaved: ['התעודה נשמרת ממש עכשיו', 'חכו רגע ורעננו.', 'רענון'],
    failed: ['לא ניתן היה לשמור את התעודה כאן', 'המשרד עודכן. חזרו לוואטסאפ כדי להשלים אותה.', 'סגרו'],
    linkInvalid: ['הקישור לא תקין או שפג תוקפו', 'חזרו לוואטסאפ והשלימו שם את התעודה, או בקשו קישור חדש.', 'סגרו'],
    cancelled: ['הקליטה בוטלה', 'אם הסחורה הגיעה, שלחו שוב צילום של התעודה.', 'סגרו'],
    duplicate: ['טופס כפול, נסגר', 'ממשיכים בטופס השני.', 'סגרו'],
    replaced: ['יש קישור חדש לתעודה', 'פתחו את הקישור האחרון בוואטסאפ.', 'לטופס החדש'],
  };
  for (const [kind, texts] of Object.entries(TEXTS) as [V3NoticeKind, string[]][]) {
    it(kind, () => {
      const html = form({ kind: 'notice', notice: kind, newer: kind === 'replaced' ? { id: 'f2', href: '/receive/f2?exp=1&sig=s' } : null });
      for (const s of texts) expect(html).toContain(s);
      expect(html).toContain(`data-notice="${kind}"`);
    });
  }

  it('the redirect block shows with the countdown', () => {
    const html = render(NoticeScreen, { kind: 'alreadySaved', redirecting: true, redirectKey: 1, rtl: true, tr, onClose: noop, onRefresh: noop, onOpenNewer: noop });
    expect(html).toContain('תודה! חוזרים לוואטסאפ…');
    expect(html).toContain('data-anim="redirect"');
  });
});

// ── No classic / 28/10-redesign texts inside v3 ─────────────────────────

describe('v3 uses only its own texts', () => {
  it('no receive.v2.* string and no other classic receive.* string appears in any v3 screen', () => {
    const d = draftWith({ 4: { qty: '2', cartons: '2', edited: true } }, { pallets: 2, extras: [{ key: 'x', name: 'שמן', quantity: '1', unit: 'units' }] });
    const all = [
      form({ kind: 'form' }),
      form({ kind: 'status' }),
      ...(['alreadySaved', 'beingSaved', 'failed', 'linkInvalid', 'cancelled', 'duplicate', 'replaced'] as V3NoticeKind[]).map((k) =>
        form({ kind: 'notice', notice: k }),
      ),
      card(1, d),
      card(4, d, API),
      card(3, d, API),
      card(5, d, API),
      render(ConfirmScreen, { lines: L, draft: d, lang: 'he', tr, onGo: noop, onBack: noop, onSubmit: noop }),
    ].join('\n');
    const v3Values = Object.entries(he)
      .filter(([k]) => k.startsWith('receive.v3.'))
      .map(([, v]) => v);
    const reused = new Set(['receive.errorInvalid', 'receive.linesChanged', 'receive.linesChangedOne']);
    const foreign = Object.entries(he).filter(
      ([k, v]) =>
        k.startsWith('receive.') &&
        !k.startsWith('receive.v3.') &&
        !reused.has(k) &&
        !v.includes('{') &&
        v.length >= 8 &&
        !v3Values.some((x) => x.includes(v)),
    );
    const hits = foreign.filter(([, v]) => all.includes(v)).map(([k]) => k);
    expect(hits).toEqual([]);
  });
});
