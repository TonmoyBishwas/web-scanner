import { describe, expect, it } from 'vitest';
import {
  addDaysIso,
  draftToAnswers,
  normalizeFormLines,
  parseAnswers,
  validateAnswers,
  type Answers,
  type FormLine,
} from './receipt-form';
import {
  initialV3Draft,
  isV3Answers,
  v3DraftToAnswers,
  v3ToLegacyDraft,
  validateV3,
  type AnswersV3,
  type V3Draft,
  type V3LineDraft,
} from './receive-v3';

/**
 * The v3 answers (flag receive_form_v3): the legacy keys stay exactly what
 * today's form sends, parseAnswers is byte for byte unchanged for every body
 * that is not `form_version: 3`, validateV3's error codes, and the bot's own
 * rules (telegram-warehouse-bot bot/services/receipt_form.py
 * validate_answers, mirrored below) accept every v3 body.
 */
const TODAY = '2026-11-06';

// Five Bnei Darom lines: 1 same (cans), 3 pack (1 × 3 gallons), 4 same (buckets), 5 weighed sacks, 9 pack (13 × 12).
const LINES: FormLine[] = normalizeFormLines([
  { index: 1, code: '92028', name_he: 'גמבה קוביות פח', qty: 7, unit: 'units', unit_label: 'יחידות', cartons: 7, packaging: 'can', needs_expiry: true },
  { index: 3, code: '92030', name_he: 'חומץ 5% גלון', qty: 3, unit: 'units', unit_label: 'יחידות', cartons: 1, packaging: 'carton', per_pack: 3, inner: 'gallon', needs_expiry: true },
  { index: 4, code: '92031', name_he: 'טחינה 18 ק"ג', qty: 2, unit: 'units', unit_label: 'יחידות', cartons: 2, packaging: 'bucket', needs_expiry: true },
  { index: 5, code: '92032', name_he: 'כורכום 5 ק"ג', qty: 20, unit: 'kg', unit_label: 'ק"ג', weighed: true, cartons: 20, packaging: 'sack', needs_expiry: true },
  { index: 9, code: '92036', name_he: 'מלח דק', qty: 156, unit: 'units', unit_label: 'יחידות', cartons: 13, packaging: 'carton', per_pack: 12, inner: 'unit', needs_expiry: false },
]);

function draft(pallets: number, patches: Record<number, Partial<V3LineDraft>> = {}, loose: Record<number, number> = {}): V3Draft {
  const d = initialV3Draft(LINES);
  return {
    ...d,
    stage: 'list',
    pallets,
    loose,
    lines: d.lines.map((l) => ({ ...l, expiry: '12.05.2027', ...(patches[l.index] ?? {}) })),
  };
}

const LEGACY_KEYS = ['index', 'received_qty', 'cartons', 'packaging', 'expiry_date', 'no_expiry', 'gap', 'gap_note'] as const;
function legacySubset(a: AnswersV3): Answers {
  return {
    pallets: a.pallets,
    lines: a.lines.map((l) => Object.fromEntries(LEGACY_KEYS.map((k) => [k, l[k]])) as unknown as Answers['lines'][number]),
    extras: a.extras,
  };
}

/** The fixtures every check below runs on. */
const FIXTURES: [string, V3Draft][] = [
  ['all on one pallet', draft(1)],
  ['two pallets, chosen', draft(2, { 1: { pallet: 1 }, 3: { pallet: 2 }, 4: { pallet: 2 }, 5: { pallet: 1 }, 9: { pallet: 2 } })],
  ['0 pallets, all loose', draft(0, {}, { 1: 7, 3: 1 })],
  ['short with reasons, 0 received, no expiry', draft(1, {
    1: { qty: '5', cartons: '5', gap: 'will' },
    3: { qty: '0', cartons: '0', gap: 'other', gapNote: '  נשבר  ' },
    4: { noExpiry: true, expiry: '' },
    9: { expiry: '' },
  })],
  ['split, partly loose, extra', {
    ...draft(2, {
      1: { pallet: 2, split: [{ qty: '4', date: '20.06.2027' }, { qty: '3', date: '12.05.2027' }], expiry: '' },
      3: { pallet: 1 },
      4: { pallet: 1 },
      5: { qty: '18.5', gap: 'wont', split: [{ qty: '10', date: '12.05.2027' }, { qty: '8.5', date: '01.03.2027' }] },
      9: { pallet: 2 },
    }, { 5: 2 }),
    extras: [{ key: 'x1', name: ' קטשופ היינץ 4 ק"ג ', quantity: '2', unit: 'cartons' }],
  }],
];

