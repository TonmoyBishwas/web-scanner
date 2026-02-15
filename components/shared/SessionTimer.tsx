'use client';

import { useState, useEffect } from 'react';
import { Clock } from 'lucide-react';

interface SessionTimerProps {
  createdAt: string;
  ttlMs?: number;
}

export function SessionTimer({ createdAt, ttlMs = 3600000 }: SessionTimerProps) {
  const [remaining, setRemaining] = useState<number>(() => {
    const expiresAt = new Date(createdAt).getTime() + ttlMs;
    return Math.max(0, expiresAt - Date.now());
  });

  useEffect(() => {
    const expiresAt = new Date(createdAt).getTime() + ttlMs;

    const interval = setInterval(() => {
      const left = Math.max(0, expiresAt - Date.now());
      setRemaining(left);
      if (left <= 0) clearInterval(interval);
    }, 1000);

    return () => clearInterval(interval);
  }, [createdAt, ttlMs]);

  const totalSeconds = Math.floor(remaining / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  let colorClass = 'text-gray-400 dark:text-gray-400';
  if (minutes < 5) {
    colorClass = 'text-red-400';
  } else if (minutes < 10) {
    colorClass = 'text-yellow-400';
  }

  if (remaining <= 0) {
    return (
      <span className="flex items-center gap-1 text-xs text-red-400 font-medium">
        <Clock className="w-3.5 h-3.5" />
        Expired
      </span>
    );
  }

  return (
    <span className={`flex items-center gap-1 text-xs font-mono font-medium ${colorClass}`}>
      <Clock className="w-3.5 h-3.5" />
      {String(minutes).padStart(2, '0')}:{String(seconds).padStart(2, '0')}
    </span>
  );
}
