'use client';

/**
 * The per-scan action bar — shared by the newest-scan card (ActiveScanCard)
 * and an opened history row (HistoryRow), so both offer the same buttons in
 * the same order and colours.
 *
 * Order: Edit · All boxes identical · Delete. Delete (red, destructive, no
 * confirmation) sits last, away from Edit. When OCR failed, View · Retry get
 * their own first line and Retry is the primary; a failed history row has no
 * Edit/Identical, so it is one line: View · Retry · Delete.
 *
 * Sizing (2026-10-01): the old card row was a `flex-none` group that never
 * wrapped, so on a 360 px phone "All boxes identical" ran off the screen —
 * clipped inside a sheet that only scrolls vertically, i.e. unreachable. Here
 * every line wraps (`flex-wrap`), each button starts at its label width and
 * grows to fill the line (`flex-auto`), and `min-w-0` + `wrap-anywhere` let a
 * single over-wide label wrap inside its button instead of overflowing. Every
 * button on a line is the same height (32 px minimum).
 *
 * Each tap calls stopPropagation: the bar lives inside a tappable card header
 * / history row, and an action must not also toggle that.
 */

import type { MouseEvent } from 'react';
import { MI } from './MI';
import { useT } from '@/lib/i18n';

type Tone = 'primary' | 'neutral' | 'danger';

const TONE: Record<Tone, string> = {
  primary: 'bg-brand-weak border-brand/40 text-brand-weak-ink',
  neutral: 'bg-white/6 border-white/18 text-ink-inverse',
  danger: 'bg-danger-weak border-danger/45 text-danger-weak-ink',
};

const BTN =
  'flex-auto min-w-0 min-h-[32px] flex items-center justify-center gap-[4px] rounded-[9px] border px-[6px] py-[5px] text-[11px] font-extrabold leading-tight text-center';

const LINE = 'flex flex-wrap gap-[6px]';

interface Action {
  key: string;
  icon: string;
  label: string;
  tone: Tone;
  onPress: () => void;
}

function ActionButton({ icon, label, tone, onPress }: Omit<Action, 'key'>) {
  return (
    <button
      type="button"
      onClick={(e: MouseEvent) => { e.stopPropagation(); onPress(); }}
      className={`${BTN} ${TONE[tone]}`}
    >
      <MI name={icon} size={15} className="flex-none" />
      <span className="min-w-0 wrap-anywhere">{label}</span>
    </button>
  );
}

interface ScanActionsProps {
  /** Failed OCR with a captured frame: look at the photo. */
  onViewImage?: () => void;
  /** Failed OCR: re-run it. Its presence also demotes Edit to neutral. */
  onRetry?: () => void;
  onEdit?: () => void;
  /** "All boxes identical" — only when canDeclareIdentical(box). */
  onIdentical?: () => void;
  onDelete?: () => void;
}

export function ScanActions({ onViewImage, onRetry, onEdit, onIdentical, onDelete }: ScanActionsProps) {
  const tr = useT();

  const recovery: Action[] = [];
  if (onViewImage) recovery.push({ key: 'view', icon: 'image', label: tr('ocr.view'), tone: 'neutral', onPress: onViewImage });
  if (onRetry) recovery.push({ key: 'retry', icon: 'refresh', label: tr('ocr.retry'), tone: 'primary', onPress: onRetry });

  const main: Action[] = [];
  if (onEdit) main.push({ key: 'edit', icon: 'edit', label: tr('terminal.edit'), tone: onRetry ? 'neutral' : 'primary', onPress: onEdit });
  if (onIdentical) main.push({ key: 'identical', icon: 'content_copy', label: tr('identical.action'), tone: 'neutral', onPress: onIdentical });
  if (onDelete) main.push({ key: 'delete', icon: 'delete', label: tr('common.delete'), tone: 'danger', onPress: onDelete });

  const render = (list: Action[]) => list.map(({ key, ...a }) => <ActionButton key={key} {...a} />);

  // Nothing to edit (a failed history row) → one line: View · Retry · Delete.
  if (!onEdit && !onIdentical) {
    return <div className={LINE}>{render([...recovery, ...main])}</div>;
  }

  return (
    <div className="flex flex-col gap-[6px]">
      {recovery.length > 0 && <div className={LINE}>{render(recovery)}</div>}
      <div className={LINE}>{render(main)}</div>
    </div>
  );
}