describe('v3DraftToAnswers', () => {
  it.each(FIXTURES)('%s: legacy keys = draftToAnswers(v3ToLegacyDraft(...))', (_, d) => {
    const a = v3DraftToAnswers(LINES, d, TODAY);
    const legacy = draftToAnswers(LINES, v3ToLegacyDraft(d));
    expect(legacySubset(a)).toEqual({ ...legacy, pallets: d.pallets });
    expect(a.form_version).toBe(3);
    expect(isV3Answers(a)).toBe(true);
  });

  it.each(FIXTURES)('%s: passes validateAnswers and validateV3', (_, d) => {
    const a = v3DraftToAnswers(LINES, d, TODAY);
    expect(validateAnswers(LINES, a, TODAY)).toMatchObject({ ok: true });
    expect(validateV3(LINES, a, TODAY)).toEqual({ ok: true, lines: {}, form: [] });
  });

  it('pallet / loose keys', () => {
    let a = v3DraftToAnswers(LINES, draft(1), TODAY);
    expect(a.lines.map((l) => l.pallet)).toEqual([1, 1, 1, 1, 1]);
    expect(a.lines.every((l) => !('loose_qty' in l))).toBe(true);
    expect(a.loose_lines).toBe(0);

    a = v3DraftToAnswers(LINES, draft(0, {}, { 1: 7, 3: 1 }), TODAY);
    expect(a.lines.map((l) => [l.index, l.pallet, l.loose_qty])).toEqual([
      [1, 'loose', 7], [3, 'loose', 1], [4, 'loose', undefined], [5, 'loose', undefined], [9, 'loose', undefined],
    ]);
    expect(a.loose_lines).toBe(2);

    // Partly loose [DEFAULT 2]: the chosen pallet (or 1 on one pallet, else null) + the loose count.
    a = v3DraftToAnswers(LINES, draft(2, { 1: { pallet: 2 }, 4: {} }, { 1: 3, 4: 1 }), TODAY);
    expect(a.lines.find((l) => l.index === 1)).toMatchObject({ pallet: 2, loose_qty: 3 });
    expect(a.lines.find((l) => l.index === 4)).toMatchObject({ pallet: null, loose_qty: 1 });
    a = v3DraftToAnswers(LINES, draft(1, {}, { 1: 3 }), TODAY);
    expect(a.lines.find((l) => l.index === 1)).toMatchObject({ pallet: 1, loose_qty: 3 });
    // A loose count above the packages (cartons lowered later) is capped: whole line loose.
    a = v3DraftToAnswers(LINES, draft(2, { 4: { qty: '1', cartons: '1', gap: 'will' } }, { 4: 2 }), TODAY);
    expect(a.lines.find((l) => l.index === 4)).toMatchObject({ pallet: 'loose', loose_qty: 1 });
  });

  it('a line with nothing received: no pallet, no expiry, no splits, no loose', () => {
    const a = v3DraftToAnswers(LINES, draft(2, { 4: { qty: '0', cartons: '0', gap: 'wont', split: [{ qty: '1', date: '12.05.2027' }, { qty: '1', date: '' }] } }, { 4: 1 }), TODAY);
    const l = a.lines.find((x) => x.index === 4)!;
    expect(l).toMatchObject({ received_qty: 0, pallet: null, expiry_date: null, no_expiry: false });
    expect('splits' in l).toBe(false);
    expect('loose_qty' in l).toBe(false);
  });

  it("splits: rows as numbers + ISO, always in the line's quantity, expiry_date = the earliest", () => {
    const a = v3DraftToAnswers(LINES, FIXTURES[4][1], TODAY);
    expect(a.lines.find((l) => l.index === 1)).toMatchObject({
      expiry_date: '2027-05-12',
      no_expiry: false,
      split_unit: 'qty',
      splits: [{ qty: 4, expiry_date: '2027-06-20' }, { qty: 3, expiry_date: '2027-05-12' }],
    });
    expect(a.lines.find((l) => l.index === 5)).toMatchObject({
      received_qty: 18.5,
      expiry_date: '2027-03-01',
      split_unit: 'qty',
      splits: [{ qty: 10, expiry_date: '2027-05-12' }, { qty: 8.5, expiry_date: '2027-03-01' }],
    });
    expect(a.extras).toEqual([{ name: 'קטשופ היינץ 4 ק"ג', quantity: 2, unit: 'cartons' }]);
  });
});

