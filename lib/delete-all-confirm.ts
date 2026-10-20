/**
 * The question the Delete sheet asks before a bulk action runs (client 19/10).
 *
 * The sheet used to arm the row and say "tap again to confirm" — the count
 * was only in the row's own label. A whole pallet could go with two quick
 * taps and no question. Now each action stops on an explicit question that
 * names the count in the client's words ("Delete all 126 cartons on the
 * pallet?") with a red confirm and a Cancel. One carton / one label reads as
 * a sentence of its own ("all 1 cartons" is not Hebrew).
 */

import type { TranslationKey } from '@/lib/i18n/server';
import type { LabelClearMode } from '@/lib/pallet-clear';

export type DeleteAllAction = 'rows' | Exclude<LabelClearMode, 'rows'>;

export interface DeleteAllQuestion {
  key: TranslationKey;
  vars: { count: number };
  /** The confirm button's words. */
  confirmKey: TranslationKey;
  /** Void is a warning (amber), never a delete; the rest are red. */
  tone: 'danger' | 'warn';
}

export function deleteAllQuestion(action: DeleteAllAction, loose: boolean, count: number): DeleteAllQuestion {
  const one = count === 1;
  const vars = { count };
  if (action === 'void_printed') {
    return {
      key: one ? 'terminal.voidPrintedAskOne' : 'terminal.voidPrintedAsk',
      vars,
      confirmKey: 'terminal.voidPrintedYes',
      tone: 'warn',
    };
  }
  if (action === 'unprinted') {
    return {
      key: one ? 'terminal.deleteAllAskLabelsOne' : 'terminal.deleteAllAskLabels',
      vars,
      confirmKey: 'terminal.deleteAllYes',
      tone: 'danger',
    };
  }
  const key: TranslationKey = loose
    ? one ? 'terminal.deleteAllAskRowsLooseOne' : 'terminal.deleteAllAskRowsLoose'
    : one ? 'terminal.deleteAllAskRowsOne' : 'terminal.deleteAllAskRows';
  return { key, vars, confirmKey: 'terminal.deleteAllYes', tone: 'danger' };
}
