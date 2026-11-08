import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// ReceiptForm now also carries the v3 form, whose next/font module works only inside a Next build.
vi.mock('@/components/receive/v3/font', () => ({ rubik: { variable: 'v3font', className: 'v3font' } }));

import { ReceiptForm } from '@/app/receive/[id]/ReceiptForm';
import { normalizeFormLines, type FormHeader } from './receipt-form';
import type { ReceiveV3Boot } from './receive-v3';

/**
 * Flag off = today's form, byte for byte (receive form v3, 06/11, flag
 * receive_form_v3). ReceiptForm is rendered for the Bnei Darom test note
 * (the GET answer saved 06/11, features {receive_redesign: false}, no
 * receive_form_v3 key) and compared with the markup origin/preview's
 * ReceiptForm (177d411, before v3) gives for the same props, saved in
 * test/fixtures/receipt_form_classic_177d411*.html.
 *
 * Regenerate (only if the classic form is meant to change): copy this file
 * into a checkout of the older commit and run it with
 * RECEIPT_FORM_BASELINE_OUT=<dir>; it writes the two files instead of comparing.
 */

const FIXTURES = path.resolve(__dirname, '../test/fixtures');
const GET = JSON.parse(readFileSync(path.join(FIXTURES, 'receive_form_get_bnei_darom.json'), 'utf8')) as {
  header: FormHeader;
  lines: unknown;
  features: Record<string, unknown>;
};
const OUT = process.env.RECEIPT_FORM_BASELINE_OUT;

const BOOT: ReceiveV3Boot = { notePhotos: [], erp: 'priority', botWaNumber: null, today: '2026-11-06' };

function renderClassic(redesign: boolean, v3?: ReceiveV3Boot): string {
  return renderToStaticMarkup(
    createElement(ReceiptForm, {
      ...(v3 ? { v3 } : {}),
      formId: '7e0f2a43-0000-4000-8000-000000000001',
      exp: '1762600000',
      sig: 'f'.repeat(64),
      language: 'Hebrew',
      header: GET.header,
      lines: normalizeFormLines(GET.lines),
      previousFormIds: [],
      redesign,
    }),
  );
}

describe('ReceiptForm with receive_form_v3 off', () => {
  beforeAll(() => {
    // The form shows today's date limits: pin "today" so the markup is stable.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-06T10:00:00Z'));
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  it('the fixture is a flag-off GET answer (no receive_form_v3 key)', () => {
    expect(GET.features).toEqual({ receive_redesign: false });
    expect(normalizeFormLines(GET.lines)).toHaveLength(18);
  });

  for (const [name, redesign] of [
    ['classic', false],
    ['redesign', true],
  ] as const) {
    it(`${name} (redesign=${redesign}) renders byte for byte as origin/preview 177d411`, () => {
      const html = renderClassic(redesign);
      const file = path.join(FIXTURES, `receipt_form_classic_177d411${redesign ? '_redesign' : ''}.html`);
      if (OUT) {
        writeFileSync(path.join(OUT, path.basename(file)), html);
        return;
      }
      expect(html.length).toBeGreaterThan(1000);
      expect(html).toBe(readFileSync(file, 'utf8'));
    });
  }

  it('v3 handed in (flag on) renders the v3 form instead, and wins over the 28/10 redesign', () => {
    for (const redesign of [false, true]) {
      const html = renderClassic(redesign, BOOT);
      expect(html).toContain('data-v3-screen="pallets"');
      // None of today's form: its sticky footer and its line sections are gone.
      expect(html).not.toContain('<footer');
      expect(html).not.toContain('id="line-1"');
    }
  });

  it('v3: null renders today\'s form exactly as without the prop', () => {
    const html = renderToStaticMarkup(
      createElement(ReceiptForm, {
        v3: null,
        formId: '7e0f2a43-0000-4000-8000-000000000001',
        exp: '1762600000',
        sig: 'f'.repeat(64),
        language: 'Hebrew',
        header: GET.header,
        lines: normalizeFormLines(GET.lines),
        previousFormIds: [],
        redesign: false,
      }),
    );
    expect(html).toBe(renderClassic(false));
  });
});
