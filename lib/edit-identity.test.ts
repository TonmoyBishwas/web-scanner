import { describe, expect, it } from 'vitest';
import { resolveEditIdentity } from './edit-identity';
import { cameraSerialBookable } from './carton-barcode';

const MANUAL = 'MANUAL-1793781692727-4v2wvr';

describe('resolveEditIdentity', () => {
  it('a minted label or NOBC- marker wins', () => {
    expect(resolveEditIdentity({ barcode: MANUAL, forcedId: '28261104000123', unidentified: false, barcodeInput: '' }))
      .toEqual({ kind: 'forced', id: '28261104000123' });
    expect(resolveEditIdentity({ barcode: MANUAL, forcedId: 'NOBC-IN264201-P2-5', unidentified: false, barcodeInput: '7290' }))
      .toEqual({ kind: 'forced', id: 'NOBC-IN264201-P2-5' });
  });

  it('13+ typed digits become the barcode (separators dropped)', () => {
    expect(resolveEditIdentity({ barcode: MANUAL, unidentified: true, barcodeInput: '7290004 456825-123' }))
      .toEqual({ kind: 'typed', id: '7290004456825123' });
  });

  it('too few digits refuses the save', () => {
    expect(resolveEditIdentity({ barcode: MANUAL, unidentified: true, barcodeInput: '72900' }))
      .toEqual({ kind: 'short', typed: 5 });
    expect(resolveEditIdentity({ barcode: MANUAL, unidentified: true, barcodeInput: 'abc' }))
      .toEqual({ kind: 'short', typed: 0 });
  });

  it('nothing typed keeps the existing key (a placeholder stays held)', () => {
    expect(resolveEditIdentity({ barcode: MANUAL, unidentified: true, barcodeInput: '  ' }))
      .toEqual({ kind: 'kept', id: MANUAL });
  });

  it('an identified carton keeps its barcode whatever the input holds', () => {
    expect(resolveEditIdentity({ barcode: '7290004456825123', unidentified: false, barcodeInput: '111' }))
      .toEqual({ kind: 'kept', id: '7290004456825123' });
  });
});

describe('resolveEditIdentity — a typed Wall Dan serial (camera_short_serial, 04/11)', () => {
  const LINES = [{ item_code: '7290006289360' }];
  // What the page passes: its camera gate, only while the flag is on.
  const gate = (features: { camera_short_serial?: boolean } | undefined, listed: string[] = []) =>
    (d: string) => cameraSerialBookable(features, d, LINES, listed);
  const form = (barcodeInput: string) => ({ barcode: MANUAL, unidentified: true, barcodeInput });

  it('flag off (no predicate, or the gate with the flag off): refused as before', () => {
    expect(resolveEditIdentity(form('409251'), 13)).toEqual({ kind: 'short', typed: 6 });
    expect(resolveEditIdentity(form('409251'), 13, undefined)).toEqual({ kind: 'short', typed: 6 });
    expect(resolveEditIdentity(form('409251'), 13, gate(undefined))).toEqual({ kind: 'short', typed: 6 });
    expect(resolveEditIdentity(form('409251'), 13, gate({ camera_short_serial: false }))).toEqual({ kind: 'short', typed: 6 });
  });

  it('flag on: a 6-digit serial becomes the carton key', () => {
    const on = gate({ camera_short_serial: true });
    expect(resolveEditIdentity(form('409251'), 13, on)).toEqual({ kind: 'typed', id: '409251' });
    expect(resolveEditIdentity(form(' 379 300 '), 13, on)).toEqual({ kind: 'typed', id: '379300' });
  });

  it('flag on: the camera regex and exclusions still refuse', () => {
    const on = gate({ camera_short_serial: true });
    // Leading zero, 5 or 7 digits.
    expect(resolveEditIdentity(form('020926'), 13, on)).toEqual({ kind: 'short', typed: 6 });
    expect(resolveEditIdentity(form('40925'), 13, on)).toEqual({ kind: 'short', typed: 5 });
    expect(resolveEditIdentity(form('4092510'), 13, on)).toEqual({ kind: 'short', typed: 7 });
    // A piece of the invoice line's code (628936 in 7290006289360).
    expect(resolveEditIdentity(form('628936'), 13, on)).toEqual({ kind: 'short', typed: 6 });
    // A piece of a long carton code on the list.
    expect(resolveEditIdentity(form('409251'), 13, gate({ camera_short_serial: true }, ['729000628936040925112345678901'])))
      .toEqual({ kind: 'short', typed: 6 });
  });

  it('flag on: a serial already on the list is still typed — the page puts it to the duplicate question', () => {
    expect(resolveEditIdentity(form('409251'), 13, gate({ camera_short_serial: true }, ['409251'])))
      .toEqual({ kind: 'typed', id: '409251' });
  });

  it('flag on changes nothing else: 13+ digits, forced ids, nothing typed, an identified carton', () => {
    const on = gate({ camera_short_serial: true });
    expect(resolveEditIdentity(form('7290004456825123'), 13, on)).toEqual({ kind: 'typed', id: '7290004456825123' });
    expect(resolveEditIdentity({ ...form('409251'), forcedId: 'NOBC-IN264201-P2-5' }, 13, on)).toEqual({ kind: 'forced', id: 'NOBC-IN264201-P2-5' });
    expect(resolveEditIdentity(form('  '), 13, on)).toEqual({ kind: 'kept', id: MANUAL });
    expect(resolveEditIdentity({ barcode: '409251', unidentified: false, barcodeInput: '111111' }, 13, on)).toEqual({ kind: 'kept', id: '409251' });
  });
});
