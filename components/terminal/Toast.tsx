'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { MI } from './MI';
import { useT } from '@/lib/i18n';

export interface ToastState {
  message: string;
  icon: string;      // Material ligature name
  iconColor: string;
}

// Design toast: bottom-center pill #0d171d / #2a3a47, doneRise in, 2.4s.
export function Toast({ toast }: { toast: ToastState | null }) {
  if (!toast) return null;
  return (
    <div
      className="fixed z-[120] left-1/2 bottom-[26px] -translate-x-1/2 max-w-[84%] bg-overlay-card border border-line-strong rounded-[12px] px-[15px] py-[10px] shadow-[0_14px_34px_rgba(0,0,0,.6)] flex items-center gap-2 animate-doneRise"
      role="status"
    >
      <MI name={toast.icon} size={17} style={{ color: toast.iconColor }} className="flex-none" />
      <span className="text-[12px] font-extrabold text-ink">{toast.message}</span>
    </div>
  );
}

export function useToast(): {
  toast: ToastState | null;
  showToast: (message: string, icon?: string, iconColor?: string) => void;
} {
  const [toast, setToast] = useState<ToastState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const showToast = useCallback((message: string, icon = 'check_circle', iconColor = '#22c55e') => {
    if (timer.current) clearTimeout(timer.current);
    setToast({ message, icon, iconColor });
    timer.current = setTimeout(() => setToast(null), 2400);
  }, []);

  return { toast, showToast };
}

// Preset: locked-feature feedback — amber lock + "נעול · לא זמין עדיין".
export function useLockToast() {
  const { toast, showToast } = useToast();
  const tr = useT();
  const showLockToast = useCallback(() => {
    showToast(tr('terminal.lockedToast'), 'lock', '#f6b45a');
  }, [showToast, tr]);
  return { toast, showToast, showLockToast };
}
