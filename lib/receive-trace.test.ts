import { describe, expect, it } from 'vitest';
import {
  FIELD_DEBOUNCE_MS,
  RECEIVE_EVENT_SET,
  ReceiveTracker,
  areaOfId,
  changedLineCount,
  errorCounts,
  fixErrors,
  lineFieldChanges,
  searchPayload,
  traceValue,
  type ReceiveEvent,
} from './receive-trace';
import { initialDraft, type FormLine, type LineDraft } from './receipt-form';

const line = (index: number, extra: Partial<FormLine> = {}): FormLine => ({
  index, code: `15020${index}`, name_he: `פריט ${index}`, name_en: '', qty: 10, unit: 'units', unit_label: "יח'",
  weighed: false, cartons: 1, packaging: 'carton', per_pack: null, inner: null, needs_expiry: true, ...extra,
});
const LINES = [line(1), line(2), line(3)];

function setup(errors: Record<number, string[]> = {}) {
  const events: ReceiveEvent[] = [];
  const t = new ReceiveTracker({
    start: 1_000,
    lineOf: (i) => LINES.find((l) => l.index === i),
    errorsOf: (i) => errors[i] ?? [],
    emit: (e) => events.push(e),
  });
  const named = (name: string) => events.filter((e) => e.event === name);
  return { t, events, named };
}

const draftOf = (i: number, over: Partial<LineDraft> = {}): LineDraft => ({
  index: i, qty: '10', cartons: '1', packaging: 'carton', expiry: '', noExpiry: false, gap: null, gapNote: '', ...over,
});

describe('builders', () => {
  it('traceValue keeps short values and never free text', () => {
    expect(traceValue('qty', '180')).toBe('180');
    expect(traceValue('no_expiry', true)).toBe(true);
    expect(traceValue('expiry', 'x'.repeat(40))).toHaveLength(24);
    expect(traceValue('gap_note', 'הספק אמר שיביא מחר')).toBe(18);
    expect(traceValue('extra_name', 'מלח')).toBe(3);
    expect(traceValue('gap', null)).toBeNull();
  });

  it('lineFieldChanges maps draft keys to field names and skips unchanged keys', () => {
    const before = draftOf(2, { qty: '1.5' });
    expect(lineFieldChanges(before, { qty: '180', noExpiry: false, expiry: '2026-12-01' })).toEqual([
      { field: 'qty', old: '1.5', new: '180' },
      { field: 'expiry', old: '', new: '2026-12-01' },
    ]);
    expect(lineFieldChanges(before, { gapNote: 'abc' })).toEqual([{ field: 'gap_note', old: '', new: 'abc' }]);
  });

  it('changedLineCount counts lines whose answer differs from the note', () => {
    const base = initialDraft(LINES);
    const now = { ...base, lines: base.lines.map((l) => (l.index === 2 ? { ...l, qty: '100' } : l.index === 3 ? { ...l, expiry: '2027-01-01' } : l)) };
    expect(changedLineCount(base, base)).toBe(0);
    expect(changedLineCount(base, now)).toBe(2);
  });

  it('errorCounts / fixErrors', () => {
    expect(errorCounts({ 1: ['expiry_missing'], 2: ['expiry_missing', 'qty_invalid'] })).toEqual({ expiry_missing: 2, qty_invalid: 1 });
    expect(fixErrors(['expiry_missing', 'expiry_not_future', 'gap_missing'])).toEqual(['expiry_not_future']);
    expect(fixErrors(undefined)).toEqual([]);
  });

  it('searchPayload is short and names the first results', () => {
    const p = searchPayload('  סוכר  ', { active: true, fuzzy: false, lines: [{ index: 7 }, { index: 9 }] }, 21);
    expect(p).toEqual({ q: 'סוכר', q_len: 4, results: 2, fuzzy: false, first: [7, 9], total: 21 });
    expect((searchPayload('א'.repeat(80), { active: true, lines: [] }, 21).q as string).length).toBe(40);
  });

  it('areaOfId knows the line ids and the form parts', () => {
    expect(areaOfId('line-12')).toBe(12);
    expect(areaOfId('q-3')).toBe(3);
    expect(areaOfId('e-21')).toBe(21);
    expect(areaOfId('pallets')).toBe('pallets');
    expect(areaOfId('same-date')).toBe('tools');
    expect(areaOfId('expiry-tools')).toBe('tools');
    expect(areaOfId('extras')).toBe('extras');
    expect(areaOfId('line-x')).toBeNull();
    expect(areaOfId('')).toBeNull();
  });

  it('every event the tracker emits is one the server accepts', () => {
    const { t, events } = setup({ 1: ['expiry_not_future'] });
    t.focus(1, 2_000);
    t.lineEdit(1, draftOf(1), { expiry: '2020-01-01' }, 2_100);
    t.tick(2_100 + FIELD_DEBOUNCE_MS);
    t.visibility(false, 5_000);
    t.visibility(true, 6_000);
    t.readyLines(new Set(), 6_000, 3);
    t.readyLines(new Set([2]), 7_000, 3);
    t.readyLines(new Set([3]), 8_000, 3);
    t.leave(9_000);
    expect(events.length).toBeGreaterThan(5);
    for (const e of events) expect(RECEIVE_EVENT_SET.has(e.event)).toBe(true);
  });
});

