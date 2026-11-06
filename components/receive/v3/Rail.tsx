/**
 * Receive form v3, the open card's rail (5.9): three rubrics, each a 26 px
 * dot column + content. Dot 14×14: done = green fill, active = 2.5 px ink
 * ring, waiting = 1.5 px grey ring. A 2 px connector runs from below the dot
 * to the next rubric and fills green (250 ms) when the rubric is done;
 * rubric 1 has a 10 px stub above its dot, rubric 3 no connector.
 */
import type { ReactNode } from 'react';
import { EO, P, font } from './tokens';

export type RubricState = 'done' | 'active' | 'wait';

export function rubricState(done: boolean, active: boolean): RubricState {
  return done ? 'done' : active ? 'active' : 'wait';
}

const DOT: Record<RubricState, { bg: string; bd: string }> = {
  done: { bg: P.okFill, bd: `2px solid ${P.okFill}` },
  active: { bg: P.bg, bd: `2.5px solid ${P.ink}` },
  wait: { bg: P.bg, bd: `1.5px solid ${P.line2}` },
};

const LABEL: Record<RubricState, string> = { done: P.ink2, active: P.ink, wait: P.line2 };

/** The rubric's title in its state colour (600 13px/22px). */
export function RubricLabel({ state, children }: { state: RubricState; children: ReactNode }) {
  return <span style={{ font: font(600, 13, 22), color: LABEL[state] }}>{children}</span>;
}

export function Rubric({
  n,
  state,
  label,
  connector,
  children,
  gap = 6,
}: {
  n: 1 | 2 | 3;
  state: RubricState;
  /** The rubric's title row; rubric 3 passes its own row (label + value + link). */
  label: ReactNode;
  /** Draw the connector to the next rubric (not on the last). */
  connector: boolean;
  children?: ReactNode;
  gap?: number;
}) {
  const dot = DOT[state];
  return (
    <div data-rubric={n} data-state={state} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
      <span
        data-dot={n}
        style={{ width: 26, flex: 'none', alignSelf: 'stretch', display: 'flex', justifyContent: 'center', position: 'relative' }}
      >
        {n === 1 && (
          <span
            aria-hidden="true"
            style={{ position: 'absolute', insetInlineStart: 12, top: -10, height: 10, width: 2, background: P.line }}
          />
        )}
        {connector && (
          <span
            aria-hidden="true"
            style={{ position: 'absolute', insetInlineStart: 12, top: 18, bottom: -14, width: 2, background: P.line, overflow: 'hidden' }}
          >
            <span
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                height: state === 'done' ? '100%' : '0%',
                background: P.okFill,
                transition: `height 250ms ${EO}`,
              }}
            />
          </span>
        )}
        <span
          style={{
            position: 'relative',
            zIndex: 1,
            marginTop: 4,
            width: 14,
            height: 14,
            flex: 'none',
            borderRadius: '50%',
            border: dot.bd,
            background: dot.bg,
            transition: `background-color 250ms ${EO}, border-color 250ms ${EO}`,
          }}
        />
      </span>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap }}>
        {typeof label === 'string' ? <RubricLabel state={state}>{label}</RubricLabel> : label}
        {children}
      </div>
    </div>
  );
}
