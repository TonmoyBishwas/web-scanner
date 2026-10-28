import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CompactLineCard } from '@/components/receive/CompactLineCard';
import { ExpiryWalk } from '@/components/receive/ExpiryWalk';
import { en } from './i18n/en';
import { he } from './i18n/he';
import { initialDraft, type FormLine, type LineDraft } from './receipt-form';

/**
 * The receive redesign's two screens (28/10), rendered to HTML: what is folded
 * and what stays open on a compact card, the Priority name over the printed
 * one, the qty-check mark, and the expiry walk's one-line card. Plus the
 * DRAFT texts they use (text freeze: Mevaser approves every new string).
 */
const TODAY = '2026-10-28';
const noop = () => {};

function line(over: Partial<FormLine> = {}): FormLine {
  return {
    index: 4,
    code: '340113',
    name_he: 'מיונז 5 ק"ג תלמה',
    name_en: '',
    qty: 3,
    unit: 'units',
    unit_label: "יח'",
    weighed: false,
    cartons: 3,
    packaging: 'bucket',
    per_pack: null,
    inner: null,
    needs_expiry: true,
    name_printed: 'מיזן 5 ק"ג תלמה בד"ץ',
    ...over,
  };
}

const draftOf = (l: FormLine, patch: Partial<LineDraft> = {}): LineDraft => ({ ...initialDraft([l]).lines[0], ...patch });

function card(l: FormLine, patch: Partial<LineDraft> = {}, errKey = 'expiry_missing'): string {
  return renderToStaticMarkup(
    createElement(CompactLineCard, {
      line: l,
      d: draftOf(l, patch),
      errKey,
      language: 'Hebrew',
      today: TODAY,
      flash: false,
      isNew: false,
      onChange: noop,
    }),
  );
}

describe('CompactLineCard', () => {
  it('Priority name as the title, the printed name under it', () => {
    const html = card(line());
    expect(html).toMatch(/<h2[^>]*>מיונז 5 ק&quot;ג תלמה<\/h2>/);
    expect(html).toContain('מיזן 5 ק&quot;ג תלמה בד&quot;ץ');
  });

  it('quantity, cartons and package fold into one row with the edit chip; the missing expiry stays open', () => {
    const html = card(line());
    expect(html).not.toContain('id="q-4"'); // quantity field folded
    expect(html).not.toContain('id="c-4"');
    expect(html).not.toContain('id="p-4"');
    expect(html).toContain('id="e-4"'); // expiry open
    expect(html).toContain(he['receive.v2.edit']);
    expect(html).toContain('3 דליים'); // 3 buckets, in the summary
  });

  it('a given expiry folds into the summary', () => {
    const html = card(line(), { expiry: '2027-03-01' }, '');
    expect(html).not.toContain('id="e-4"');
    expect(html).toContain('01/03/2027');
  });

  it('a wrong value opens its field by itself (no chip to close it)', () => {
    const html = card(line(), { qty: 'abc' }, 'qty_invalid,expiry_missing');
    expect(html).toContain('id="q-4"');
    expect(html).not.toContain(he['receive.v2.edit']);
  });

  it('a short line keeps "why short?" open', () => {
    const html = card(line(), { qty: '2', expiry: '2027-03-01' }, 'gap_missing');
    expect(html).toContain(he['receive.gapQuestion']);
  });

  it('qty × price ≠ total: amber card and the label; none without the mark', () => {
    const marked = card(line({ qty_check: 'failed' }), { expiry: '2027-03-01' }, '');
    expect(marked).toContain(he['receive.v2.qtyCheck']);
    expect(marked).toContain('border-s-warn');
    const plain = card(line(), { expiry: '2027-03-01' }, '');
    expect(plain).not.toContain(he['receive.v2.qtyCheck']);
    expect(plain).toContain('border-s-ok');
  });
});

describe('ExpiryWalk', () => {
  const lines = [
    line({ index: 1, code: '100', name_he: 'סוכר', name_printed: undefined, packaging: 'sack' }),
    line({ index: 2, needs_expiry: false }),
    line({ index: 4 }),
  ];
  const render = (drafts: LineDraft[], start: number | null) =>
    renderToStaticMarkup(
      createElement(ExpiryWalk, {
        lines,
        drafts,
        lineErrors: {},
        language: 'Hebrew',
        today: TODAY,
        start,
        onChange: noop,
        onStep: noop,
        onExit: noop,
      }),
    );

  it('one line: big name, printed name, code, package + count, the date field; progress "n of m dated"', () => {
    const drafts = initialDraft(lines).lines.map((d) => (d.index === 1 ? { ...d, noExpiry: true } : d));
    const html = render(drafts, 4);
    expect(html).toMatch(/<h2[^>]*>מיונז 5 ק&quot;ג תלמה<\/h2>/);
    expect(html).toContain('מיזן 5 ק&quot;ג תלמה בד&quot;ץ');
    expect(html).toContain('340113');
    expect(html).toContain('3 דליים');
    expect(html).toContain('id="e-4"');
    expect(html).toContain(he['receive.noExpiry']);
    expect(html).toContain('1 מתוך 2 עם תוקף'); // line 2 never needs an expiry
    expect(html).toContain(he['receive.v2.walkPick']);
    expect(html).toContain(he['receive.v2.walkNext']);
    expect(html).not.toContain('סוכר</h2>'); // one line at a time
  });

  it('every line dated → the done panel', () => {
    const drafts = initialDraft(lines).lines.map((d) => ({ ...d, noExpiry: true }));
    const html = renderToStaticMarkup(
      createElement(ExpiryWalk, {
        lines: [lines[1]], // nothing in the walk
        drafts: drafts.filter((d) => d.index === 2),
        lineErrors: {},
        language: 'Hebrew',
        today: TODAY,
        start: null,
        onChange: noop,
        onStep: noop,
        onExit: noop,
      }),
    );
    expect(html).toContain(he['receive.expiryAllSet']);
  });
});

describe('receive.v2.* texts (DRAFT, pending Mevaser)', () => {
  const v2 = (o: Record<string, string>) => Object.keys(o).filter((k) => k.startsWith('receive.v2.')).sort();

  it('the same keys in Hebrew and English, few and short', () => {
    expect(v2(he)).toEqual(v2(en));
    expect(v2(he).length).toBeLessThanOrEqual(10);
    for (const k of v2(he)) expect((he as Record<string, string>)[k].length, k).toBeLessThanOrEqual(24);
  });

  it('marked DRAFT in he.ts', () => {
    const src = readFileSync(path.join(__dirname, 'i18n/he.ts'), 'utf8');
    const at = src.indexOf("'receive.v2.");
    expect(at).toBeGreaterThan(0);
    expect(src.slice(Math.max(0, at - 400), at)).toMatch(/DRAFT.*Mevaser/);
  });
});
