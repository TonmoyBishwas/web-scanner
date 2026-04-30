'use client';

import { useEffect, useRef, useState } from 'react';
import {
  clearDebugLogs,
  formatLogsForExport,
  getDebugLogs,
  subscribeDebugLogs,
  type LogEntry,
} from '@/lib/debug-log';

/**
 * Floating bug-report widget. Tap the 🐛 button to open a fullscreen modal
 * showing every captured console log + a "Copy all" button. Designed for
 * Android workers who can't open Chrome DevTools.
 *
 * The capture itself is set up once via installDebugLogCapture() in
 * pallet-verify/[token]/page.tsx — this component is purely the UI.
 */
export function DebugLogPanel() {
  const [open, setOpen] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>(() => [...getDebugLogs()]);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Keep the rendered list in sync with the buffer.
  useEffect(() => {
    return subscribeDebugLogs(() => setLogs([...getDebugLogs()]));
  }, []);

  // Reset the copy-feedback chip after a moment.
  useEffect(() => {
    if (copyState === 'idle') return;
    const id = setTimeout(() => setCopyState('idle'), 2500);
    return () => clearTimeout(id);
  }, [copyState]);

  async function handleCopy() {
    const text = formatLogsForExport();
    try {
      await navigator.clipboard.writeText(text);
      setCopyState('copied');
      return;
    } catch {
      // Fallback: select the textarea contents so the worker can long-press → copy.
      if (textareaRef.current) {
        try {
          textareaRef.current.focus();
          textareaRef.current.select();
          // Try the deprecated execCommand path as a last resort. On modern
          // browsers it may still work even when the async clipboard API
          // doesn't (e.g. inside some webviews).
          if (document.execCommand?.('copy')) {
            setCopyState('copied');
            return;
          }
        } catch {
          /* fall through */
        }
      }
      setCopyState('failed');
    }
  }

  return (
    <>
      {/* Floating button — sits in the upper-LEFT so it never overlaps the
          camera-switch button (upper-right) on the scanner viewport. */}
      <button
        onClick={() => setOpen(true)}
        aria-label="Open debug logs"
        title="Open debug logs"
        className="fixed top-2 left-2 z-30 w-10 h-10 rounded-full bg-gray-900/70 hover:bg-gray-800 text-white text-lg font-bold shadow-lg backdrop-blur-sm border border-gray-700 flex items-center justify-center"
      >
        🐛
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex flex-col bg-black/95 text-white">
          {/* Header */}
          <div className="bg-gray-900 px-3 py-2 flex items-center justify-between border-b border-gray-700">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-sm font-bold">🐛 Debug logs</span>
              <span className="text-xs text-gray-400">({logs.length})</span>
              {copyState === 'copied' && (
                <span className="text-[11px] bg-green-600 text-white px-2 py-0.5 rounded-full font-semibold">
                  ✓ Copied
                </span>
              )}
              {copyState === 'failed' && (
                <span className="text-[11px] bg-amber-600 text-white px-2 py-0.5 rounded-full font-semibold">
                  Long-press text below to copy
                </span>
              )}
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                onClick={handleCopy}
                className="bg-blue-600 hover:bg-blue-700 active:bg-blue-800 px-3 py-1.5 rounded-md text-xs font-semibold"
              >
                Copy all
              </button>
              <button
                onClick={() => clearDebugLogs()}
                className="bg-gray-700 hover:bg-gray-600 px-3 py-1.5 rounded-md text-xs font-semibold"
              >
                Clear
              </button>
              <button
                onClick={() => setOpen(false)}
                className="bg-red-600 hover:bg-red-700 px-3 py-1.5 rounded-md text-xs font-semibold"
              >
                Close
              </button>
            </div>
          </div>

          {/* Log list */}
          <div className="flex-1 overflow-auto bg-black px-2 py-2">
            {logs.length === 0 ? (
              <p className="text-gray-500 text-center mt-8 px-4 text-sm">
                No logs yet. Reproduce the issue (e.g. let the scanner pick a
                camera), then come back here.
              </p>
            ) : (
              <ol className="space-y-1 font-mono text-[11px] leading-snug">
                {logs.map((e, i) => {
                  const time = new Date(e.ts).toISOString().slice(11, 23);
                  const colour =
                    e.level === 'error'
                      ? 'text-red-400'
                      : e.level === 'warn'
                      ? 'text-yellow-400'
                      : 'text-gray-200';
                  return (
                    <li
                      key={`${e.ts}-${i}`}
                      className="border-b border-gray-800/60 pb-1"
                    >
                      <span className="text-gray-500">{time}</span>{' '}
                      <span className={`${colour} break-all whitespace-pre-wrap`}>
                        {e.msg}
                      </span>
                    </li>
                  );
                })}
              </ol>
            )}
          </div>

          {/* Hidden-ish fallback textarea — always present so the worker can
              long-press → select all → copy if the clipboard API rejects.
              Filled lazily when Copy All is tapped. */}
          <textarea
            ref={textareaRef}
            readOnly
            value={formatLogsForExport()}
            className="bg-gray-950 text-gray-300 text-[10px] font-mono p-2 h-24 w-full border-t border-gray-800 resize-none"
            onClick={(e) => (e.target as HTMLTextAreaElement).select()}
          />
        </div>
      )}
    </>
  );
}
