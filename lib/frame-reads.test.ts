import { describe, it, expect } from 'vitest';
import {
  preferCartonCodes, isProductCode, isCartonCode, belongsToCartonCode, CartonCodeMemory,
} from './frame-reads';
import { ReadConfirmer } from './barcode-frame';

// Well Done 48288 (David, 2026-10-11): black brand sticker EAN-13 = the
// invoice item code on every carton, white Sokołów label = the carton code.
const WELL_DONE_EAN = '7290008432467';
const WELL_DONE_CARTON = '388432467020926171026048702036';
// Baladi stroganoff, 31 digits (GTIN + net + gross + expiry).
const BALADI_31 = '7290003570867015260157527072027';
// Its GTIN-13 — the first 13 digits of the carton code.
const BALADI_EAN = '7290003570867';
// Kabanos — a fixed-weight product: the EAN-13 is all there is.
const KABANOS_EAN = '7290004456825';
// Baladi's own shipping-pallet label (MEV-10).
const PALLET_LABEL = '1000000000508926';
// A warehouse-minted 28… label.
const MINTED = '2826101100000001';

const r = (value: string, dist = 0) => ({ value, dist });

describe('isProductCode / isCartonCode', () => {
  it('an EAN-13 is a product code, not a carton code', () => {
    expect(isProductCode(WELL_DONE_EAN)).toBe(true);
    expect(isCartonCode(WELL_DONE_EAN)).toBe(false);
  });

  it('a 30/31-digit GS1-128 is a carton code', () => {
    expect(isCartonCode(WELL_DONE_CARTON)).toBe(true);
    expect(isCartonCode(BALADI_31)).toBe(true);
    expect(isProductCode(BALADI_31)).toBe(false);
  });

  it('a warehouse 28… label is a carton code', () => {
    expect(isCartonCode(MINTED)).toBe(true);
  });

  it('the supplier pallet label is never a carton code', () => {
    expect(isCartonCode(PALLET_LABEL)).toBe(false);
  });

  it('a GTIN-14 is neither (left alone)', () => {
    expect(isProductCode('17290008432464')).toBe(false);
    expect(isCartonCode('17290008432464')).toBe(false);
  });

  it('non-digit values (a QR URL) are neither', () => {
    expect(isProductCode('https://x.test/sticker/v1/LPN')).toBe(false);
    expect(isCartonCode('https://x.test/sticker/v1/LPN')).toBe(false);
  });
});

describe('belongsToCartonCode', () => {
  it('Sokołów: the carton code carries the EAN-13 item reference (8432467)', () => {
    expect(belongsToCartonCode(WELL_DONE_EAN, WELL_DONE_CARTON)).toBe(true);
  });

  it('Tapaz/Baladi: the 31-digit code starts with the whole GTIN-13', () => {
    expect(belongsToCartonCode(BALADI_EAN, BALADI_31)).toBe(true);
  });

  it('a fragment read off the carton code belongs to it (020926, trace 12:15:56)', () => {
    expect(belongsToCartonCode('020926', '388432467020926171026052201838')).toBe(true);
  });

  it('an unrelated EAN-13 does not belong (kabanos vs a stroganoff label)', () => {
    expect(belongsToCartonCode(KABANOS_EAN, BALADI_31)).toBe(false);
    expect(belongsToCartonCode(KABANOS_EAN, WELL_DONE_CARTON)).toBe(false);
    expect(belongsToCartonCode(WELL_DONE_EAN, BALADI_31)).toBe(false);
  });

  it('too short to be more than chance → no', () => {
    expect(belongsToCartonCode('02092', '388432467020926171026052201838')).toBe(false);
  });

  it('never claimed by a pallet label', () => {
    expect(belongsToCartonCode('1000000000', PALLET_LABEL)).toBe(false);
  });
});

