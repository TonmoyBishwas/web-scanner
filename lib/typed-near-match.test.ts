import { describe, it, expect } from 'vitest';
import { isOneDigitInsertion, typedNearMatch } from './typed-near-match';
import { resolveEditIdentity } from './edit-identity';
import { findCountedCartonByDigits } from './scan-notice';

// Baladi meatballs, 04/11: the label prints 2000097200258; David typed
// 200009700258 (the '2' after '97' dropped).
const BALADI = '2000097200258';
const TYPED = '200009700258';
const MEATBALLS = 'קציצות';
const SCHNITZEL = 'שניצל';

const row = (barcode: string, item_name_hebrew = MEATBALLS, extra: Record<string, unknown> = {}) => ({
  barcode, item_name: '', item_name_hebrew, ...extra,
});
const EDITED = 'MANUAL-1793781692727-4v2wvr';

describe('isOneDigitInsertion', () => {
  it('one digit inserted anywhere', () => {
    expect(isOneDigitInsertion(TYPED, BALADI)).toBe(true);
    expect(isOneDigitInsertion('123', '9123')).toBe(true);
    expect(isOneDigitInsertion('123', '1239')).toBe(true);
    expect(isOneDigitInsertion('123', '1293')).toBe(true);
  });
  it('anything else is not', () => {
    expect(isOneDigitInsertion('123', '123')).toBe(false);
    expect(isOneDigitInsertion('123', '12345')).toBe(false);
    expect(isOneDigitInsertion('123', '1924')).toBe(false);
    expect(isOneDigitInsertion('124', '1293')).toBe(false);
  });
});

describe('typedNearMatch', () => {
  it('Baladi: 12 typed digits + 2000097200258 on the list → that code', () => {
    const list = [row(BALADI), row(EDITED, MEATBALLS)];
    expect(typedNearMatch(TYPED, list, { exceptBarcode: EDITED, nameHe: MEATBALLS })).toBe(BALADI);
  });

  it('…and the existing duplicate lookup finds the carton on the list for it', () => {
    const list = [row('7290000000017', SCHNITZEL), row(BALADI), row(EDITED)];
    const matched = typedNearMatch(TYPED, list, { exceptBarcode: EDITED })!;
    expect(findCountedCartonByDigits(list, matched, EDITED)).toMatchObject({ n: 2 });
    // The page refuses these digits today (identity 'short') — the flag path
    // only applies there.
    expect(resolveEditIdentity({ barcode: EDITED, unidentified: true, barcodeInput: TYPED }).kind).toBe('short');
  });

  it('12 random digits → nothing', () => {
    expect(typedNearMatch('483920174655', [row(BALADI), row('7290000000017', SCHNITZEL)], { exceptBarcode: EDITED })).toBeNull();
  });

  it('two codes fit and the name does not settle it → nothing', () => {
    // Both are TYPED with one digit inserted.
    const list = [row(BALADI), row('2000097002581')];
    expect(typedNearMatch(TYPED, list, { exceptBarcode: EDITED })).toBeNull();
    expect(typedNearMatch(TYPED, list, { exceptBarcode: EDITED, nameHe: MEATBALLS })).toBeNull();
  });

  it('two codes fit, only one carries the edited carton\'s name → that one', () => {
    const list = [row(BALADI, MEATBALLS), row('2000097002581', SCHNITZEL)];
    expect(typedNearMatch(TYPED, list, { exceptBarcode: EDITED, nameHe: MEATBALLS })).toBe(BALADI);
    expect(typedNearMatch(TYPED, list, { exceptBarcode: EDITED, nameHe: SCHNITZEL })).toBe('2000097002581');
  });

  it('the same code on several rows is one candidate', () => {
    const list = [row(BALADI), row(BALADI, MEATBALLS, { minted: true }), row('2826110400000017', MEATBALLS, { source_barcode: BALADI })];
    expect(typedNearMatch(TYPED, list, { exceptBarcode: EDITED })).toBe(BALADI);
  });

  it('a twin\'s source_barcode counts; a minted 28… label and a MANUAL-/NOBC- marker never do', () => {
    expect(typedNearMatch(TYPED, [row('2826110400000017', MEATBALLS, { source_barcode: BALADI })], {})).toBe(BALADI);
    // 28… minted labels are 16 digits; a 15-digit typed slip of one is not matched.
    expect(typedNearMatch('282611040000001', [row('2826110400000017')], {})).toBeNull();
    // MANUAL-<13-digit timestamp>-x: its digits are not a code.
    expect(typedNearMatch('179378169272', [row('MANUAL-1793781692727-4v2wvr')], {})).toBeNull();
  });

  it('the edited row itself is never its own match', () => {
    expect(typedNearMatch(TYPED, [row(BALADI)], { exceptBarcode: BALADI })).toBeNull();
  });

  it('nothing typed, or 13+ digits typed → nothing (those are not the short refusal)', () => {
    expect(typedNearMatch('', [row(BALADI)], {})).toBeNull();
    expect(typedNearMatch(BALADI, [row('20000972002581')], {})).toBeNull();
  });
});
