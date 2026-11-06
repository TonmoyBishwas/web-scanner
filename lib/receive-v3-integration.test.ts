import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { draftToAnswers, initialDraft, normalizeFormLines, restoreDraftMerged, serializeDraft, type FormDraft } from './receipt-form';
import { getReceiptForm, postReceiptForm } from './receipt-form-client';
import {
  V3,
  initialV3Draft,
  legacyToV3Draft,
  restoreV3Draft,
  serializeV3Draft,
  v3DraftToAnswers,
  v3ToLegacyDraft,
} from './receive-v3';
import { pollFormV3, submitV3 } from './receive-v3-client';

/**
 * Receive form v3 wired into ReceiptForm (06/11, flag receive_form_v3): the
 * draft carried across a live flag flip both ways, and the one request
 * helper both forms send their save / poll through.
 */

const GET = JSON.parse(readFileSync(path.resolve(__dirname, '../test/fixtures/receive_form_get_bnei_darom.json'), 'utf8')) as {
  lines: unknown;
};
const LINES = normalizeFormLines(GET.lines);
const TODAY = '2026-11-06';

describe('legacyToV3Draft (flag switched on under today\'s form)', () => {
  it('a fresh classic draft becomes a fresh v3 draft', () => {
    expect(legacyToV3Draft(LINES, initialDraft(LINES))).toEqual(initialV3Draft(LINES));
  });

  it('keeps every typed value; the legacy answers are unchanged across the flip', () => {
    const legacy: FormDraft = initialDraft(LINES);
    legacy.pallets = '3';
    legacy.lines[0] = { ...legacy.lines[0], expiry: '2027-05-12' };
    legacy.lines[1] = { ...legacy.lines[1], qty: '2', gap: 'other', gapNote: 'נשבר' };
    legacy.lines[2] = { ...legacy.lines[2], noExpiry: true };
    legacy.extras = [{ key: 'x1', name: 'שמן', quantity: '2', unit: 'units' }];
    const v3 = legacyToV3Draft(LINES, legacy);
    expect(v3.stage).toBe('pallets');
    expect(v3.pallets).toBe(3);
    expect(v3.lines[0].expiry).toBe('12.05.2027');
    expect(v3.lines[1]).toMatchObject({ qty: '2', gap: 'other', gapNote: 'נשבר', edited: true });
    expect(v3.lines[0].edited).toBe(false);
    expect(v3.lines[2].noExpiry).toBe(true);
    expect(v3.extras).toEqual(legacy.extras);
    // What the bot reads (today's keys) is the same before and after.
    const before = draftToAnswers(LINES, legacy);
    const after = v3DraftToAnswers(LINES, v3, TODAY);
    const legacyKeys = (a: typeof after) => ({
      pallets: a.pallets,
      extras: a.extras,
      lines: a.lines.map(({ index, received_qty, cartons, packaging, expiry_date, no_expiry, gap, gap_note }) => ({
        index, received_qty, cartons, packaging, expiry_date, no_expiry, gap, gap_note,
      })),
    });
    expect(legacyKeys(after)).toEqual(legacyKeys(before as typeof after));
  });

  it('pallets over the bot\'s 50 are capped; junk pallets start at 0', () => {
    expect(legacyToV3Draft(LINES, { ...initialDraft(LINES), pallets: '120' }).pallets).toBe(V3.MAX_PALLETS);
    expect(legacyToV3Draft(LINES, { ...initialDraft(LINES), pallets: 'x' }).pallets).toBe(0);
  });

  it('the stored v3 draft restores on the reloaded page', () => {
    const legacy = initialDraft(LINES);
    legacy.lines[4] = { ...legacy.lines[4], expiry: '2027-01-31' };
    const raw = serializeV3Draft(legacyToV3Draft(LINES, legacy), LINES, 1);
    expect(restoreV3Draft(raw, LINES)?.draft.lines[4].expiry).toBe('31.01.2027');
  });
});

describe('v3ToLegacyDraft (flag switched off under v3)', () => {
  it('the stored classic draft restores in today\'s form', () => {
    const v3 = initialV3Draft(LINES);
    v3.pallets = 2;
    v3.lines[3] = { ...v3.lines[3], expiry: '01.02.2027' };
    const raw = serializeDraft(v3ToLegacyDraft(v3), LINES, 1);
    const got = restoreDraftMerged(raw, LINES);
    expect(got?.draft.pallets).toBe('2');
    expect(got?.draft.lines[3].expiry).toBe('2027-02-01');
  });
});

describe('lib/receipt-form-client.ts (the one request both forms send)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const stub = (status: number, body: string) => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
    });
    return calls;
  };

  it('POST: today\'s body {exp, sig, rev, answers}, no-store', async () => {
    const calls = stub(200, JSON.stringify({ ok: true, saved_lines: 18 }));
    const a = await postReceiptForm({ formId: 'a/b', exp: '1', sig: 's', rev: 2, answers: { pallets: 1 } });
    expect(a).toEqual({ ok: true, status: 200, data: { ok: true, saved_lines: 18 } });
    expect(calls[0].url).toBe('/api/receipt-form/a%2Fb');
    expect(calls[0].init?.method).toBe('POST');
    expect(calls[0].init?.cache).toBe('no-store');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ exp: '1', sig: 's', rev: 2, answers: { pallets: 1 } });
  });

  it('GET: the poll URL; a body that is not JSON is null', async () => {
    const calls = stub(502, '<html>');
    const a = await getReceiptForm({ formId: 'f', exp: '1', sig: 's', rev: 3 });
    expect(a).toEqual({ ok: false, status: 502, data: null });
    expect(calls[0].url).toBe('/api/receipt-form/f?exp=1&sig=s&rev=3');
  });

  it('a network failure throws (each form keeps its own catch)', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('offline');
    });
    await expect(postReceiptForm({ formId: 'f', exp: '1', sig: 's', rev: 1, answers: {} })).rejects.toThrow('offline');
    expect(await submitV3({ formId: 'f', exp: '1', sig: 's', rev: 1, answers: v3DraftToAnswers(LINES, initialV3Draft(LINES), TODAY) })).toMatchObject({
      kind: 'error',
      reason: 'network',
    });
    expect(await pollFormV3({ formId: 'f', exp: '1', sig: 's', rev: 1 })).toBeNull();
  });

  it('v3 save and poll read the same answers as before (409 lines_changed, 422, flag in the poll)', async () => {
    stub(409, JSON.stringify({ ok: false, error: 'lines_changed', rev: 2, lines: GET.lines }));
    const r = await submitV3({ formId: 'f', exp: '1', sig: 's', rev: 1, answers: v3DraftToAnswers(LINES, initialV3Draft(LINES), TODAY) });
    expect(r.kind).toBe('lines_changed');
    if (r.kind === 'lines_changed') expect(r.lines).toHaveLength(18);
    stub(422, JSON.stringify({ ok: false, error: 'invalid', errors: {} }));
    expect((await submitV3({ formId: 'f', exp: '1', sig: 's', rev: 1, answers: v3DraftToAnswers(LINES, initialV3Draft(LINES), TODAY) })).kind).toBe('error');
    stub(200, JSON.stringify({ ok: true, status: 'open', rev: 1, lines: GET.lines, features: { receive_redesign: false } }));
    expect((await pollFormV3({ formId: 'f', exp: '1', sig: 's', rev: 1 }))?.v3).toBe(false);
  });
});