describe('ReceiveTracker — field changes', () => {
  it('a burst of typing on one field is one event, old → final, after the quiet period', () => {
    const { t, named } = setup();
    const d = draftOf(2, { qty: '1.5' });
    t.lineEdit(2, d, { qty: '1' }, 10_000);
    t.lineEdit(2, { ...d, qty: '1' }, { qty: '18' }, 10_200);
    t.lineEdit(2, { ...d, qty: '18' }, { qty: '180' }, 10_400);
    t.tick(10_400 + FIELD_DEBOUNCE_MS - 1);
    expect(named('receive_field_change')).toHaveLength(0);
    t.tick(10_400 + FIELD_DEBOUNCE_MS);
    const [e] = named('receive_field_change');
    expect(e.data).toMatchObject({ line: 2, line_code: '150202', field: 'qty', old: '1.5', new: '180', keystrokes: 3, ms: 400, errs: [] });
  });

  it('moving to another field cuts the previous one at once', () => {
    const { t, named } = setup();
    t.lineEdit(1, draftOf(1), { qty: '9' }, 1_000);
    t.lineEdit(1, draftOf(1, { qty: '9' }), { cartons: '2' }, 1_100);
    expect(named('receive_field_change').map((e) => e.data?.field)).toEqual(['qty']);
    t.cut();
    expect(named('receive_field_change').map((e) => e.data?.field)).toEqual(['qty', 'cartons']);
  });

  it('typed and typed back is not a change; free text is only a length', () => {
    const { t, named } = setup();
    t.lineEdit(1, draftOf(1), { qty: '1' }, 1_000);
    t.lineEdit(1, draftOf(1, { qty: '1' }), { qty: '10' }, 1_100);
    t.cut();
    expect(named('receive_field_change')).toHaveLength(0);
    t.lineEdit(1, draftOf(1), { gapNote: 'הספק יביא מחר' }, 2_000);
    t.cut();
    expect(named('receive_field_change')[0].data).toMatchObject({ field: 'gap_note', old: 0, new: 13 });
    expect(JSON.stringify(named('receive_field_change')[0])).not.toContain('הספק');
  });

  it('a value the form calls wrong is also a validation event', () => {
    const { t, named } = setup({ 3: ['expiry_not_future'] });
    t.lineEdit(3, draftOf(3), { expiry: '2020-01-01' }, 1_000);
    t.cut();
    expect(named('receive_field_change')[0].data?.errs).toEqual(['expiry_not_future']);
    expect(named('receive_validation_error')[0].data).toMatchObject({ line: 3, field: 'expiry', errs: ['expiry_not_future'], at: 'field' });
  });

  it('"still to fill in" is not a validation error', () => {
    const { t, named } = setup({ 3: ['expiry_missing'] });
    t.lineEdit(3, draftOf(3, { expiry: '2027-01-01' }), { expiry: '' }, 1_000);
    t.cut();
    expect(named('receive_validation_error')).toHaveLength(0);
  });

  it('pallets and extras are recorded under their own key', () => {
    const { t, named } = setup();
    t.formEdit('pallets', 'pallets', '', '3', 1_000);
    t.formEdit('extra:x1', 'extra_name', '', 'שמן', 1_200);
    t.cut();
    expect(named('receive_field_change').map((e) => e.data)).toEqual([
      { field: 'pallets', old: '', new: '3', keystrokes: 1, ms: 0 },
      { extra: 'x1', field: 'extra_name', old: 0, new: 3, keystrokes: 1, ms: 0 },
    ]);
  });
});

