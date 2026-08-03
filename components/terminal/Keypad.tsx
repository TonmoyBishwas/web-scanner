'use client';

import { MI } from './MI';

interface KeypadProps {
  /** '0'–'9', '.', or 'back' */
  onKey: (key: string) => void;
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'back'];

// Design numeric keypad: LTR 3-column grid of 54px keys (#101821 / #1e2a35),
// 21px Roboto Mono digits, Material backspace.
export function Keypad({ onKey }: KeypadProps) {
  return (
    <div dir="ltr" className="grid grid-cols-3 gap-2">
      {KEYS.map(k => (
        <button
          key={k}
          onClick={() => onKey(k)}
          className="h-[54px] rounded-[12px] bg-tile border border-line text-[#e8eef2] font-mono font-extrabold text-[21px] flex items-center justify-center active:bg-brand active:text-[#04222f] active:border-brand"
        >
          {k === 'back' ? <MI name="backspace" size={23} /> : k}
        </button>
      ))}
    </div>
  );
}
