'use client';

/**
 * Receive form v3, one numbered card (5.8 collapsed / 5.9 open).
 *
 * Collapsed: number box, name, `מק"ט {code}`, and the status line (dot +
 * `{values} · {state} · {pallet}`). Open: the title row with its ×, then the
 * rail — rubric 1 packaging & quantity, rubric 2 expiry, rubric 3 pallet
 * (hidden while the keyboard is open).
 */
import { memo, type FocusEvent } from 'react';
import type { FormLine, Gap } from '@/lib/receipt-form';
import { palletOf, railState, type V3Draft, type V3LineDraft, type V3LineStatus } from '@/lib/receive-v3';
import { ExpiryStep } from './ExpiryStep';
import { CloseButton } from './icons';
import { PalletStep, type PalletPick } from './PalletStep';
import { QtyStep } from './QtyStep';
import { Rubric, rubricState } from './Rail';
import { BARE, P, font, type KbHandlers } from './tokens';
import { lineName, palletName, statusLineText, type Lang, type Tr } from './texts';

/** Everything an open card can do (the root binds these to the open line). */
export interface OpenCardApi {
  kb: KbHandlers;
  /** A number field in the list has focus: the pallet rubric hides. */
  kbOpen: boolean;
  qtyEdit: boolean;
  onQtyEdit: (open: boolean) => void;
  onCartons: (value: string) => void;
  onQty: (value: string) => void;
  onOpenPackaging: () => void;
  onReset: () => void;
  onGap: (g: Gap | null) => void;
  onGapNote: (v: string) => void;
  onGapNoteBlur: () => void;
  onDateType: (raw: string, caret: number | null) => void;
  onDatePick: (dotted: string) => void;
  onDateFocus: (e: FocusEvent<HTMLInputElement>) => void;
  onDateBlur: () => void;
  onToggleNoExpiry: () => void;
  onStartSplit: () => void;
  onSplitQty: (row: number, value: string) => void;
  onSplitType: (row: number, raw: string, caret: number | null) => void;
  onSplitBlur: (row: number) => void;
  onSplitRemove: (row: number) => void;
  onSplitAdd: () => void;
  /** The inline pallet list is open (by "בחירה"/"שנה" or by itself). */
  palletListOpen: boolean;
  onPalletChange: () => void;
  onPalletClose: () => void;
  onPalletPick: (v: PalletPick) => void;
}

export interface LineCardProps {
  line: FormLine;
  d: V3LineDraft;
  draft: V3Draft;
  status: V3LineStatus;
  today: string;
  lang: Lang;
  tr: Tr;
  onToggle: (index: number) => void;
  /** Set only on the open card. */
  api?: OpenCardApi | null;
}

const DOT: Record<V3LineStatus, { bg: string; bd: string; fg: string }> = {
  ready: { bg: P.okFill, bd: P.okFill, fg: P.ink },
  expiry: { bg: 'transparent', bd: P.ink, fg: P.ink },
  gap: { bg: 'transparent', bd: P.ink, fg: P.ink },
  pallet: { bg: 'transparent', bd: P.ink, fg: P.ink },
  fix: { bg: P.errFill, bd: P.errFill, fg: P.errText },
};

export function NumberBox({ n }: { n: number }) {
  return (
    <span
      style={{
        width: 26,
        height: 26,
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: `1px solid ${P.line2}`,
        borderRadius: 4,
        font: font(500, 13),
        color: P.ink,
      }}
    >
      {n}
    </span>
  );
}

