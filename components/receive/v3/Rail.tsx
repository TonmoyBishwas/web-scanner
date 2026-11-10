/**
 * Receive form v3, the open card's three rubrics (5.9): each its title in
 * its state colour + content. Mevaser 09/11: the dot-and-line rail on the
 * side is gone ("green line get out"); the title colour still shows the
 * state (done / active / waiting).
 */
import type { ReactNode } from 'react';
import { P, font } from './tokens';

export type RubricState = 'done' | 'active' | 'wait';

export function rubricState(done: boolean, active: boolean): RubricState {
  return done ? 'done' : active ? 'active' : 'wait';
}

const LABEL: Record<RubricState, string> = { done: P.ink2, active: P.ink, wait: P.line2 };

/** The rubric's title in its state colour (600 13px/22px). */
export function RubricLabel({ state, children }: { state: RubricState; children: ReactNode }) {
  return <span style={{ font: font(600, 13, 22), color: LABEL[state] }}>{children}</span>;
}

export function Rubric({
  n,
  state,
  label,
  children,
  gap = 6,
}: {
  n: 1 | 2 | 3;
  state: RubricState;
  /** The rubric's title row; rubric 3 passes its own row (label + value + link). */
  label: ReactNode;
  /** Kept for the callers; nothing is drawn since 09/11 (no rail). */
  connector: boolean;
  children?: ReactNode;
  gap?: number;
}) {
  return (
    <div data-rubric={n} data-state={state} style={{ display: 'flex', flexDirection: 'column', gap }}>
      {typeof label === 'string' ? <RubricLabel state={state}>{label}</RubricLabel> : label}
      {children}
    </div>
  );
}