// ── parseAnswers: byte for byte for every body that is not v3 ─────────────

const TODAY_BODY = {
  pallets: 2,
  lines: [
    { index: 1, received_qty: 7, cartons: 7, packaging: 'can', expiry_date: '2027-05-12', no_expiry: false, gap: null, gap_note: null },
    { index: 4, received_qty: 1, cartons: 1, packaging: 'bucket', expiry_date: '', gap: 'other', gap_note: 'x' },
  ],
  extras: [{ name: ' a ', quantity: 1, unit: 'units' }],
};
/** What parseAnswers gave for TODAY_BODY before v3 (key order included). */
const TODAY_PARSED =
  '{"pallets":2,"lines":[' +
  '{"index":1,"received_qty":7,"cartons":7,"packaging":"can","expiry_date":"2027-05-12","no_expiry":false,"gap":null,"gap_note":null},' +
  '{"index":4,"received_qty":1,"cartons":1,"packaging":"bucket","expiry_date":null,"no_expiry":false,"gap":"other","gap_note":"x"}],' +
  '"extras":[{"name":"a","quantity":1,"unit":"units"}]}';

describe('parseAnswers', () => {
  it("a today body comes out exactly as before", () => {
    expect(JSON.stringify(parseAnswers(TODAY_BODY))).toBe(TODAY_PARSED);
  });

  it('v3 keys on a body that is not form_version 3 are dropped (as any unknown key)', () => {
    const body = {
      ...TODAY_BODY,
      loose_lines: 'x',
      form_version: 2,
      lines: TODAY_BODY.lines.map((l) => ({ ...l, pallet: 'junk', loose_qty: 'x', splits: 7, split_unit: 9 })),
    };
    expect(JSON.stringify(parseAnswers(body))).toBe(TODAY_PARSED);
  });

  it('a v3 body keeps its keys', () => {
    const a = v3DraftToAnswers(LINES, FIXTURES[4][1], TODAY);
    const parsed = parseAnswers(JSON.parse(JSON.stringify(a)));
    expect(parsed).toEqual(a);
    expect(isV3Answers(parsed)).toBe(true);
  });

  it('a v3 body without loose_lines counts the loose lines', () => {
    const a = v3DraftToAnswers(LINES, FIXTURES[2][1], TODAY);
    const { loose_lines: _drop, ...rest } = a;
    void _drop;
    expect((parseAnswers(rest) as AnswersV3).loose_lines).toBe(2);
  });

  it.each([
    ['pallet a string', { pallet: 'one' }],
    ['pallet a fraction', { pallet: 1.5 }],
    ['loose_qty a string', { loose_qty: '1' }],
    ['loose_qty a fraction', { loose_qty: 1.5 }],
    ['split_unit unknown', { split_unit: 'kg' }],
    ['splits not an array', { splits: { qty: 1 } }],
    ['splits too many', { splits: [1, 2, 3, 4].map(() => ({ qty: 1, expiry_date: '2027-05-12' })) }],
    ['a split qty a string', { splits: [{ qty: '1', expiry_date: '2027-05-12' }, { qty: 1, expiry_date: '2027-05-12' }] }],
    ['a split date missing', { splits: [{ qty: 1 }, { qty: 1, expiry_date: '2027-05-12' }] }],
  ])('a v3 body with %s → null (400 bad_answers)', (_, bad) => {
    const body = { ...TODAY_BODY, form_version: 3, lines: [{ ...TODAY_BODY.lines[0], ...bad }, TODAY_BODY.lines[1]] };
    expect(parseAnswers(body)).toBeNull();
  });

  it('a v3 body with a fractional loose_lines → null', () => {
    expect(parseAnswers({ ...TODAY_BODY, form_version: 3, loose_lines: 1.5 })).toBeNull();
  });
});

// ── validateV3 ────────────────────────────────────────────────────────────