function LineCardImpl({ line, d, draft, status, today, lang, tr, onToggle, api }: LineCardProps) {
  const open = !!api;
  const name = lineName(line, lang);
  return (
    <div
      data-row={line.index}
      id={`v3-line-${line.index}`}
      style={{ flex: 'none', padding: '0 12px', border: `1px solid ${open ? P.line2 : P.line}`, borderRadius: 6, background: P.bg }}
    >
      {!open ? (
        <button
          type="button"
          onClick={() => onToggle(line.index)}
          aria-expanded={false}
          style={{
            ...BARE,
            width: '100%',
            minHeight: 64,
            display: 'flex',
            alignItems: 'flex-start',
            gap: 12,
            padding: '10px 0',
            textAlign: 'start',
          }}
        >
          <NumberBox n={line.index} />
          <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
            <span style={{ font: font(500, 17, 1.3), paddingTop: 2 }}>{name}</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ font: font(400, 14, 1.35), color: P.ink2 }}>{tr('receive.v3.code', { code: `\u2068${line.code}\u2069` })}</span>
            </span>
            <span
              data-status={status}
              style={{ display: 'flex', alignItems: 'center', gap: 6, font: font(500, 15, 1.35), color: DOT[status].fg }}
            >
              <span
                style={{
                  width: 10,
                  height: 10,
                  flex: 'none',
                  borderRadius: '50%',
                  border: `2px solid ${DOT[status].bd}`,
                  background: DOT[status].bg,
                }}
              />
              {statusLineText(line, d, draft, status, lang, tr)}
            </span>
          </span>
        </button>
      ) : (
        <OpenBody line={line} d={d} draft={draft} today={today} lang={lang} tr={tr} onToggle={onToggle} api={api} name={name} />
      )}
    </div>
  );
}

function OpenBody({
  line,
  d,
  draft,
  today,
  lang,
  tr,
  onToggle,
  api,
  name,
}: Omit<LineCardProps, 'status' | 'api'> & { api: OpenCardApi; name: string }) {
  const rail = railState(line, d, draft, today);
  const v = palletOf(line, d, draft);
  const value: PalletPick | null = v === null || v === 'none' ? null : v;
  return (
    <div style={{ padding: '6px 0 10px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <NumberBox n={line.index} />
        <button
          type="button"
          onClick={() => onToggle(line.index)}
          aria-expanded={true}
          style={{
            ...BARE,
            flex: 1,
            minWidth: 0,
            padding: '2px 0 0',
            textAlign: 'start',
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
        >
          <span style={{ font: font(500, 18, 1.3) }}>{name}</span>
          <span style={{ font: font(400, 14), color: P.ink2 }}>
            {tr('receive.v3.codeLabel')} <bdi style={{ font: font(500, 14), color: P.ink }}>{line.code}</bdi>
          </span>
        </button>
        <CloseButton
          label={tr('receive.v3.close')}
          onClick={() => onToggle(line.index)}
          style={{ marginTop: -4, justifyContent: 'flex-end' }}
        />
      </div>
      <div data-rail="" style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Rubric n={1} state={rubricState(rail.s1, rail.active === 1)} label={tr('receive.v3.stepQty')} connector>
          <QtyStep
            line={line}
            d={d}
            lang={lang}
            tr={tr}
            kb={api.kb}
            qtyEdit={api.qtyEdit}
            onQtyEdit={api.onQtyEdit}
            onCartons={api.onCartons}
            onQty={api.onQty}
            onOpenPackaging={api.onOpenPackaging}
            onReset={api.onReset}
            onGap={api.onGap}
            onGapNote={api.onGapNote}
            onGapNoteBlur={api.onGapNoteBlur}
          />
        </Rubric>
        <Rubric n={2} state={rubricState(rail.s2, rail.active === 2)} label={tr('receive.v3.stepExpiry')} connector>
          <ExpiryStep
            line={line}
            d={d}
            today={today}
            lang={lang}
            tr={tr}
            onType={api.onDateType}
            onPick={api.onDatePick}
            onFocus={api.onDateFocus}
            onBlur={api.onDateBlur}
            onToggleNoExpiry={api.onToggleNoExpiry}
            onStartSplit={api.onStartSplit}
            onSplitQty={api.onSplitQty}
            onSplitType={api.onSplitType}
            onSplitBlur={api.onSplitBlur}
            onSplitRemove={api.onSplitRemove}
            onSplitAdd={api.onSplitAdd}
          />
        </Rubric>
        {!api.kbOpen && (
          <PalletStep
            state={rubricState(rail.s3, rail.active === 3)}
            isSet={value !== null}
            name={palletName(line, d, draft, tr)}
            open={api.palletListOpen}
            pallets={draft.pallets}
            value={value}
            lastPallet={draft.lastPallet}
            tr={tr}
            onChange={api.onPalletChange}
            onClose={api.onPalletClose}
            onPick={api.onPalletPick}
          />
        )}
      </div>
    </div>
  );
}

/** Memoised: a card re-renders only when its props change. */
export const LineCard = memo(LineCardImpl);
