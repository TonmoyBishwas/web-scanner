'use client';

/**
 * Receive form v3: back to the bot's WhatsApp chat (spec 8.4).
 *
 * `startRedirect()` shows "תודה! חוזרים לוואטסאפ…" with the 3 s bar, then
 * opens the chat. Opening = `https://wa.me/{botWaNumber}` (no text); if the
 * page is still visible 800 ms later (no WhatsApp, blocked) `window.close()`;
 * if that did not close the tab (`window.closed` still false — a tab the
 * script did not open), the redirect text and bar go away AT ONCE and
 * "סגרו" stays. With no number, `window.close()` directly, same fallback.
 * "סגרו" cancels the timer and opens the chat at once.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { V3 } from '@/lib/receive-v3';

export interface BotReturn {
  /** The redirect text + bar are showing; `key` restarts the bar's animation. */
  redirecting: boolean;
  redirectKey: number;
  startRedirect: (afterMs?: number) => void;
  openBotChat: () => void;
  cancel: () => void;
}

export function useBotReturn(botWaNumber: string | null, onOpen?: (how: 'redirect' | 'close') => void): BotReturn {
  const [redirecting, setRedirecting] = useState(false);
  const [redirectKey, setRedirectKey] = useState(0);
  const timers = useRef<number[]>([]);
  const onOpenRef = useRef(onOpen);
  useEffect(() => {
    onOpenRef.current = onOpen;
  });

  const clear = useCallback(() => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
  }, []);

  const later = useCallback((ms: number, fn: () => void) => {
    timers.current.push(window.setTimeout(fn, ms));
  }, []);

  const stillHere = () => typeof document !== 'undefined' && document.visibilityState === 'visible';

  const tryClose = useCallback(() => {
    try {
      window.close();
    } catch {
      /* not a script-opened window */
    }
    // A refused close leaves window.closed false right away: drop the redirect text now.
    let closed = false;
    try {
      closed = window.closed === true;
    } catch {
      closed = false;
    }
    if (!closed && stillHere()) {
      setRedirecting(false);
      return;
    }
    later(V3.CLOSE_FALLBACK_MS, () => {
      if (stillHere()) setRedirecting(false);
    });
  }, [later]);

  const go = useCallback(
    (how: 'redirect' | 'close') => {
      clear();
      try {
        onOpenRef.current?.(how);
      } catch {
        /* trace only */
      }
      const digits = (botWaNumber ?? '').replace(/\D/g, '');
      if (!digits) {
        tryClose();
        return;
      }
      try {
        window.location.href = `https://wa.me/${digits}`;
      } catch {
        /* blocked */
      }
      later(V3.CLOSE_FALLBACK_MS, () => {
        if (stillHere()) tryClose();
      });
    },
    [botWaNumber, clear, later, tryClose],
  );

  const startRedirect = useCallback(
    (afterMs = 0) => {
      clear();
      const run = () => {
        setRedirectKey(Date.now());
        setRedirecting(true);
        later(V3.REDIRECT_MS, () => go('redirect'));
      };
      if (afterMs > 0) later(afterMs, run);
      else run();
    },
    [clear, go, later],
  );

  const openBotChat = useCallback(() => go('close'), [go]);

  const cancel = useCallback(() => {
    clear();
    setRedirecting(false);
  }, [clear]);

  useEffect(() => clear, [clear]);

  return { redirecting, redirectKey, startRedirect, openBotChat, cancel };
}

/** The bot chat's link for "סגרו" (`https://wa.me/{digits}`), or null with no number. */
export function botChatHref(botWaNumber: string | null): string | null {
  const digits = (botWaNumber ?? '').replace(/\D/g, '');
  return digits ? `https://wa.me/${digits}` : null;
}