describe('validateV3', () => {
  const good = () => v3DraftToAnswers(LINES, FIXTURES[1][1], TODAY);
  const withLine = (a: AnswersV3, index: number, patch: Record<string, unknown>): AnswersV3 => ({
    ...a,
    lines: a.lines.map((l) => (l.index === index ? { ...l, ...patch } : l)),
  });

  it('pallets 0..50, a whole number; 51 refused', () => {
    expect(validateV3(LINES, { ...good(), pallets: 51 }, TODAY).form).toContain('pallets_range');
    expect(validateV3(LINES, { ...good(), pallets: 1.5 }, TODAY).form).toContain('pallets_range');
    expect(validateV3(LINES, { ...good(), pallets: null }, TODAY).form).toContain('pallets_range');
    expect(validateV3(LINES, { ...good(), pallets: 50 }, TODAY).form).not.toContain('pallets_range');
  });

  it('nothing_to_receive: 0 pallets and nothing outside', () => {
    const a = v3DraftToAnswers(LINES, draft(0), TODAY);
    const none: AnswersV3 = { ...a, lines: a.lines.map((l) => ({ ...l, pallet: 1, loose_qty: undefined })) };
    expect(validateV3(LINES, none, TODAY).form).toContain('nothing_to_receive');
    expect(validateV3(LINES, a, TODAY).form).not.toContain('nothing_to_receive');
  });

  it('pallet_missing / pallet_out_of_range', () => {
    expect(validateV3(LINES, withLine(good(), 1, { pallet: null }), TODAY).lines[1]).toEqual(['pallet_missing']);
    expect(validateV3(LINES, withLine(good(), 1, { pallet: undefined }), TODAY).lines[1]).toEqual(['pallet_missing']);
    expect(validateV3(LINES, withLine(good(), 1, { pallet: 3 }), TODAY).lines[1]).toEqual(['pallet_out_of_range']);
    expect(validateV3(LINES, withLine(good(), 1, { pallet: 0 }), TODAY).lines[1]).toEqual(['pallet_out_of_range']);
    const zero = v3DraftToAnswers(LINES, draft(0, {}, { 1: 7 }), TODAY);
    expect(validateV3(LINES, withLine(zero, 4, { pallet: 1 }), TODAY).lines[4]).toEqual(['pallet_out_of_range']);
    // Nothing received: no pallet needed. Partly loose with no pallet: fine (spec O9).
    expect(validateV3(LINES, withLine(good(), 1, { pallet: null, received_qty: 0 }), TODAY).lines[1]).toBeUndefined();
    expect(validateV3(LINES, withLine(good(), 1, { pallet: null, loose_qty: 2 }), TODAY).lines[1]).toBeUndefined();
  });

  it('loose_invalid: 1 ≤ loose_qty ≤ max(cartons, 1), whole', () => {
    expect(validateV3(LINES, withLine(good(), 1, { loose_qty: 0 }), TODAY).lines[1]).toEqual(['loose_invalid']);
    expect(validateV3(LINES, withLine(good(), 1, { loose_qty: 8 }), TODAY).lines[1]).toEqual(['loose_invalid']);
    expect(validateV3(LINES, withLine(good(), 1, { loose_qty: 1.5 }), TODAY).lines[1]).toEqual(['loose_invalid']);
    expect(validateV3(LINES, withLine(good(), 1, { loose_qty: 7 }), TODAY).lines[1]).toBeUndefined();
    expect(validateV3(LINES, withLine(good(), 1, { cartons: null, loose_qty: 1 }), TODAY).lines[1]).toBeUndefined();
  });

  it('split_invalid / split_sum / split_expiry', () => {
    const base = v3DraftToAnswers(LINES, FIXTURES[4][1], TODAY);
    const rows = [{ qty: 4, expiry_date: '2027-06-20' }, { qty: 3, expiry_date: '2027-05-12' }];
    expect(validateV3(LINES, base, TODAY).ok).toBe(true);
    expect(validateV3(LINES, withLine(base, 1, { splits: [rows[0]] }), TODAY).lines[1]).toEqual(['split_invalid']);
    expect(validateV3(LINES, withLine(base, 1, { splits: [{ ...rows[0], qty: 0 }, rows[1]] }), TODAY).lines[1]).toEqual(['split_invalid']);
    expect(validateV3(LINES, withLine(base, 1, { splits: [{ ...rows[0], expiry_date: TODAY }, rows[1]] }), TODAY).lines[1]).toEqual(['split_invalid']);
    expect(validateV3(LINES, withLine(base, 1, { split_unit: undefined }), TODAY).lines[1]).toEqual(['split_invalid']);
    expect(validateV3(LINES, withLine(base, 1, { splits: [{ ...rows[0], qty: 5 }, rows[1]] }), TODAY).lines[1]).toEqual(['split_sum']);
    expect(validateV3(LINES, withLine(base, 1, { expiry_date: '2027-06-20' }), TODAY).lines[1]).toEqual(['split_expiry']);
    expect(validateV3(LINES, withLine(base, 1, { no_expiry: true }), TODAY).lines[1]).toEqual(['split_expiry']);
    // 'qty' basis = received_qty (the weighed line 5: 18.5 kg).
    expect(validateV3(LINES, withLine(base, 5, { received_qty: 19 }), TODAY).lines[5]).toEqual(['split_sum']);
  });
});

