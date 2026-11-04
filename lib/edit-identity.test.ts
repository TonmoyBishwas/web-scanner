import { describe, expect, it } from 'vitest';
import { resolveEditIdentity } from './edit-identity';

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
