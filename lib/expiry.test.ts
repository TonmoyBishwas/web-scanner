import { describe, it, expect } from 'vitest';
import { toIsoDate, isoToDdmmyyyy, normalizeExpiry, normalizeBoxExpiries } from './expiry';

describe('toIsoDate', () => {
  it('turns a day-first date into ISO, padding one-digit parts', () => {
    expect(toIsoDate('24/09/2026')).toBe('2026-09-24');
    expect(toIsoDate('1/2/2027')).toBe('2027-02-01');
    expect(toIsoDate(' 27/06/2027 ')).toBe('2027-06-27');
  });

  it('passes ISO through', () => {
    expect(toIsoDate('2027-10-31')).toBe('2027-10-31');
  });

  it('returns empty for empty or unknown input', () => {
    expect(toIsoDate('')).toBe('');
    expect(toIsoDate('garbage')).toBe('');
    expect(toIsoDate('311027')).toBe('');
  });
});

describe('isoToDdmmyyyy', () => {
  it('shows ISO day-first and leaves anything else alone', () => {
    expect(isoToDdmmyyyy('2027-10-31')).toBe('31/10/2027');
    expect(isoToDdmmyyyy('')).toBe('');
    expect(isoToDdmmyyyy('31/10/2027')).toBe('31/10/2027');
  });

  it('round-trips with toIsoDate', () => {
    expect(toIsoDate(isoToDdmmyyyy('2026-09-24'))).toBe('2026-09-24');
  });
});

describe('normalizeExpiry', () => {
  it('stores ISO for the two known forms', () => {
    expect(normalizeExpiry('31/10/2027')).toBe('2027-10-31');
    expect(normalizeExpiry('2027-10-31')).toBe('2027-10-31');
  });

  it('keeps an unknown format (trimmed) instead of blanking it', () => {
    expect(normalizeExpiry('garbage')).toBe('garbage');
    expect(normalizeExpiry(' 311027 ')).toBe('311027');
  });

  it('treats empty and missing as empty', () => {
    expect(normalizeExpiry('')).toBe('');
    expect(normalizeExpiry('   ')).toBe('');
    expect(normalizeExpiry(null)).toBe('');
    expect(normalizeExpiry(undefined)).toBe('');
  });
});

describe('normalizeBoxExpiries', () => {
  const rows = [
    { barcode: 'a', sku: 'a', weight: 5, expiry: '24/09/2026', supplier_batch: 'L1' },
    { barcode: 'b', sku: 'b', weight: 6, expiry: '2027-10-31' },
    { barcode: 'c', sku: 'c', weight: 7, expiry: '' },
    { barcode: 'd', sku: 'd', weight: 8, expiry: 'garbage' },
    { barcode: 'e', sku: 'e', weight: 9 } as { barcode: string; sku: string; weight: number; expiry?: string },
  ];

  it('normalises each expiry and keeps every other field and the row order', () => {
    const out = normalizeBoxExpiries(rows);
    expect(out.map((r) => r.barcode)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(out[0]).toEqual({ barcode: 'a', sku: 'a', weight: 5, expiry: '2026-09-24', supplier_batch: 'L1' });
    expect(out.map((r) => r.expiry)).toEqual(['2026-09-24', '2027-10-31', '', 'garbage', undefined]);
  });

  it('never mutates the input and passes untouched rows through as-is', () => {
    const out = normalizeBoxExpiries(rows);
    expect(rows[0].expiry).toBe('24/09/2026');
    expect(out[0]).not.toBe(rows[0]);
    expect(out[1]).toBe(rows[1]);
    expect(out[2]).toBe(rows[2]);
    expect(out[4]).toBe(rows[4]);
  });

  it('handles an empty list', () => {
    expect(normalizeBoxExpiries([])).toEqual([]);
  });
});