describe('ReceiveTracker — time per line', () => {
  it('focus / leave give the visit length, the busy part, and the gap between lines', () => {
    const { t, named } = setup();
    t.focus(1, 10_000);
    t.lineEdit(1, draftOf(1), { expiry: '2027-01-01' }, 14_000); // last touch on line 1
    t.focus(2, 70_000); // a minute later: he walked the pallets looking for item 2
    const leave = named('receive_line_leave')[0].data;
    expect(leave).toMatchObject({ line: 1, line_code: '150201', ms: 60_000, busy_ms: 4_000, total_ms: 60_000, visit: 1, edits: 1 });
    const focus2 = named('receive_line_focus')[1].data;
    expect(focus2).toMatchObject({ line: 2, visit: 1, between_ms: 56_000, since_load_ms: 69_000 });
  });

  it('a hidden tab pauses the clock of the open visit', () => {
    const { t, named } = setup();
    t.focus(1, 0);
    t.visibility(false, 10_000);
    t.visibility(true, 100_000);
    t.leave(105_000);
    expect(named('receive_line_leave')[0].data?.ms).toBe(15_000);
    expect(named('receive_visibility').map((e) => e.data?.state)).toEqual(['hidden', 'visible']);
    expect(named('receive_visibility')[0].kind).toBe('lifecycle');
  });

  it('a second focus of the same area is not a new visit; non-line areas close a line visit', () => {
    const { t, named } = setup();
    t.focus(2, 0);
    t.focus(2, 500);
    t.focus('search', 2_000);
    t.focus(2, 9_000);
    expect(named('receive_line_focus').map((e) => e.data?.visit)).toEqual([1, 2]);
    expect(named('receive_line_leave')).toHaveLength(1);
    expect(t.lineActiveMs(2, 10_000)).toBe(3_000);
  });

  it('editing a line makes it the active one without a focus event', () => {
    const { t, named } = setup();
    t.lineEdit(3, draftOf(3), { qty: '5' }, 1_000);
    expect(named('receive_line_focus')[0].data?.line).toBe(3);
  });
});

describe('ReceiveTracker — lines becoming complete', () => {
  it('the first call is the baseline; then one event per completed line with the cadence', () => {
    const { t, named } = setup();
    t.readyLines(new Set([1]), 1_000, 3);
    expect(named('receive_line_done')).toHaveLength(0);
    t.focus(2, 2_000);
    t.readyLines(new Set([1, 2]), 32_000, 3);
    t.readyLines(new Set([1, 2, 3]), 92_000, 3);
    const done = named('receive_line_done').map((e) => e.data);
    expect(done[0]).toMatchObject({ line: 2, active_ms: 30_000, visits: 1, since_prev_done_ms: null, since_load_ms: 31_000, ready: 2, total: 3 });
    expect(done[1]).toMatchObject({ line: 3, since_prev_done_ms: 60_000, ready: 3 });
  });

  it('a bulk tool completing many lines is one event; a line falling back is "reopened"', () => {
    const { t, named } = setup();
    t.readyLines(new Set(), 0, 21);
    t.readyLines(new Set([1, 2, 3, 4, 5, 6]), 5_000, 21);
    expect(named('receive_line_done')).toHaveLength(1);
    expect(named('receive_line_done')[0].data).toMatchObject({ bulk: true, count: 6, lines: [1, 2, 3, 4, 5, 6] });
    t.readyLines(new Set([1, 2, 3, 4, 5]), 6_000, 21);
    expect(named('receive_line_reopened')[0].data).toMatchObject({ lines: [6], ready: 5, total: 21 });
  });

  it('summary lists the slowest lines first', () => {
    const { t } = setup();
    t.focus(1, 0);
    t.focus(2, 10_000);
    t.focus(3, 70_000);
    const s = t.summary(75_000);
    expect(s.lines_visited).toBe(3);
    expect(s.slowest.map((r) => [r.line, r.ms])).toEqual([[2, 60_000], [1, 10_000], [3, 5_000]]);
  });
});

describe('ReceiveTracker never throws to the form', () => {
  it('a failing emit is swallowed', () => {
    const t = new ReceiveTracker({ start: 0, lineOf: () => undefined, emit: () => { throw new Error('boom'); } });
    expect(() => {
      t.focus(1, 1);
      t.lineEdit(1, draftOf(1), { qty: '2' }, 2);
      t.cut();
      t.readyLines(new Set(), 3, 1);
      t.readyLines(new Set([1]), 4, 1);
      t.leave(5);
    }).not.toThrow();
  });
});
