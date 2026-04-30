/**
 * Module-level capture of `console.log/warn/error` (and unhandled errors)
 * into a ring buffer that the in-page debug panel renders. Designed so a
 * worker on a phone — where Chrome DevTools isn't an option — can tap a
 * button, copy logs, and paste them back without USB debugging.
 *
 * Strict Mode safe: `installDebugLogCapture()` is idempotent.
 */

export type LogLevel = 'log' | 'warn' | 'error';

export interface LogEntry {
  ts: number;
  level: LogLevel;
  msg: string;
}

const MAX_LOGS = 300;

const buffer: LogEntry[] = [];
const listeners = new Set<() => void>();
let installed = false;

function notify(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* never let a listener crash the capture */
    }
  }
}

function push(level: LogLevel, msg: string): void {
  buffer.push({ ts: Date.now(), level, msg });
  if (buffer.length > MAX_LOGS) buffer.shift();
  notify();
}

function formatArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (a === null) return 'null';
      if (a === undefined) return 'undefined';
      if (typeof a === 'string') return a;
      if (a instanceof Error) return `${a.name}: ${a.message}`;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
}

/**
 * Idempotently wraps console.{log,warn,error} so calls also feed into our
 * in-memory buffer, plus listens for unhandled errors / rejections. Safe to
 * call from any number of components / effects — only the first call
 * actually patches.
 */
export function installDebugLogCapture(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;

  console.log = (...args: unknown[]) => {
    try {
      push('log', formatArgs(args));
    } catch {
      /* ignore */
    }
    origLog.apply(console, args as never);
  };
  console.warn = (...args: unknown[]) => {
    try {
      push('warn', formatArgs(args));
    } catch {
      /* ignore */
    }
    origWarn.apply(console, args as never);
  };
  console.error = (...args: unknown[]) => {
    try {
      push('error', formatArgs(args));
    } catch {
      /* ignore */
    }
    origError.apply(console, args as never);
  };

  window.addEventListener('error', (e) => {
    push(
      'error',
      `unhandled: ${e.message} at ${e.filename || '?'}:${e.lineno || '?'}`,
    );
  });
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason instanceof Error
      ? `${e.reason.name}: ${e.reason.message}`
      : String(e.reason);
    push('error', `unhandledrejection: ${reason}`);
  });

  push('log', '[debug-log] capture installed');
  // User-agent + viewport + permission state are useful when triaging
  // device-specific bugs. Push them right after install so they're at
  // the top of every export.
  try {
    push('log', `[debug-log] UA: ${navigator.userAgent}`);
    push(
      'log',
      `[debug-log] window: ${window.innerWidth}x${window.innerHeight}, dpr=${window.devicePixelRatio}`,
    );
  } catch {
    /* ignore */
  }
}

export function getDebugLogs(): readonly LogEntry[] {
  return buffer;
}

export function clearDebugLogs(): void {
  buffer.length = 0;
  notify();
}

export function subscribeDebugLogs(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Plain-text export for clipboard / paste. One line per entry. */
export function formatLogsForExport(): string {
  return buffer
    .map((e) => {
      const t = new Date(e.ts).toISOString().slice(11, 23); // HH:MM:SS.mmm
      return `[${t}] ${e.level.toUpperCase().padEnd(5)} ${e.msg}`;
    })
    .join('\n');
}
