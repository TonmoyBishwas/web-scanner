import { describe, expect, it } from 'vitest';
import { barcodeProvenance, barcodeSourceOf } from './barcode-provenance';

describe('barcodeProvenance (01/11: barcode_source + barcode_format_ok to the bot)', () => {
  it('a decoded code is a scan, checked', () => {
    expect(barcodeProvenance({ barcode: '1050861100101011067936150' })).toEqual({ barcode_source: 'scan', barcode_format_ok: true });
    expect(barcodeProvenance({ barcode: '1050861115101001067936150' })).toEqual({ barcode_source: 'scan', barcode_format_ok: false });
  });

  it('a manual capture keeps photo_digits, and damaged digits fail the check', () => {
    expect(barcodeProvenance({ barcode: '4721100101530065729703', barcode_source: 'photo_digits' }))
      .toEqual({ barcode_source: 'photo_digits', barcode_format_ok: false });
    expect(barcodeProvenance({ barcode: '1014721100101409065729707', barcode_source: 'photo_digits' }))
      .toEqual({ barcode_source: 'photo_digits', barcode_format_ok: true });
  });

  it('typed digits stay typed', () => {
    expect(barcodeProvenance({ barcode: '7290004456825', barcode_source: 'typed' })).toEqual({ barcode_source: 'typed', barcode_format_ok: true });
  });

  it('minted labels and no-barcode markers are minted, with nothing to check — whatever the row says', () => {
    expect(barcodeProvenance({ barcode: '2826110119842666' })).toEqual({ barcode_source: 'minted', barcode_format_ok: null });
    expect(barcodeProvenance({ barcode: 'NOBC-261062322-P2-5', barcode_source: 'photo_digits' })).toEqual({ barcode_source: 'minted', barcode_format_ok: null });
    expect(barcodeSourceOf({ barcode: '7290115351484014085456309092027', twin: true })).toBe('minted');
  });

  it('an unknown source string is not passed on', () => {
    expect(barcodeSourceOf({ barcode: '7290004456825', barcode_source: 'camera' })).toBe('scan');
  });
});

describe('photo digits are checked for the bot only', () => {
  it('damaged photo digits go out as barcode_format_ok=false, nothing else', () => {
    expect(barcodeProvenance({ barcode: '4721100101530065729703', barcode_source: 'photo_digits' })).toEqual({
      barcode_source: 'photo_digits',
      barcode_format_ok: false,
    });
  });
  it('good photo digits → true', () => {
    expect(barcodeProvenance({ barcode: '1014721100101409065729707', barcode_source: 'photo_digits' }).barcode_format_ok).toBe(true);
  });
});
