'use client';

import { useState, useEffect } from 'react';
import { WifiOff, Wifi, Loader2 } from 'lucide-react';

interface OfflineBannerProps {
  queueCount: number;
  isSyncing: boolean;
}

export function OfflineBanner({ queueCount, isSyncing }: OfflineBannerProps) {
  const [isOffline, setIsOffline] = useState(false);
  const [showReconnected, setShowReconnected] = useState(false);

  useEffect(() => {
    const goOffline = () => setIsOffline(true);
    const goOnline = () => {
      setIsOffline(false);
      if (queueCount > 0) {
        setShowReconnected(true);
      }
    };

    setIsOffline(!navigator.onLine);
    window.addEventListener('offline', goOffline);
    window.addEventListener('online', goOnline);
    return () => {
      window.removeEventListener('offline', goOffline);
      window.removeEventListener('online', goOnline);
    };
  }, [queueCount]);

  useEffect(() => {
    if (showReconnected && !isSyncing && queueCount === 0) {
      const t = setTimeout(() => setShowReconnected(false), 3000);
      return () => clearTimeout(t);
    }
  }, [showReconnected, isSyncing, queueCount]);

  if (isOffline) {
    return (
      <div className="bg-amber-600/90 text-white px-4 py-2 text-sm flex items-center gap-2 animate-slideInUp">
        <WifiOff className="w-4 h-4 shrink-0" />
        <span>You&apos;re offline — scans will be saved locally</span>
        {queueCount > 0 && (
          <span className="ml-auto bg-amber-800 px-2 py-0.5 rounded-full text-xs font-bold">
            {queueCount}
          </span>
        )}
      </div>
    );
  }

  if (isSyncing) {
    return (
      <div className="bg-blue-600/90 text-white px-4 py-2 text-sm flex items-center gap-2 animate-slideInUp">
        <Loader2 className="w-4 h-4 animate-spin shrink-0" />
        <span>Syncing {queueCount} scan{queueCount !== 1 ? 's' : ''}...</span>
      </div>
    );
  }

  if (showReconnected) {
    return (
      <div className="bg-green-600/90 text-white px-4 py-2 text-sm flex items-center gap-2 animate-slideInUp">
        <Wifi className="w-4 h-4 shrink-0" />
        <span>Back online</span>
      </div>
    );
  }

  return null;
}
