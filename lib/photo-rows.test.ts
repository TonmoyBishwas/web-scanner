import { describe, it, expect } from 'vitest';
import { photoBelongsTo, photoUploadKey } from './photo-rows';
import { dataUrlBytes } from './photo-compress';

describe('photo-rows', () => {
  it('upload key is per list row, not per barcode across pallets', () => {
    expect(photoUploadKey('pallet', 1, '7290003022076')).not.toBe(photoUploadKey('pallet', 2, '7290003022076'));
    expect(photoUploadKey('loose', 5, 'x')).toBe(photoUploadKey('loose', 0, 'x'));
    expect(photoUploadKey('loose', 0, 'x')).not.toBe(photoUploadKey('pallet', 0, 'x'));
  });

  it('a photo lands on the sample and on rows minted from it', () => {
    expect(photoBelongsTo({ barcode: '729' }, '729')).toBe(true);
    expect(photoBelongsTo({ barcode: '2800001', source_barcode: '729' }, '729')).toBe(true);
    expect(photoBelongsTo({ barcode: '2800001', source_barcode: '730' }, '729')).toBe(false);
    expect(photoBelongsTo({ barcode: '2800001' }, '729')).toBe(false);
  });

  it('a twin carton does not borrow the sample photo', () => {
    expect(photoBelongsTo({ barcode: '2800002', source_barcode: '729', twin: true }, '729')).toBe(false);
  });

  it('dataUrlBytes estimates the decoded size', () => {
    expect(dataUrlBytes('data:image/jpeg;base64,AAAA')).toBe(3);
    expect(dataUrlBytes('data:image/jpeg;base64,AA==')).toBe(1);
  });
});
