import { describe, expect, it } from 'vitest';
import { entryToValue, isoToDotted, maskDateInput, parseDateEntry } from './date-entry';

describe('maskDateInput — what the field shows while typing', () => {
  it.each([
    ['', ''],
    ['3', '3'],
    ['31', '31'],
    ['311', '31.1'],
    ['3112', '31.12'],
    ['311227', '31.12.27'],
    ['31122027', '31.12.2027'],
    ['311220271', '31.12.2027'], // year full: extra digit dropped
    ['31/12/27', '31.12.27'],
    ['31-12-2027', '31.12.2027'],
    ['1.5.27', '1.5.27'],
    ['1.', '1.'],
    ['1..5', '1.5'],
    ['.1', '1'],
    ['31.122027', '31.12.2027'], // typed one dot, then kept going
    ['31 12 27', '31.12.27'],
    ['31,12,27', '31.12.27'],
    ['ab31x12y27', '31.12.27'],
  ])('%j → %j', (raw, shown) => {
    expect(maskDateInput(raw)).toBe(shown);
  });

  it('is stable: masking what it shows changes nothing', () => {
    for (const s of ['31.12.2027', '1.5.27', '31.1', '31.']) expect(maskDateInput(maskDateInput(s))).toBe(maskDateInput(s));
  });
});

describe('parseDateEntry', () => {
  const fin = { final: true };
  const typing = { final: false };

  it.each([
    ['31.12.2027', '2027-12-31'],
    ['31/12/2027', '2027-12-31'],
    ['31-12-2027', '2027-12-31'],
    ['1.5.2027', '2027-05-01'],
    ['01.05.27', '2027-05-01'],
    ['1/5/27', '2027-05-01'],
    ['311227', '2027-12-31'],
    ['31122027', '2027-12-31'],
    ['29.02.2028', '2028-02-29'],
    [' 31.12.2027 ', '2027-12-31'],
  ])('final %j → %s', (text, iso) => {
    expect(parseDateEntry(text, fin)).toEqual({ kind: 'date', iso });
  });

  it('a 2-digit year is 20yy', () => {
    expect(parseDateEntry('01.01.99', fin)).toEqual({ kind: 'date', iso: '2099-01-01' });
    expect(parseDateEntry('01.01.00', fin)).toEqual({ kind: 'date', iso: '2000-01-01' });
  });

  it.each(['31.02.2027', '29.02.2027', '00.01.2027', '32.01.2027', '15.13.2027', '15.00.27'])(
    'not a real day %j → invalid',
    (text) => {
      expect(parseDateEntry(text, fin).kind).toBe('invalid');
    },
  );

  it.each(['31.12.202', '31.12.2', '31.12', '31', '3112', '31122'])(
    'unfinished %j: partial while typing, invalid once the field is left',
    (text) => {
      expect(parseDateEntry(text, typing).kind).toBe('partial');
      expect(parseDateEntry(text, fin).kind).toBe('invalid');
    },
  );

  it('a 2-digit year waits while typing (31.12.20 is on its way to 2027), and counts on leave', () => {
    expect(parseDateEntry('31.12.20', typing).kind).toBe('partial');
    expect(parseDateEntry('31.12.20', fin)).toEqual({ kind: 'date', iso: '2020-12-31' });
    expect(parseDateEntry('311227', typing).kind).toBe('partial');
  });

  it('a 4-digit year is judged at once while typing', () => {
    expect(parseDateEntry('31.12.2027', typing)).toEqual({ kind: 'date', iso: '2027-12-31' });
    expect(parseDateEntry('31.02.2027', typing).kind).toBe('invalid');
  });

  it('junk and over-long input are invalid', () => {
    expect(parseDateEntry('abc', fin).kind).toBe('invalid');
    expect(parseDateEntry('123.12.2027', fin).kind).toBe('invalid');
    expect(parseDateEntry('31.12.20271', fin).kind).toBe('invalid');
    expect(parseDateEntry('1.2.3.4', fin).kind).toBe('invalid');
    expect(parseDateEntry('311220271', fin).kind).toBe('invalid');
  });

  it('empty is empty', () => {
    expect(parseDateEntry('', fin).kind).toBe('empty');
    expect(parseDateEntry('   ', typing).kind).toBe('empty');
  });

  it('every masked keystroke of 31122027 reaches the same ISO at the end', () => {
    let shown = '';
    for (const ch of '31122027') shown = maskDateInput(shown + ch);
    expect(shown).toBe('31.12.2027');
    expect(parseDateEntry(shown, typing)).toEqual({ kind: 'date', iso: '2027-12-31' });
  });
});

describe('entryToValue — what goes into the draft', () => {
  it('ISO when it parses, empty while unfinished, raw text when wrong', () => {
    expect(entryToValue('31.12.2027', false)).toBe('2027-12-31');
    expect(entryToValue('31.12', false)).toBe('');
    expect(entryToValue('31.12', true)).toBe('31.12'); // → expiryError says expiry_invalid
    expect(entryToValue('31.02.2027', false)).toBe('31.02.2027');
    expect(entryToValue('', true)).toBe('');
  });
});

describe('isoToDotted', () => {
  it('formats ISO and passes anything else through', () => {
    expect(isoToDotted('2027-12-31')).toBe('31.12.2027');
    expect(isoToDotted('')).toBe('');
    expect(isoToDotted('31.12')).toBe('31.12');
  });
  it('round-trips through the parser', () => {
    for (const iso of ['2027-12-31', '2026-10-21', '2041-10-20']) {
      expect(parseDateEntry(isoToDotted(iso), { final: false })).toEqual({ kind: 'date', iso });
    }
  });
});
