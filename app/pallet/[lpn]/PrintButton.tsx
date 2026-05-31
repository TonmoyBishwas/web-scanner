'use client';

import { Printer } from 'lucide-react';

export function PrintButton() {
  return (
    <button
      onClick={() => window.print()}
      className="no-print inline-flex items-center gap-2 px-6 py-3 bg-brand text-ink-inverse rounded-lg font-medium hover:bg-brand-hover active:scale-95 transition-transform shadow-lg"
    >
      <Printer className="w-5 h-5" /> Print Sticker
    </button>
  );
}
