'use client';

import { Printer } from 'lucide-react';

export function PrintButton() {
  return (
    <button
      onClick={() => window.print()}
      className="no-print inline-flex items-center gap-2 h-12 px-6 bg-brand text-ink-inverse rounded-xl font-extrabold hover:bg-brand-hover active:bg-brand-active active:scale-95 transition-transform shadow-lg"
    >
      <Printer className="w-5 h-5" /> Print Sticker
    </button>
  );
}
