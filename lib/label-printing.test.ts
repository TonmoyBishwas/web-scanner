import { afterEach, describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  labelPrintingEnabled,
  labelsChipLook,
  labelsInitialStatus,
  newCartonUncountedToast,
  unprintedMarkers,
  withoutPrintChips,
} from './label-printing';
import { printGate, blockingLabels, type GateLabel } from './label-gate';

const identical = (barcode: string, batch = 'b-ident'): GateLabel => ({ barcode, batch_id: batch, origin: 'identical' });
const newCarton = (barcode: string, batch = 'b-new'): GateLabel => ({ barcode, batch_id: batch, origin: 'new_carton' });

const ENV_KEYS = ['LABEL_PRINT_GATE', 'LABEL_PRINTING_ENABLED'] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('LABEL_PRINTING_ENABLED', () => {
  it('is off unless the env says on / true / yes / 1 (the bot accepts the same)', () => {
    expect(labelPrintingEnabled(undefined)).toBe(false);
    expect(labelPrintingEnabled('')).toBe(false);
    expect(labelPrintingEnabled('off')).toBe(false);
    expect(labelPrintingEnabled('no')).toBe(false);
    expect(labelPrintingEnabled('on')).toBe(true);
    expect(labelPrintingEnabled(' ON ')).toBe(true);
    expect(labelPrintingEnabled('true')).toBe(true);
    expect(labelPrintingEnabled('1')).toBe(true);
    expect(labelPrintingEnabled('yes')).toBe(true);
    expect(labelPrintingEnabled(' Yes ')).toBe(true);
  });

  it('reads the env when called with nothing — unset is off', () => {
    delete process.env.LABEL_PRINTING_ENABLED;
    expect(labelPrintingEnabled()).toBe(false);
    process.env.LABEL_PRINTING_ENABLED = 'on';
    expect(labelPrintingEnabled()).toBe(true);
  });

  it('next.config.ts inlines it, defaulting to off', async () => {
    delete process.env.LABEL_PRINTING_ENABLED;
    vi.resetModules();
    const off = (await import('@/next.config')).default;
    expect(off.env?.LABEL_PRINTING_ENABLED).toBe('off');
    process.env.LABEL_PRINTING_ENABLED = 'on';
    vi.resetModules();
    const on = (await import('@/next.config')).default;
    expect(on.env?.LABEL_PRINTING_ENABLED).toBe('on');
  });
});

describe('the print gate needs printing on', () => {
  const labels = [identical('2826102000000001'), newCarton('2826102000000002')];
  const list = ['2826102000000001'];

  it('LABEL_PRINT_GATE=on with printing off (the default) never blocks', () => {
    process.env.LABEL_PRINT_GATE = 'on';
    delete process.env.LABEL_PRINTING_ENABLED;
    expect(printGate(labels, list, [])).toEqual({ count: 0, batchIds: [] });
  });

  it('both on: exactly the old rules', () => {
    process.env.LABEL_PRINT_GATE = 'on';
    process.env.LABEL_PRINTING_ENABLED = 'on';
    expect(printGate(labels, list, [])).toEqual(blockingLabels(labels, list, []));
    expect(printGate(labels, list, []).count).toBe(2);
  });

  it('printing on, gate off: still never blocks (as since 2026-10-15)', () => {
    delete process.env.LABEL_PRINT_GATE;
    process.env.LABEL_PRINTING_ENABLED = 'on';
    expect(printGate(labels, list, []).count).toBe(0);
  });
});

describe('screen decisions', () => {
  it('Labels chip: amber + badge with printing on, plain with it off', () => {
    expect(labelsChipLook(3, true)).toEqual({ tint: 'amber', iconColor: '#fbbf5c', badge: 3 });
    expect(labelsChipLook(0, true)).toEqual({ tint: 'neutral', iconColor: undefined, badge: 0 });
    expect(labelsChipLook(22, false)).toEqual({ tint: 'neutral', iconColor: undefined, badge: 0 });
  });

  it('"Label not printed" markers only with printing on', () => {
    const codes = new Set(['2826102000000001']);
    expect(unprintedMarkers(codes, true)).toBe(codes);
    expect(unprintedMarkers(codes, false).size).toBe(0);
    expect(unprintedMarkers(codes, false).has('2826102000000001')).toBe(false);
  });

  it('Labels opens on "Not printed" only with printing on', () => {
    expect(labelsInitialStatus(4, true)).toBe('created');
    expect(labelsInitialStatus(0, true)).toBe('all');
    expect(labelsInitialStatus(4, false)).toBe('all');
  });

  it('an uncounted New carton save: print-and-scan on, a plain retry off', () => {
    expect(newCartonUncountedToast(1, true)).toBe('carton.savedNotCountedOne');
    expect(newCartonUncountedToast(3, true)).toBe('carton.savedNotCounted');
    expect(newCartonUncountedToast(1, false)).toBe('carton.error');
    expect(newCartonUncountedToast(3, false)).toBe('carton.error');
  });

  it('/scan and /issue lose their print-only chips with printing off', () => {
    const chips = [{ id: 'invoice' }, { id: 'create' }, { id: 'labels' }, { id: 'pallets' }];
    expect(withoutPrintChips(chips, ['create', 'labels'], true)).toBe(chips);
    expect(withoutPrintChips(chips, ['create', 'labels'], false).map((c) => c.id)).toEqual(['invoice', 'pallets']);
    expect(withoutPrintChips(chips, ['labels'], false).map((c) => c.id)).toEqual(['invoice', 'create', 'pallets']);
  });
});

describe('every way into a print dialog reads the flag', () => {
  // A file that can open the print sheet or the browser's print dialog must
  // import lib/label-printing — so a new print path cannot ship ungated.
  const root = path.resolve(__dirname, '..');
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const p = path.join(dir, name);
      return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(name) && !name.endsWith('.test.ts') ? [p] : [];
    });
  }
  const files = [...walk(path.join(root, 'app')), ...walk(path.join(root, 'components'))];
  const PRINT_PATH = /window\.print\(|labelSheetUrl\(|signedLabelSheetUrl\(|<PrintButton|<PendingLabelsLink/;

  it('finds the known print paths', () => {
    const hits = files.filter((f) => PRINT_PATH.test(readFileSync(f, 'utf8'))).map((f) => path.relative(root, f));
    expect(hits).toEqual(expect.arrayContaining([
      'app/labels/print/LabelSheet.tsx',
      'components/terminal/LabelsBrowser.tsx',
      'app/labels/pending/[doc]/PendingLabels.tsx',
      'app/pallet/[lpn]/page.tsx',
      'app/pallet-verify/[token]/page.tsx',
    ]));
  });

  it('each of them (bar the bare button component) imports the flag', () => {
    const ungated = files
      .filter((f) => PRINT_PATH.test(readFileSync(f, 'utf8')))
      .filter((f) => !f.endsWith(path.join('pallet', '[lpn]', 'PrintButton.tsx')))
      .filter((f) => !readFileSync(f, 'utf8').includes("from '@/lib/label-printing'"))
      .map((f) => path.relative(root, f));
    expect(ungated).toEqual([]);
  });
});
