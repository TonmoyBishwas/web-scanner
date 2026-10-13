import { describe, it, expect } from 'vitest';
import { validateCartonDates } from './date-validation';

const today = '2026-10-13';

describe('validateCartonDates', () => {
  it('accepts a blank expiry, whatever the production date', () => {
    expect(validateCartonDates({ expiry: '', production: '2026-10-01', receiptDate: today })).toEqual({});
    expect(validateCartonDates({ expiry: null, production: null, receiptDate: today })).toEqual({});
    expect(validateCartonDates({ expiry: '   ', receiptDate: today })).toEqual({});
  });

  it('accepts a future expiry after the production date', () => {
    expect(validateCartonDates({ production: '2026-10-01', expiry: '2026-12-31', receiptDate: today })).toEqual({});
  });

  it('accepts a future expiry with no production date', () => {
    expect(validateCartonDates({ expiry: '2026-10-14', receiptDate: today })).toEqual({});
  });

  it('refuses an expiry of today', () => {
    expect(validateCartonDates({ expiry: today, receiptDate: today }).expiryError).toBe('dates.expiryNotFuture');
  });

  it('refuses an expiry before the receipt date (Glatt 2026-06-23)', () => {
    expect(validateCartonDates({ production: '2026-06-01', expiry: '2026-06-23', receiptDate: today }).expiryError)
      .toBe('dates.expiryNotFuture');
  });

  it('refuses an expiry equal to the production date (same date in both fields)', () => {
    expect(validateCartonDates({ production: '2026-11-01', expiry: '2026-11-01', receiptDate: today }).expiryError)
      .toBe('dates.expiryNotAfterProduction');
  });

  it('refuses an expiry before the production date (swapped)', () => {
    expect(validateCartonDates({ production: '2027-01-10', expiry: '2026-12-01', receiptDate: today }).expiryError)
      .toBe('dates.expiryNotAfterProduction');
  });

  it('prefers "swapped" when both rules fail', () => {
    expect(validateCartonDates({ production: '2026-10-05', expiry: '2026-10-05', receiptDate: today }).expiryError)
      .toBe('dates.expiryNotAfterProduction');
  });

  it('reads D/M/YYYY as day first', () => {
    expect(validateCartonDates({ production: '1/10/2026', expiry: '31/12/2026', receiptDate: today })).toEqual({});
    expect(validateCartonDates({ expiry: '12/10/2026', receiptDate: today }).expiryError).toBe('dates.expiryNotFuture');
  });

  it('does not judge a value it cannot read', () => {
    expect(validateCartonDates({ expiry: '231026', receiptDate: today })).toEqual({});
    expect(validateCartonDates({ production: 'garbage', expiry: '2026-12-01', receiptDate: today })).toEqual({});
  });
});
