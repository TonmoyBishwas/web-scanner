'use client';

import { MI } from './MI';

interface SelectBoxProps {
  checked: boolean;
  /** A booked carton: a lock instead of a box, never ticked. */
  locked?: boolean;
}

// Selection-mode checkbox from the client's design ("WMS Receiving
// Terminal"): 22×22, r6, 2px #3a4a57 border; ticked = brand fill with a dark
// check. Purely visual — the card or row around it takes the tap, so the
// whole card is the target for a gloved finger, not a 22 px square.
export function SelectBox({ checked, locked = false }: SelectBoxProps) {
  if (locked) {
    return (
      <span aria-hidden className="flex-none w-[22px] h-[22px] rounded-[6px] border-2 border-[#3a4a57] flex items-center justify-center">
        <MI name="lock" size={13} style={{ color: '#f6b45a' }} />
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className="flex-none w-[22px] h-[22px] rounded-[6px] border-2 flex items-center justify-center"
      style={checked ? { borderColor: '#13a4ec', background: '#13a4ec' } : { borderColor: '#3a4a57' }}
    >
      {checked && <MI name="check" size={16} style={{ color: '#04222f' }} />}
    </span>
  );
}
