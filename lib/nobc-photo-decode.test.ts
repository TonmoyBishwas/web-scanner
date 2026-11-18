import { describe, expect, it } from 'vitest';
import { encodeCode128 } from './code128';
import { cameraSerialAccepted } from './carton-barcode';
import { nobcPhotoDecision, nobcPhotoSerial, photoCodeReads, PHOTO_DECODE_MAX } from './nobc-photo-decode';

/**
 * Clean Code 128 symbols stacked in one grey image (3 px per module, each
 * symbol a 70 px band, 50 px of paper between them) — a photo with one
 * sticker in view, or two side by side as on Well Done 48971's NOBC photo.
 */
function photo(values: string[]) {
  const mod = 3;
  const bands = values.map((v) => {
    const w = encodeCode128(v);
    if (!w) throw new Error('unencodable ' + v);
    return w;
  });
  const width = Math.max(...bands.map((w) => w.reduce((a, b) => a + b, 0))) * mod + 120;
  const band = 70;
  const gap = 50;
  const height = values.length * band + (values.length + 1) * gap;
  const data = new Uint8ClampedArray(width * height * 4).fill(230);
  bands.forEach((widths, i) => {
    const y0 = gap + i * (band + gap);
    let x = 60;
    widths.forEach((m, k) => {
      if (k % 2 === 0) {
        for (let y = y0; y < y0 + band; y++) {
          for (let px = x; px < x + m * mod; px++) {
            const j = (y * width + px) * 4;
            data[j] = data[j + 1] = data[j + 2] = 25;
          }
        }
      }
      x += m * mod;
    });
  });
  for (let j = 3; j < data.length; j += 4) data[j] = 255;
  return { data, width, height };
}

const serialOnly = (v: string) => /^[1-9]\d{5}$/.test(v);

describe('nobcPhotoSerial (nobc_photo_decode, 18/11)', () => {
  it('exactly one accepted serial, no digits read: that serial', () => {
    expect(nobcPhotoSerial(['412924'], serialOnly, '')).toBe('412924');
    expect(nobcPhotoSerial(['412924'], serialOnly, null)).toBe('412924');
  });

  it('the same serial read twice is still one', () => {
    expect(nobcPhotoSerial(['412924', ' 412924 '], serialOnly, '')).toBe('412924');
  });

  it('two accepted serials (a neighbour sticker in view, 48971): null — NOBC- as today', () => {
    expect(nobcPhotoSerial(['412916', '412924'], serialOnly, '')).toBeNull();
  });

  it('no reads, or nothing the camera would accept: null', () => {
    expect(nobcPhotoSerial([], serialOnly, '')).toBeNull();
    expect(nobcPhotoSerial(null, serialOnly, '')).toBeNull();
    expect(nobcPhotoSerial(['020926', '24755'], serialOnly, '')).toBeNull();
  });

  it('a read the camera would refuse does not count against the one it accepts', () => {
    expect(nobcPhotoSerial(['020926', '412924'], serialOnly, '')).toBe('412924');
  });

  it('label digits naming another number keep NOBC-; the same number or too few digits do not', () => {
    expect(nobcPhotoSerial(['412924'], serialOnly, '412925')).toBeNull();
    expect(nobcPhotoSerial(['412924'], serialOnly, '7290006289360')).toBeNull();
    expect(nobcPhotoSerial(['412924'], serialOnly, '412924')).toBe('412924');
    expect(nobcPhotoSerial(['412924'], serialOnly, '41')).toBe('412924');
  });

  it("with the camera's own rule: a piece of an invoice line's code is not a serial", () => {
    const lines = [{ item_code: '7290006289360' }];
    const accept = (v: string) => cameraSerialAccepted(v, lines, []);
    expect(nobcPhotoSerial(['628936'], accept, '')).toBeNull();
    expect(nobcPhotoSerial(['628936', '409251'], accept, '')).toBe('409251');
  });

  it('a serial already on the list still passes the camera rule (the listed check is in nobcPhotoDecision)', () => {
    const accept = (v: string) => cameraSerialAccepted(v, [], ['409251']);
    expect(nobcPhotoSerial(['409251'], accept, '')).toBe('409251');
    // …and a neighbour already on the list beside it makes two: NOBC-.
    expect(nobcPhotoSerial(['409251', '409252'], accept, '')).toBeNull();
  });
});

describe('nobcPhotoDecision: a serial already on the list (review 18/11)', () => {
  const listedSet = new Set(['410405', '410410']);
  const listed = (v: string) => listedSet.has(v);

  it("a listed serial the label reader did not print is a neighbour's sticker: NOBC- as today, never a drop", () => {
    // 48745 P1-2: the photo showed only already-counted neighbours.
    expect(nobcPhotoDecision(['410405'], serialOnly, '', listed)).toEqual({ serial: null, outcome: 'listed' });
    expect(nobcPhotoDecision(['410405'], serialOnly, '4104', listed)).toEqual({ serial: null, outcome: 'listed' });
  });

  it('a listed serial the label reader printed too is that carton (the page then reports it as already counted)', () => {
    expect(nobcPhotoDecision(['410405'], serialOnly, '410405', listed)).toEqual({ serial: '410405', outcome: 'serial' });
  });

  it('a serial not on the list yet — the bug being fixed — is still taken', () => {
    expect(nobcPhotoDecision(['410407'], serialOnly, '', listed)).toEqual({ serial: '410407', outcome: 'serial' });
  });

  it('a listed neighbour beside another serial is still two in view', () => {
    expect(nobcPhotoDecision(['410405', '410407'], serialOnly, '', listed)).toEqual({ serial: null, outcome: 'several' });
  });

  it('the reasons', () => {
    expect(nobcPhotoDecision([], serialOnly, '').outcome).toBe('none');
    expect(nobcPhotoDecision(['412924'], serialOnly, '412925').outcome).toBe('other_digits');
    expect(nobcPhotoSerial(['410405'], serialOnly, '', listed)).toBeNull();
  });
});

describe('photoCodeReads', () => {
  it('reads the one sticker in a photo', () => {
    expect(photoCodeReads(photo(['412924']))).toEqual(['412924']);
  });

  it('sees both stickers when two are in view (more than the live default of 1)', () => {
    expect(PHOTO_DECODE_MAX).toBeGreaterThan(1);
    const reads = photoCodeReads(photo(['412916', '412924']));
    expect([...reads].sort()).toEqual(['412916', '412924']);
    expect(nobcPhotoSerial(reads, serialOnly, '')).toBeNull();
  });

  it('a photo with no barcode reads nothing', () => {
    const blank = { data: new Uint8ClampedArray(300 * 200 * 4).fill(230), width: 300, height: 200 };
    expect(photoCodeReads(blank)).toEqual([]);
  });
});
