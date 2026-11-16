import { describe, expect, it } from 'vitest';
import { LIST_RISE_MAX_PX, shouldRaiseOnList } from './sheet-list-rise';

// IN264208817 pallet 2 (16/11): mid snap on a 392×850 phone; the list area
// (filter row + a ~25px strip) between the tool dock and swipe-to-confirm.
const david = { on: true, side: false, snap: 1, listPx: 87, travelY: 40, travelX: 0 };

describe('shouldRaiseOnList (sheet_list_rise)', () => {
  it('raises the sheet when he pulls on the strip at mid', () => {
    expect(shouldRaiseOnList(david)).toBe(true);
  });

  it('raises from peek too', () => {
    expect(shouldRaiseOnList({ ...david, snap: 0, listPx: 0 })).toBe(true);
  });

  it('either vertical direction counts (scrolling the strip either way)', () => {
    expect(shouldRaiseOnList({ ...david, travelY: -40 })).toBe(true);
  });

  it('switch off = never (today)', () => {
    expect(shouldRaiseOnList({ ...david, on: false })).toBe(false);
  });

  it('a tap (travel within the slop) never raises it, so a row or chip tap still works', () => {
    expect(shouldRaiseOnList({ ...david, travelY: 8 })).toBe(false);
    expect(shouldRaiseOnList({ ...david, travelY: -3, travelX: 2 })).toBe(false);
  });

  it('a sideways swipe along the dock chips is not a pull', () => {
    expect(shouldRaiseOnList({ ...david, travelY: 12, travelX: 60 })).toBe(false);
    expect(shouldRaiseOnList({ ...david, travelY: 30, travelX: 20 })).toBe(true);
  });

  it('already tall: nothing to do', () => {
    expect(shouldRaiseOnList({ ...david, snap: 2 })).toBe(false);
  });

  it('a side panel is full height: nothing to do', () => {
    expect(shouldRaiseOnList({ ...david, side: true })).toBe(false);
  });

  it('a list that shows rows at mid scrolls as before', () => {
    expect(shouldRaiseOnList({ ...david, listPx: LIST_RISE_MAX_PX })).toBe(false);
    expect(shouldRaiseOnList({ ...david, listPx: 220 })).toBe(false);
    expect(shouldRaiseOnList({ ...david, listPx: LIST_RISE_MAX_PX - 1 })).toBe(true);
  });
});
