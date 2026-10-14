import { describe, it, expect } from 'vitest';
import { isEmptySummaryLine } from './pallet-lines';

describe('isEmptySummaryLine (SCN-11)', () => {
  it('the 2026-10-04 ghost: no code, no name, no weight', () => {
    expect(isEmptySummaryLine({ item_code: '', item_name: '', item_name_hebrew: '' }, [{ weight: 0 }])).toBe(true);
    expect(isEmptySummaryLine({ item_code: null, item_name: '  ', item_name_hebrew: undefined }, [{ weight: null }])).toBe(true);
  });
  it('any one of code, name or a booked weight keeps the line', () => {
    expect(isEmptySummaryLine({ item_code: '7290003670444', item_name: '', item_name_hebrew: '' }, [{ weight: 0 }])).toBe(false);
    expect(isEmptySummaryLine({ item_code: '', item_name: '', item_name_hebrew: 'שוקיים' }, [{ weight: 0 }])).toBe(false);
    expect(isEmptySummaryLine({ item_code: '', item_name: 'Legs', item_name_hebrew: '' }, [{ weight: 0 }])).toBe(false);
    expect(isEmptySummaryLine({ item_code: '', item_name: '', item_name_hebrew: '' }, [{ weight: 0 }, { weight: 12.4 }])).toBe(false);
  });
});
