'use client';

import { useEffect, useState } from 'react';
import { Undo2, X } from 'lucide-react';
import { useT } from '@/lib/i18n';

interface UndoToastProps {
  barcode: string;
  onUndo: () => void;
  onDismiss: () => void;
  durationMs?: number;
}

export function UndoToast({ barcode, onUndo, onDismiss, durationMs = 5000 }: UndoToastProps) {
  const tr = useT();
  const [visible, setVisible] = useState(true);
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setExiting(true);
      setTimeout(onDismiss, 300);
    }, durationMs);

    return () => clearTimeout(timer);
  }, [durationMs, onDismiss]);

  if (!visible) return null;

  const handleUndo = () => {
    onUndo();
    setExiting(true);
    setTimeout(() => setVisible(false), 300);
  };

  const handleDismiss = () => {
    setExiting(true);
    setTimeout(onDismiss, 300);
  };

  return (
    <div
      className={`fixed bottom-20 left-4 right-4 z-[60] flex items-center gap-3 bg-hover border border-line-strong rounded-[14px] px-4 py-3 shadow-2xl transition-all duration-300 ${
        exiting ? 'translate-y-4 opacity-0' : 'translate-y-0 opacity-100 animate-toastIn'
      }`}
    >
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-ink truncate font-mono" dir="ltr">
          {tr('scanner.scanned')}: {tr('scan.boxLabelShort', { id: barcode.slice(-6) })}
        </p>
      </div>
      <button
        onClick={handleUndo}
        className="flex items-center gap-1.5 px-3 py-2 bg-brand hover:bg-brand-hover active:bg-brand-active rounded-lg text-sm font-bold text-ink-inverse transition-colors shrink-0"
      >
        <Undo2 className="w-3.5 h-3.5" />
        {tr('issue.undo')}
      </button>
      <button
        onClick={handleDismiss}
        className="text-ink-muted hover:text-ink transition-colors"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
