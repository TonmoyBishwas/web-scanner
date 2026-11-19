'use client';

/**
 * copy_note_weight_check: the question a held Save waits on, in place of the
 * Save button — the note's weight a carton against the weight about to be
 * booked on every carton, and three answers (lib/copy-note-weight.ts:
 * book the note's weight, keep this one, type another). Its texts are
 * PROPOSED (text freeze). Shared by the copy form (IdenticalBoxesForm, 15/11)
 * and New carton (CartonCreator, 19/11), so both ask in the same words.
 */

import { MI } from './MI';
import { copyNoteText, type CopyNoteChoice, type CopyNoteGap } from '@/lib/copy-note-weight';
import type { Language } from '@/types';

export function CopyNoteAsk({ lang, ask, onAnswer }: {
  lang: Language | string | undefined;
  ask: CopyNoteGap;
  onAnswer: (choice: CopyNoteChoice) => void;
}) {
  const vars = { note: ask.noteKg, w: ask.weight };
  return (
    <div role="alertdialog" className="flex flex-col gap-2">
      <p className="flex items-start gap-[6px] text-[12px] font-extrabold text-warn-weak-ink leading-[1.45]">
        <MI name="report_problem" size={16} className="flex-none mt-[1px]" />
        <span className="min-w-0">{copyNoteText(lang, 'ask', vars)}</span>
      </p>
      <button
        onClick={() => onAnswer('note')}
        className="w-full min-h-[48px] rounded-[12px] bg-brand text-white text-[13.5px] font-black px-3"
      >
        {copyNoteText(lang, 'note', vars)}
      </button>
      <div className="flex gap-2">
        <button
          onClick={() => onAnswer('keep')}
          className="flex-1 min-w-0 min-h-[46px] rounded-[12px] bg-tile border border-line-strong text-ink-inverse text-[12.5px] font-extrabold px-2"
        >
          {copyNoteText(lang, 'keep', vars)}
        </button>
        <button
          onClick={() => onAnswer('type')}
          className="flex-1 min-w-0 min-h-[46px] rounded-[12px] bg-tile border border-line-strong text-ink-inverse text-[12.5px] font-extrabold px-2"
        >
          {copyNoteText(lang, 'type', vars)}
        </button>
      </div>
    </div>
  );
}