// ── The bot's rules (receipt_form.validate_answers), mirrored ─────────────

/** TS mirror of telegram-warehouse-bot bot/services/receipt_form.py validate_answers (origin/whatsapp). */
function botValidate(lines: FormLine[], answers: Answers, today: string): string[] {
  const errors: string[] = [];
  const byLine = new Map(answers.lines.map((a) => [a.index, a]));
  for (const line of lines) {
    const a = byLine.get(line.index);
    if (!a) {
      errors.push(`${line.index}:missing`);
      continue;
    }
    const q = a.received_qty;
    if (typeof q !== 'number' || !Number.isFinite(q) || q < 0 || q > 1e6) {
      errors.push(`${line.index}:bad_qty`);
      continue;
    }
    if (a.cartons !== null && (!Number.isInteger(a.cartons) || a.cartons < 0)) errors.push(`${line.index}:bad_cartons`);
    const expiry = a.expiry_date || null;
    if (expiry !== null) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry)) errors.push(`${line.index}:bad_expiry`);
      else if (expiry <= today) errors.push(`${line.index}:expiry_not_after_today`);
      else if (expiry > addDaysIso(today, 366 * 15)) errors.push(`${line.index}:expiry_too_far`);
    }
    if (line.needs_expiry && q > 0 && !expiry && !a.no_expiry) errors.push(`${line.index}:expiry_missing`);
    const gap = a.gap || null;
    const note = (a.gap_note ?? '').split(/\s+/).filter(Boolean).join(' ').slice(0, 500) || null;
    const short = q < line.qty - 0.0005;
    if (gap !== null && !['will', 'wont', 'other'].includes(gap)) errors.push(`${line.index}:bad_gap`);
    if (short && gap === null) errors.push(`${line.index}:gap_missing`);
    if (gap === 'other' && !note) errors.push(`${line.index}:gap_note_missing`);
  }
  if (answers.extras.length > 20) errors.push('form:bad_extras');
  answers.extras.forEach((x, n) => {
    const name = x.name.split(/\s+/).filter(Boolean).join(' ').slice(0, 120);
    if (!name || !(x.quantity > 0) || x.quantity > 1e6) errors.push(`extra${n + 1}:invalid`);
  });
  const p = answers.pallets;
  if (p !== null && (!Number.isInteger(p) || p < 0 || p > 50)) errors.push('form:bad_pallets');
  return errors;
}

describe('bot compatibility', () => {
  it.each(FIXTURES)('%s: the bot accepts the legacy keys', (_, d) => {
    const a = v3DraftToAnswers(LINES, d, TODAY);
    expect(botValidate(LINES, legacySubset(a), TODAY)).toEqual([]);
    // …and the full v3 body too (it ignores the extra keys).
    expect(botValidate(LINES, a, TODAY)).toEqual([]);
  });

  it('the mirror does refuse what the bot refuses (51 pallets, a past date)', () => {
    const a = v3DraftToAnswers(LINES, draft(1), TODAY);
    expect(botValidate(LINES, { ...a, pallets: 51 }, TODAY)).toEqual(['form:bad_pallets']);
    const past = { ...a, lines: a.lines.map((l) => (l.index === 1 ? { ...l, expiry_date: TODAY } : l)) };
    expect(botValidate(LINES, past, TODAY)).toEqual(['1:expiry_not_after_today']);
  });
});
