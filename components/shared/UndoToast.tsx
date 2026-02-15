'use client';

import { useEffect, useState } from 'react';
import { Undo2, X } from 'lucide-react';

interface UndoToastProps {
  barcode: string;
  onUndo: () => void;
  onDismiss: () => void;
  durationMs?: number;
}

export function UndoToast({ barcode, onUndo, onDismiss, durationMs = 5000 }: UndoToastProps) {
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
      className={`fixed bottom-20 left-4 right-4 z-[60] flex items-center gap-3 bg-gray-800 dark:bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 shadow-2xl transition-all duration-300 ${
        exiting ? 'translate-y-4 opacity-0' : 'translate-y-0 opacity-100 animate-slideInUp'
      }`}
    >
      <div className="flex-1 min-w-0">
        <p className="text-sm text-gray-200 truncate">
          Scanned: Box #{barcode.slice(-6)}
        </p>
      </div>
      <button
        onClick={handleUndo}
        className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 rounded-lg text-sm font-medium text-white transition-colors shrink-0"
      >
        <Undo2 className="w-3.5 h-3.5" />
        Undo
      </button>
      <button
        onClick={handleDismiss}
        className="text-gray-500 hover:text-gray-300 transition-colors"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