describe('preferCartonCodes (one frame)', () => {
  it('EAN-13 + its own carton code → only the carton code', () => {
    const out = preferCartonCodes([r(WELL_DONE_EAN, 1), r(WELL_DONE_CARTON, 50)]);
    expect(out.map((x) => x.value)).toEqual([WELL_DONE_CARTON]);
  });

  it('keeps the carton code\'s own distance (both stickers are on the one carton)', () => {
    expect(preferCartonCodes([r(WELL_DONE_EAN, 1), r(WELL_DONE_CARTON, 50)])).toEqual([r(WELL_DONE_CARTON, 50)]);
  });

  it('a centred EAN-13 + an UNRELATED off-centre 31-digit code → both kept (nearest the centre decides)', () => {
    const reads = [r(KABANOS_EAN, 0.02), r(BALADI_31, 0.6)];
    expect(preferCartonCodes(reads)).toBe(reads);
  });

  it('...and in the confirmer the centred kabanos wins the tie', () => {
    const c = new ReadConfirmer(2, 3000);
    const frame = () => preferCartonCodes([r(KABANOS_EAN, 0.02), r(BALADI_31, 0.6)]);
    expect(c.add(frame(), 0).confirmed).toBeNull();
    expect(c.add(frame(), 100).confirmed).toBe(KABANOS_EAN);
  });

  it('an EAN-13 alone (kabanos) is untouched', () => {
    const reads = [r(KABANOS_EAN, 3)];
    expect(preferCartonCodes(reads)).toBe(reads);
  });

  it('a carton code alone is untouched', () => {
    const reads = [r(BALADI_31)];
    expect(preferCartonCodes(reads)).toBe(reads);
  });

  it('EAN-13 + supplier pallet label → unchanged (a pallet label is never preferred)', () => {
    const reads = [r(KABANOS_EAN, 2), r(PALLET_LABEL, 1)];
    expect(preferCartonCodes(reads)).toBe(reads);
  });

  it('EAN-13 + pallet label + its carton code → the pallet label stays (the page refuses it as today), the EAN goes', () => {
    const out = preferCartonCodes([r(BALADI_EAN), r(PALLET_LABEL), r(BALADI_31)]);
    expect(out.map((x) => x.value)).toEqual([PALLET_LABEL, BALADI_31]);
  });

  it('two carton codes + an EAN that one of them carries → both carton codes kept, in order', () => {
    const out = preferCartonCodes([r(BALADI_31, 9), r(WELL_DONE_EAN, 1), r(WELL_DONE_CARTON, 4)]);
    expect(out.map((x) => x.value)).toEqual([BALADI_31, WELL_DONE_CARTON]);
  });

  it('a warehouse 28… label does not carry the EAN → both kept', () => {
    const reads = [r(WELL_DONE_EAN), r(MINTED)];
    expect(preferCartonCodes(reads)).toBe(reads);
  });

  it('a fragment of the carton code in the same frame is dropped', () => {
    const out = preferCartonCodes([r('020926'), r('388432467020926171026052201838')]);
    expect(out.map((x) => x.value)).toEqual(['388432467020926171026052201838']);
  });

  it('a short fragment next to an EAN-13 is not a carton code → unchanged', () => {
    const reads = [r(WELL_DONE_EAN), r('15928481')];
    expect(preferCartonCodes(reads)).toBe(reads);
  });

  it('a GTIN-14 next to a carton code stays (only short codes it carries are dropped)', () => {
    const out = preferCartonCodes([r('17290008432464'), r(BALADI_EAN), r(BALADI_31)]);
    expect(out.map((x) => x.value)).toEqual(['17290008432464', BALADI_31]);
  });

  it('an empty frame → empty', () => {
    expect(preferCartonCodes([])).toEqual([]);
  });
});

describe('CartonCodeMemory (across decoders)', () => {
  it('the EAN-13 and the long code in two separate calls: the EAN is dropped once the long code was seen', () => {
    const m = new CartonCodeMemory(3000);
    const e2e = [r(WELL_DONE_CARTON, 0.3)];
    expect(m.filter(e2e, 0)).toBe(e2e);
    expect(m.filter([r(WELL_DONE_EAN, 0.1)], 50)).toEqual([]);
  });

  it('the long code is forgotten after the window', () => {
    const m = new CartonCodeMemory(3000);
    m.filter([r(WELL_DONE_CARTON)], 0);
    const later = [r(WELL_DONE_EAN)];
    expect(m.filter(later, 3001)).toBe(later);
    expect(m.claims(WELL_DONE_EAN)).toBe(false);
  });

  it('an unrelated EAN (kabanos) is never claimed by a remembered neighbour code', () => {
    const m = new CartonCodeMemory(3000);
    m.filter([r(BALADI_31)], 0);
    const reads = [r(KABANOS_EAN)];
    expect(m.filter(reads, 100)).toBe(reads);
  });

  it('Well Done trace replay: detector reads the EAN, the worker reads the long code, separately → the long code confirms', () => {
    // trace_1011.txt 12:16:35–42: the EAN only ever came from the raw pass,
    // the 30-digit code only from the e2e worker.
    const m = new CartonCodeMemory(3000);
    const c = new ReadConfirmer(2, 3000);
    const consume = (reads: ReturnType<typeof r>[], now: number) => {
      const out = m.filter(reads, now);
      c.forget((v) => m.claims(v));
      return c.add(out, now).confirmed;
    };
    expect(consume([r(WELL_DONE_EAN, 0.1)], 0)).toBeNull(); // raw pass: EAN at 1
    expect(consume([r(WELL_DONE_CARTON, 0.3)], 40)).toBeNull(); // e2e: carton at 1, EAN forgotten
    expect(consume([r(WELL_DONE_EAN, 0.1)], 80)).toBeNull(); // raw pass: EAN dropped
    expect(consume([r(WELL_DONE_CARTON, 0.3)], 120)).toBe(WELL_DONE_CARTON);
  });

  it('without the memory the same replay books the EAN (the 2026-10-11 bug)', () => {
    const c = new ReadConfirmer(2, 3000);
    expect(c.add([r(WELL_DONE_EAN, 0.1)], 0).confirmed).toBeNull();
    expect(c.add([r(WELL_DONE_CARTON, 0.3)], 40).confirmed).toBeNull();
    expect(c.add([r(WELL_DONE_EAN, 0.1)], 80).confirmed).toBe(WELL_DONE_EAN);
  });

  it('a fragment seen alone after the long code is dropped (no too-short refusal, no cooldown)', () => {
    const m = new CartonCodeMemory(3000);
    m.filter([r('388432467020926171026052201838')], 0);
    expect(m.filter([r('020926')], 500)).toEqual([]);
  });
});

describe('ReadConfirmer.forget', () => {
  it('drops only the picked values', () => {
    const c = new ReadConfirmer(2, 3000);
    c.add([r('A'), r('B')], 0);
    c.forget((v) => v === 'A');
    expect(c.add([r('A')], 10).confirmed).toBeNull();
    expect(c.add([r('B')], 20).confirmed).toBe('B');
  });
});
