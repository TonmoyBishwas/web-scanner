/**
 * Bridge between the stored session and the pure slot logic.
 *
 * A session with no `mode` is a pre-split session and must keep using
 * `current_pallet` — this file is the only place that decides which shape
 * a session has, so no route has to remember the back-compat rule.
 */
import type { SplitState } from '@/lib/pallet-slots';
import type { MultiPalletSession } from '@/types';

export function isSplitSession(session: MultiPalletSession): boolean {
  return session.mode === 'split' && Array.isArray(session.pallets);
}

export function splitStateOf(session: MultiPalletSession): SplitState {
  if (!isSplitSession(session)) {
    throw new Error(`session ${session.token} is not a split session`);
  }
  return {
    roster: session.roster ?? [],
    pallets: session.pallets ?? [],
    loose: session.loose ?? null,
  };
}

export function applySplitState(
  session: MultiPalletSession,
  state: SplitState,
): MultiPalletSession {
  return {
    ...session,
    roster: state.roster,
    pallets: state.pallets,
    loose: state.loose,
    // Keep the legacy scalar in step so anything still reading it — the
    // completion summary, the bot's plan — sees a truthful count.
    pallet_count: state.pallets.length,
  };
}
