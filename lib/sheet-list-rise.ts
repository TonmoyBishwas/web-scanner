/**
 * sheet_list_rise (16/11, David, Baladi IN264208817 pallet 2): on a small
 * phone (392×850) the bottom sheet's mid height is the tool dock plus the
 * footer (count line / swipe-to-confirm) and nothing else — the carton list
 * between them is a strip about 25px tall under the filter row. In the video
 * the worker says "the slider cannot go up … scrolling very stuck … it's not
 * open up": he pulled on the list and on the tool dock, but only the handle
 * band at the top moves the sheet, so for 1:47 after the count he scrolled
 * the strip blind (0 drawer_drag in the session; 8 sessions in 30 days show
 * list scrolls at that height).
 *
 * With the switch on, a vertical pull on the list or the tool dock while the
 * list is too short to show a carton row raises the sheet to its tall height,
 * where the list is readable. No new text and no new control: the sheet only
 * goes where the handle would have taken it. A tap never raises it (a row or
 * a dock chip still works), a sideways swipe along the dock still scrolls the
 * chips, the footer (swipe-to-confirm) is never watched, and a list that
 * already shows rows scrolls as before.
 */

/**
 * Below this the list area shows less than one carton row (~64px): the area
 * also holds the by-item filter row (~40px), the 10px gap under it and 12px
 * of bottom padding, so 120px leaves under 60px for rows. On David's phone at
 * mid it was about 87px by the video (the filter row and a ~25px strip).
 */
export const LIST_RISE_MAX_PX = 120;

/** px of finger travel before a touch counts as a pull (the sheet's TAP_SLOP). */
export const LIST_RISE_SLOP_PX = 8;

/** The tall snap index of BottomSheet (0 = peek, 1 = mid, 2 = tall). */
const TALL = 2;

export interface ListRiseInput {
  /** scanner flag sheet_list_rise for this chat (session features). */
  on: boolean;
  /** Docked as a side panel: full height already, nothing to raise. */
  side: boolean;
  /** The sheet's snap index now. */
  snap: number;
  /** The list area's visible height (scroll area clientHeight, padding included). */
  listPx: number;
  /** The list's full content height (scroll area scrollHeight). No more than
   *  listPx = nothing hidden (no cartons yet, or a filter matching none):
   *  raising would only cover the camera. */
  contentPx: number;
  /** Vertical finger travel since the touch began, px; positive = finger
   *  moved up. Either direction at mid; at peek only up (a downward swipe
   *  there means "out of the way", never "cover the camera"). */
  travelY: number;
  /** Horizontal finger travel since the touch began, px. */
  travelX: number;
}

/** Whether this move on the list / tool dock raises the sheet to tall. */
export function shouldRaiseOnList({ on, side, snap, listPx, contentPx, travelY, travelX }: ListRiseInput): boolean {
  if (!on || side) return false;
  if (snap >= TALL) return false;
  const dy = Math.abs(travelY);
  if (dy <= LIST_RISE_SLOP_PX) return false;
  // Sideways first = the dock's chip row scrolling, not a pull.
  if (Math.abs(travelX) > dy) return false;
  if (snap <= 0 && travelY < 0) return false;
  if (contentPx <= listPx + 1) return false;
  return listPx < LIST_RISE_MAX_PX;
}

/**
 * The finger has left the tap slop in some direction: the caller decides
 * once, here, and keeps that answer for the rest of the touch, so a sideways
 * chip swipe that later curves upward is still a sideways swipe.
 */
export function pastListRiseSlop(travelY: number, travelX: number): boolean {
  return Math.max(Math.abs(travelY), Math.abs(travelX)) > LIST_RISE_SLOP_PX;
}
