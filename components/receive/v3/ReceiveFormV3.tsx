'use client';

/**
 * Receive form v3 (06/11, flag receive_form_v3): the non-meat receive form as
 * drawn in the approved Claude Design prototype ("Non-Meat Receive Form").
 *
 * One component owns the screens — step 1 (pallets), the loose sub-screen,
 * the list (cards with the three-step rail), the confirmation, the status
 * screen and the notices — plus the sheets, the note-photo viewer, the draft
 * (restore / persist / merge), the 15 s poll for two-page notes, the submit
 * and the return to WhatsApp. Rules live in lib/receive-v3.ts; the calls in
 * lib/receive-v3-client.ts. Nothing here imports server code: the trace goes
 * out through the optional `trace` prop (shaped like useReceiveTrace's API)
 * and `onDraftChange` (the integrator feeds useReceiveTrace with it).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type ReactNode } from 'react';
import { EXTRA_UNIT_LABELS, closedView, fingerprints, lineFingerprint, type ClosedReason, type ExtraUnit, type Gap, type LineDraft } from '@/lib/receipt-form';
import type { FormLine } from '@/lib/receipt-form';
import type { ReceiveEventName } from '@/lib/receive-trace';
import {
  V3,
  addSplitRowPatch,
  checkV3BeforeSend,
  dateJustCompleted,
  dottedToIso,
  expState,
  expandDate,
  initialV3Draft,
  kbViewportStep,
  lineStatusV3,
  mergeV3Draft,
  palletOf,
  remainingLines,
  removeSplitRowPatch,
  resetToNotePatch,
  restoreV3Draft,
  searchV3,
  serializeV3Draft,
  setCartonsPatch,
  setSplitQtyPatch,
  shortSupplierName,
  shouldAutoOpenPalletList,
  startSplitPatch,
  typeDate,
  v3DraftStorageKey,
  v3DraftToAnswers,
  type KbViewport,
  type ReceiveFormV3Props,
  type V3Draft,
  type V3LineDraft,
  type V3LineStatus,
  type V3NoticeKind,
  type V3SaveProblems,
} from '@/lib/receive-v3';
import { fetchV3Status, pollFormV3, submitV3, type V3SubmitResult } from '@/lib/receive-v3-client';
import { BottomBar } from './BottomBar';
import { ConfirmScreen } from './ConfirmScreen';
import { rubik } from './font';
import { V3Icon } from './icons';
import { LineCard, type OpenCardApi } from './LineCard';
import { HeaderRow, SearchRow, TabToggle } from './ListHeader';
import { LooseScreen } from './LooseScreen';
import { NotePhotoViewer } from './NotePhotoViewer';
import { AUTO_RETURN, NoticeScreen } from './NoticeScreen';
import type { PalletPick } from './PalletStep';
import { ErrorSheet, ExtraSheet, PackagingSheet, PalletListSheet, PalletsSheet } from './Sheets';
import { StatusScreen, useStatusFlow, type FinalOutcome } from './StatusScreen';
import { StepPallets } from './StepPallets';
import { BARE, I, P, UNDERLINE, font, type KbHandlers } from './tokens';
import { langOf, makeTr, pkgText } from './texts';
import { useBackStack } from './useBackStack';
import { botChatHref, useBotReturn } from './useBotReturn';
import css from './v3.module.css';

// ── Props ────────────────────────────────────────────────────────────────

/** The trace, shaped like app/receive/[id]/useReceiveTrace's ReceiveTraceApi (every call optional but `event`). */
export interface V3Trace {
  event(event: ReceiveEventName, data?: Record<string, unknown>): void;
  lineEdit?(index: number, patch: Partial<LineDraft>): void;
  palletsEdit?(value: string): void;
  extraEdit?(key: string, patch: { name?: string; quantity?: string; unit?: string }): void;
  saveAttempt?(data: Record<string, unknown>): number;
  saveDone?(started: number, ok: boolean, data: Record<string, unknown>): void;
}

/** What the integrator needs to run useReceiveTrace on the v3 draft (via v3ToLegacyDraft). */
export interface V3DraftMeta {
  restored: boolean;
  rev: number;
  lines: FormLine[];
  query: string;
  search: { active: boolean; fuzzy: boolean; lines: { index: number }[] };
}

export type ReceiveFormV3AllProps = ReceiveFormV3Props & {
  trace?: V3Trace | null;
  onDraftChange?: (draft: V3Draft, meta: V3DraftMeta) => void;
};

type Screen = 'pallets' | 'loose' | 'list' | 'confirm' | 'status' | 'notice';
type SheetState =
  | null
  | { kind: 'pallets'; snap: { pallets: number; loose: Record<number, number>; looseYes: boolean } }
  | { kind: 'palList'; index: number }
  | { kind: 'pkg'; index: number }
  | { kind: 'extra'; name: string };
type ErrorState = null | { text: string; retry: 'send' | 'first' };

const isFormScreen = (s: Screen) => s === 'pallets' || s === 'loose' || s === 'list' || s === 'confirm';

/** The line's packages for "outside the pallet": its cartons, or 1 when blank / 0. */
function packagesOf(d: Pick<V3LineDraft, 'cartons'>): number {
  const n = Number((d.cartons ?? '').replace(/\D/g, ''));
  return d.cartons && Number.isFinite(n) && n >= 1 ? n : 1;
}

/** A v3 line patch as the classic trace sees it (ISO expiry; v3-only keys dropped). */
function legacyPatch(p: Partial<V3LineDraft>): Partial<LineDraft> {
  const out: Partial<LineDraft> = {};
  if (p.qty !== undefined) out.qty = p.qty;
  if (p.cartons !== undefined) out.cartons = p.cartons;
  if (p.packaging !== undefined) out.packaging = p.packaging;
  if (p.expiry !== undefined) out.expiry = dottedToIso(p.expiry) ?? '';
  if (p.noExpiry !== undefined) out.noExpiry = p.noExpiry;
  if (p.gap !== undefined) out.gap = p.gap;
  if (p.gapNote !== undefined) out.gapNote = p.gapNote;
  return out;
}

/** Copy this form's v3 draft to the form that replaced it, unless that one has its own (as FormMoved). */
function carryV3Draft(fromId: string, toId: string): void {
  try {
    const raw = window.localStorage.getItem(v3DraftStorageKey(fromId));
    if (raw && !window.localStorage.getItem(v3DraftStorageKey(toId))) window.localStorage.setItem(v3DraftStorageKey(toId), raw);
  } catch {
    /* storage blocked: the new form starts from the note */
  }
}

/** Run twice (now and after 60 ms), as the prototype's later(). */
function later(fn: () => void): void {
  window.setTimeout(fn, 0);
  window.setTimeout(fn, 60);
}

/** Lines not ready (remainingLines) plus the lines a save check refused, in note order. */
function remainingWith(lines: FormLine[], draft: V3Draft, today: string, flagged: ReadonlySet<number>): number[] {
  if (!flagged.size) return remainingLines(lines, draft, today);
  const rem = new Set(remainingLines(lines, draft, today));
  return lines.filter((l) => rem.has(l.index) || flagged.has(l.index)).map((l) => l.index);
}

// ── The form ─────────────────────────────────────────────────────────────

export function ReceiveFormV3(props: ReceiveFormV3AllProps) {
  const { formId, exp, sig, language, header, boot, initialView, previousFormIds, trace, onDraftChange } = props;
  const lang = langOf(language);
  const rtl = lang === 'he';
  const tr = useMemo(() => makeTr(language), [language]);
  const today = boot.today;

  // Lines and revision (a two-page note grows while the form is open).
  const [lines, setLines] = useState<FormLine[]>(props.lines);
  const [rev, setRev] = useState<number>(header.rev || 1);
  const linesRef = useRef(lines);
  const revRef = useRef(rev);

  /** Lines a save check refused (page or server 422): shown as "בדקו את השורה" until changed. */
  const [flagged, setFlagged] = useState<ReadonlySet<number>>(() => new Set());
  const flaggedRef = useRef(flagged);

  // The draft: every change goes through commit() so the ref is never behind.
  const [draft, setDraftState] = useState<V3Draft>(() => initialV3Draft(props.lines));
  const draftRef = useRef(draft);
  const commit = useCallback((next: V3Draft) => {
    const prev = draftRef.current;
    draftRef.current = next;
    setDraftState(next);
    // A refused line that changed (its values, its pallet, outside the pallet) or a new
    // pallet count clears the mark; the page's own checks and the next save decide again.
    if (flaggedRef.current.size) {
      const before = new Map(prev.lines.map((l) => [l.index, l]));
      const keep = new Set<number>();
      if (prev.pallets === next.pallets) {
        for (const l of next.lines) {
          if (!flaggedRef.current.has(l.index)) continue;
          const b = before.get(l.index);
          const same = !!b && JSON.stringify({ ...b, ack: false }) === JSON.stringify({ ...l, ack: false });
          if (same && prev.loose[l.index] === next.loose[l.index]) keep.add(l.index);
        }
      }
      if (keep.size !== flaggedRef.current.size) {
        flaggedRef.current = keep;
        setFlagged(keep);
      }
    }
  }, []);
  const [restored, setRestored] = useState(false);
  const savedRef = useRef(false);

  // Screens and layers.
  const [screen, setScreen] = useState<Screen>(
    initialView.kind === 'form' ? 'pallets' : initialView.kind === 'status' ? 'status' : 'notice',
  );
  const [notice, setNotice] = useState<V3NoticeKind>(initialView.kind === 'notice' ? initialView.notice : 'failed');
  const [newer, setNewer] = useState<{ id: string; href: string } | null>(
    initialView.kind === 'notice' ? (initialView.newer ?? null) : null,
  );
  const [looseYes, setLooseYes] = useState(false);
  const [looseFrom, setLooseFrom] = useState<'pallets' | 'list'>('pallets');
  const [looseSnap, setLooseSnap] = useState<Record<number, number> | null>(null);
  const [looseQuery, setLooseQuery] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const openRef = useRef(open);
  const [tab, setTab] = useState<'need' | 'done'>('need');
  const [query, setQuery] = useState('');
  const [headCollapsed, setHeadCollapsed] = useState(false);
  const [kbOpen, setKbOpen] = useState(false);
  const [qtyEdit, setQtyEdit] = useState(false);
  const [palListOpen, setPalListOpen] = useState(false);
  const [palClosed, setPalClosed] = useState(false);
  const [sheet, setSheet] = useState<SheetState>(null);
  const [viewer, setViewer] = useState(false);
  const [error, setError] = useState<ErrorState>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const sending = useRef(false);
  const kbTimer = useRef<number | null>(null);
  const collapseTimer = useRef<number | null>(null);

  useLayoutEffect(() => {
    linesRef.current = lines;
    revRef.current = rev;
    openRef.current = open;
    flaggedRef.current = flagged;
  });

  // ── Trace (never breaks the form) ──
  const traceRef = useRef(trace);
  useEffect(() => {
    traceRef.current = trace;
  });
  const emit = useCallback((event: ReceiveEventName, data?: Record<string, unknown>) => {
    try {
      traceRef.current?.event(event, data);
    } catch {
      /* tracing only */
    }
  }, []);
  const step = useCallback(
    (name: string, data?: Record<string, unknown>) => emit('receive_step', { v: 3, step: name, ...(data ?? {}) }),
    [emit],
  );

  // ── Derived ──
  const byIndex = useMemo(() => new Map(draft.lines.map((d) => [d.index, d])), [draft.lines]);
  const statuses = useMemo(() => {
    const m = new Map<number, V3LineStatus>();
    for (const l of lines) {
      const d = byIndex.get(l.index);
      if (d) m.set(l.index, flagged.has(l.index) ? 'fix' : lineStatusV3(l, d, draft, today));
    }
    return m;
  }, [lines, byIndex, draft, today, flagged]);
  const remaining = useMemo(() => remainingWith(lines, draft, today, flagged), [lines, draft, today, flagged]);
  const looseCount = Object.keys(draft.loose).length;
  const looseOn = looseYes || looseCount > 0;
  const search = useMemo(() => searchV3(lines, query), [lines, query]);

  // ── Status flow + return to WhatsApp ──
  const bot = useBotReturn(boot.botWaNumber, (how) => step(how === 'redirect' ? 'redirect' : 'close_to_bot'));
  const flow = useStatusFlow({
    erp: boot.erp,
    fetchStatus: () => fetchV3Status({ formId, exp, sig }),
    onFinal: (outcome: FinalOutcome, resumed: boolean) => {
      emit('receive_outcome', { v: 3, outcome, resumed });
      if (outcome === 'success' || outcome === 'partial') bot.startRedirect(resumed ? 400 : V3.REDIRECT_DELAY_MS);
    },
  });

  // A reopened done form: the status screen continues from the server's state (8.5).
  useEffect(() => {
    if (initialView.kind === 'status') flow.resume(null);
    // once, on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Notices that return to WhatsApp by themselves (from mount or when shown).
  useEffect(() => {
    if (screen === 'notice' && AUTO_RETURN.has(notice)) bot.startRedirect(0);
    // bot is stable enough: its callbacks only read their own refs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, notice]);

  // ── Draft restore (after mount; SSR renders the fresh draft) ──
  useEffect(() => {
    if (initialView.kind !== 'form') return;
    let got: ReturnType<typeof restoreV3Draft> = null;
    try {
      got = restoreV3Draft(window.localStorage.getItem(v3DraftStorageKey(formId)), props.lines);
      for (const id of previousFormIds) {
        if (got) break;
        got = restoreV3Draft(window.localStorage.getItem(v3DraftStorageKey(id)), props.lines);
      }
    } catch {
      got = null;
    }
    if (got) {
      commit(got.draft);
      if (Object.keys(got.draft.loose).length) setLooseYes(true);
      if (got.draft.stage === 'list') setScreen('list');
    }
    setRestored(true);
    // once, on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Draft persistence ──
  useEffect(() => {
    if (!restored || savedRef.current) return;
    try {
      window.localStorage.setItem(v3DraftStorageKey(formId), serializeV3Draft(draft, lines, rev));
    } catch {
      /* storage full / blocked: the form still works */
    }
  }, [draft, lines, rev, restored, formId]);

  const clearStoredDraft = useCallback(() => {
    savedRef.current = true;
    try {
      window.localStorage.removeItem(v3DraftStorageKey(formId));
    } catch {
      /* nothing to clear */
    }
  }, [formId]);

  useEffect(() => {
    if (screen === 'notice' && notice === 'alreadySaved') clearStoredDraft();
  }, [screen, notice, clearStoredDraft]);

  // ── The integrator's trace feed ──
  const onDraftChangeRef = useRef(onDraftChange);
  useEffect(() => {
    onDraftChangeRef.current = onDraftChange;
  });
  useEffect(() => {
    try {
      onDraftChangeRef.current?.(draft, {
        restored,
        rev,
        lines,
        query,
        search: { active: search.active, fuzzy: false, lines: search.lines },
      });
    } catch {
      /* tracing only */
    }
  }, [draft, restored, rev, lines, query, search]);

  // ── Draft edits ──
  const patchLine = useCallback(
    (index: number, p: Partial<V3LineDraft> | ((d: V3LineDraft) => Partial<V3LineDraft>)) => {
      const cur = draftRef.current;
      const x = cur.lines.find((l) => l.index === index);
      if (!x) return;
      const patch = typeof p === 'function' ? p(x) : p;
      if (!Object.keys(patch).length) return;
      commit({ ...cur, lines: cur.lines.map((l) => (l.index === index ? { ...l, ...patch } : l)) });
      const lp = legacyPatch(patch);
      if (Object.keys(lp).length) {
        try {
          traceRef.current?.lineEdit?.(index, lp);
        } catch {
          /* tracing only */
        }
      }
    },
    [commit],
  );

  const setPallets = useCallback(
    (n: number) => {
      const v = Math.max(0, Math.min(V3.MAX_PALLETS, Math.round(n) || 0));
      commit({ ...draftRef.current, pallets: v });
      try {
        traceRef.current?.palletsEdit?.(String(v));
      } catch {
        /* tracing only */
      }
    },
    [commit],
  );

  const setLoose = useCallback(
    (loose: Record<number, number>, clearPalletOf?: number) => {
      const cur = draftRef.current;
      commit({
        ...cur,
        loose,
        lines: clearPalletOf === undefined ? cur.lines : cur.lines.map((l) => (l.index === clearPalletOf ? { ...l, pallet: null } : l)),
      });
    },
    [commit],
  );

  // ── Scrolling ──
  const reveal = useCallback(() => {
    const list = listRef.current;
    const o = openRef.current;
    if (!list || o === null) return;
    const row = list.querySelector<HTMLElement>(`[data-row="${o}"]`);
    if (!row) return;
    let st = row.offsetTop;
    const f = document.activeElement;
    if (f && row.contains(f) && (f as HTMLElement).dataset?.keyboard) {
      const fb = f.getBoundingClientRect().bottom - row.getBoundingClientRect().top;
      if (fb + 8 > list.clientHeight) st = row.offsetTop + fb + 8 - list.clientHeight;
    }
    list.scrollTop = st;
  }, []);

  const revealStep3 = useCallback((force: boolean) => {
    const list = listRef.current;
    const o = openRef.current;
    if (!list || o === null) return;
    const r3 = list.querySelector<HTMLElement>(`[data-row="${o}"] [data-rubric="3"]`);
    if (!r3) return;
    if (!force && !r3.querySelector('[role="listbox"]')) return;
    const over = r3.getBoundingClientRect().bottom - (list.getBoundingClientRect().bottom - 8);
    if (over > 0) list.scrollTop += over;
  }, []);

  // ── Cards ──
  const clearCollapse = () => {
    if (collapseTimer.current !== null) window.clearTimeout(collapseTimer.current);
    collapseTimer.current = null;
  };

  /** Step 1 of the card being left is acknowledged unless it is short-without-reason or invalid. */
  const ackLeaving = useCallback(
    (index: number | null) => {
      if (index === null) return;
      const line = linesRef.current.find((l) => l.index === index);
      const d = draftRef.current.lines.find((l) => l.index === index);
      if (!line || !d || d.ack) return;
      const st = lineStatusV3(line, d, draftRef.current, today);
      if (st === 'gap' || st === 'fix') return;
      patchLine(index, { ack: true });
    },
    [patchLine, today],
  );

  const openCard = useCallback(
    (index: number) => {
      clearCollapse();
      ackLeaving(openRef.current);
      openRef.current = index;
      setOpen(index);
      setQtyEdit(false);
      setPalListOpen(false);
      setPalClosed(false);
      step('card_open', { line: index });
      later(reveal);
    },
    [ackLeaving, reveal, step],
  );

  const closeCard = useCallback(
    (how: 'card_close' | 'card_auto_close' = 'card_close') => {
      clearCollapse();
      const o = openRef.current;
      if (o === null) return;
      if (how === 'card_close') ackLeaving(o);
      openRef.current = null;
      setOpen(null);
      setQtyEdit(false);
      setPalListOpen(false);
      setPalClosed(false);
      step(how, { line: o });
    },
    [ackLeaving, step],
  );

  const toggleCard = useCallback(
    (index: number) => {
      if (openRef.current === index) closeCard();
      else openCard(index);
    },
    [closeCard, openCard],
  );

  /**
   * The prototype's maybeCollapse(): 1.4 s from now, close the open card if it
   * is still that card, still ready, and the worker is not typing in a plain
   * text field of the list (the gap note); a numeric field just loses focus.
   */
  const maybeCollapse = useCallback(() => {
    const o = openRef.current;
    if (o === null) return;
    clearCollapse();
    collapseTimer.current = window.setTimeout(() => {
      collapseTimer.current = null;
      if (openRef.current !== o) return;
      const ln = linesRef.current.find((l) => l.index === o);
      const dx = draftRef.current.lines.find((l) => l.index === o);
      if (!ln || !dx || lineStatusV3(ln, dx, draftRef.current, today) !== 'ready') return;
      const a = document.activeElement as HTMLInputElement | null;
      if (a && a.tagName === 'INPUT' && !a.dataset.keyboard && a.type !== 'date' && listRef.current?.contains(a)) return;
      a?.blur?.();
      setKbOpen(false);
      closeCard('card_auto_close');
    }, V3.AUTO_COLLAPSE_MS);
  }, [closeCard, today]);

  // Auto-collapse (1.4 s after the open card becomes ready) and step 3 reveal.
  const prevOpen = useRef<{ index: number; ready: boolean; expOk: boolean } | null>(null);
  useEffect(() => {
    if (open === null) {
      prevOpen.current = null;
      return;
    }
    const line = lines.find((l) => l.index === open);
    const d = byIndex.get(open);
    if (!line || !d) return;
    const ready = statuses.get(open) === 'ready';
    const expOk = expState(line, d, today) === 'ok';
    const prev = prevOpen.current;
    prevOpen.current = { index: open, ready, expOk };
    if (!prev || prev.index !== open) return;
    if (!prev.expOk && expOk) later(() => revealStep3(false));
    if (!ready) return clearCollapse();
    if (prev.ready) return;
    maybeCollapse();
  }, [open, draft, lines, byIndex, statuses, today, revealStep3, maybeCollapse]);

  useEffect(() => () => clearCollapse(), []);

  // Nothing left under "לא מולאו": the toggle moves to "מולאו".
  useEffect(() => {
    if (screen === 'list' && tab === 'need' && remaining.length === 0 && open === null) setTab('done');
  }, [screen, tab, remaining.length, open]);

  // ── "Keyboard open" (6.2) ──
  const kb: KbHandlers = useMemo(
    () => ({
      onFocus: (e: FocusEvent<HTMLInputElement>) => {
        try {
          e.target.select();
        } catch {
          /* not selectable */
        }
        if (kbTimer.current !== null) window.clearTimeout(kbTimer.current);
        kbTimer.current = null;
        setKbOpen(true);
        later(reveal);
      },
      onBlur: () => {
        if (kbTimer.current !== null) window.clearTimeout(kbTimer.current);
        kbTimer.current = window.setTimeout(() => {
          kbTimer.current = null;
          const a = document.activeElement as HTMLElement | null;
          if (a && a.dataset?.keyboard) return;
          setKbOpen(false);
        }, 150);
      },
    }),
    [reveal],
  );
  useEffect(
    () => () => {
      if (kbTimer.current !== null) window.clearTimeout(kbTimer.current);
    },
    [],
  );

  /** Close the phone's keyboard now: the focused number field loses focus and the pallet step shows. */
  const closeKeyboard = useCallback(() => {
    const a = document.activeElement as HTMLElement | null;
    if (a && a.dataset?.keyboard) a.blur();
    if (kbTimer.current !== null) window.clearTimeout(kbTimer.current);
    kbTimer.current = null;
    setKbOpen(false);
  }, []);

  // Android's "hide keyboard" keeps the field focused: when the viewport is back to full height, let go of it.
  const kbView = useRef<KbViewport>({ base: 0, shrunk: false });
  useEffect(() => {
    const vv = typeof window === 'undefined' ? null : window.visualViewport;
    if (!vv) return;
    kbView.current = { base: vv.height, shrunk: false };
    const onResize = () => {
      const a = document.activeElement as HTMLElement | null;
      const typing = !!(a && a.dataset?.keyboard && listRef.current?.contains(a));
      const r = kbViewportStep(kbView.current, vv.height, typing);
      kbView.current = r.next;
      if (r.closed) closeKeyboard();
    };
    vv.addEventListener('resize', onResize);
    return () => vv.removeEventListener('resize', onResize);
  }, [closeKeyboard]);

  // ── Pallets ──
  const pickPallet = useCallback(
    (index: number, v: PalletPick) => {
      const cur = draftRef.current;
      const d = cur.lines.find((l) => l.index === index);
      if (!d) return;
      const loose = { ...cur.loose };
      if (v === 'loose') {
        if (!(index in loose)) loose[index] = packagesOf(d);
      } else delete loose[index];
      commit({
        ...cur,
        loose,
        lastPallet: typeof v === 'number' ? v : cur.lastPallet,
        lines: cur.lines.map((l) => (l.index === index ? { ...l, pallet: typeof v === 'number' ? v : null } : l)),
      });
      setLooseYes(Object.keys(loose).length > 0);
      setPalListOpen(false);
      step('pal_pick', { line: index, pallet: v });
    },
    [commit, step],
  );

  const openLoose = useCallback(
    (from: 'pallets' | 'list') => {
      setLooseSnap({ ...draftRef.current.loose });
      setLooseFrom(from);
      setLooseQuery('');
      setSheet(null);
      setScreen('loose');
      step('loose_open');
    },
    [step],
  );

  const toggleLooseCheck = useCallback(
    (from: 'pallets' | 'list') => {
      if (looseOn) {
        setLooseYes(false);
        const cur = draftRef.current;
        commit({ ...cur, loose: {} });
        return;
      }
      setLooseYes(true);
      openLoose(from);
    },
    [commit, looseOn, openLoose],
  );

  const cancelLoose = useCallback(() => {
    const m = looseSnap ?? draftRef.current.loose;
    commit({ ...draftRef.current, loose: m });
    setLooseYes(Object.keys(m).length > 0);
    setLooseSnap(null);
    setLooseQuery('');
    setScreen(looseFrom);
    step('loose_cancel');
  }, [commit, looseFrom, looseSnap, step]);

  const confirmLoose = useCallback(() => {
    if (!Object.keys(draftRef.current.loose).length) return;
    setLooseYes(true);
    setLooseSnap(null);
    setLooseQuery('');
    setScreen(looseFrom);
    step('loose_confirm', { lines: Object.keys(draftRef.current.loose).length });
  }, [looseFrom, step]);

  const cancelPalletsSheet = useCallback(() => {
    if (sheet?.kind === 'pallets') {
      const s = sheet.snap;
      commit({ ...draftRef.current, pallets: s.pallets, loose: s.loose });
      setLooseYes(s.looseYes);
    }
    setSheet(null);
  }, [commit, sheet]);

  // ── List actions ──
  const goFirstMissing = useCallback(() => {
    const rem = remainingWith(linesRef.current, draftRef.current, today, flaggedRef.current);
    if (!rem.length) return;
    setTab('need');
    setQuery('');
    openCard(rem[0]);
  }, [openCard, today]);

  const onQuery = useCallback(
    (q: string) => {
      setQuery(q);
      if (openRef.current !== null) closeCard();
    },
    [closeCard],
  );

  const onTab = useCallback(
    (t: 'need' | 'done') => {
      if (t === tab) return;
      if (openRef.current !== null) closeCard();
      setTab(t);
      emit('receive_tab', { v: 3, tab: t });
    },
    [closeCard, emit, tab],
  );

  const openConfirm = useCallback(() => {
    clearCollapse();
    ackLeaving(openRef.current);
    openRef.current = null;
    setOpen(null);
    setQuery('');
    setKbOpen(false);
    setScreen('confirm');
    step('confirm');
  }, [ackLeaving, step]);

  const goFromConfirm = useCallback(
    (index: number) => {
      setScreen('list');
      setTab('done');
      setQuery('');
      step('back_to_list', { line: index });
      openCard(index);
    },
    [openCard, step],
  );

  // ── Leaving for a newer form ──
  const goToNewer = useCallback(
    (to: { id: string; href: string }) => {
      carryV3Draft(formId, to.id);
      try {
        window.location.replace(to.href);
      } catch {
        /* blocked: the notice's button stays */
      }
    },
    [formId],
  );

  const showNotice = useCallback(
    (kind: V3NoticeKind, nw: { id: string; href: string } | null = null) => {
      setSheet(null);
      setViewer(false);
      setError(null);
      setOpen(null);
      openRef.current = null;
      setNotice(kind);
      setNewer(nw);
      setScreen('notice');
    },
    [],
  );

  /** A closed / done status → its notice (a replaced form with a newer link → go there). */
  const onNotOpen = useCallback(
    (status: string | null, reason: string | null, nw: { id: string; href: string } | null, at: string) => {
      emit('receive_outcome', { v: 3, status, closed_reason: reason, at });
      const view = closedView(status ?? 'done', (reason as ClosedReason | null) ?? null);
      if (view === 'replaced') {
        if (nw) {
          goToNewer(nw);
          return showNotice('replaced', nw);
        }
        return showNotice('replaced', null);
      }
      if (view === 'cancelled') return showNotice('cancelled');
      if (view === 'duplicate') return showNotice('duplicate');
      return showNotice('alreadySaved');
    },
    [emit, goToNewer, showNotice],
  );

  /** New lines from the server: merge by index + fingerprint; returns the lines that start fresh. */
  const applyLines = useCallback(
    (next: FormLine[], nextRev: number | null): number[] => {
      const prev = linesRef.current;
      const prevFp = fingerprints(prev);
      const merged = mergeV3Draft(draftRef.current, prevFp, next);
      const fresh = next.filter((l) => prevFp[l.index] !== lineFingerprint(l)).map((l) => l.index);
      linesRef.current = next;
      setLines(next);
      if (nextRev !== null) {
        revRef.current = nextRev;
        setRev(nextRev);
      }
      commit(merged.draft);
      if (fresh.length) emit('receive_lines_added', { v: 3, new_lines: fresh.length, rev: nextRev, lines: next.length });
      return fresh;
    },
    [commit, emit],
  );

  // ── The 15 s poll (two-page notes, closed elsewhere) ──
  const screenRef = useRef(screen);
  useLayoutEffect(() => {
    screenRef.current = screen;
  });
  const poll = useCallback(async () => {
    if (sending.current || !isFormScreen(screenRef.current)) return;
    const r = await pollFormV3({ formId, exp, sig, rev: revRef.current });
    if (!r || sending.current || !isFormScreen(screenRef.current)) return;
    if (r.status === 'open') {
      // A flag switched off is NOT followed here (an off poll may be a read
      // blip): the open form stays on v3 until a reload decides.
      if (r.rev > revRef.current) applyLines(r.lines, r.rev);
      return;
    }
    if (r.status === 'submitted' || r.status === 'processing') return;
    if (r.status === 'failed') {
      emit('receive_outcome', { v: 3, status: r.status, at: 'poll' });
      return showNotice('failed');
    }
    onNotOpen(r.status, r.closed_reason, r.newer, 'poll');
  }, [applyLines, emit, exp, formId, onNotOpen, showNotice, sig]);

  useEffect(() => {
    if (initialView.kind !== 'form') return;
    let timer: number | null = null;
    const start = () => {
      if (timer === null && document.visibilityState === 'visible') timer = window.setInterval(() => void poll(), V3.FORM_POLL_MS);
    };
    const stop = () => {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void poll();
        start();
      } else stop();
    };
    const onFocus = () => void poll();
    start();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onFocus);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onFocus);
    };
  }, [initialView.kind, poll]);

  // ── Submit (8.1) ──
  /**
   * A save the checks refuse (on the page, or the server's 422): mark the
   * lines it names and go back to the list. Only the pallet count wrong
   * (0 pallets and nothing outside, or out of range) → the pallets sheet,
   * which cannot be confirmed in that state. Approved texts only.
   */
  const refuse = useCallback(
    (pb: V3SaveProblems) => {
      const marks = new Set(pb.lines);
      flaggedRef.current = marks;
      setFlagged(marks);
      setScreen('list');
      setTab('need');
      setQuery('');
      setOpen(null);
      openRef.current = null;
      step('save_refused', { lines: pb.lines.length, pallets: pb.pallets, other: pb.other });
      if (pb.pallets && !pb.lines.length) {
        setError(null);
        setSheet({ kind: 'pallets', snap: { pallets: draftRef.current.pallets, loose: { ...draftRef.current.loose }, looseYes } });
        return;
      }
      setError({ text: tr('receive.errorInvalid'), retry: 'first' });
    },
    [looseYes, step, tr],
  );

  const send = useCallback(async () => {
    if (sending.current) return;
    // The server's own two checks first: a save it would refuse never leaves the page.
    const pre = checkV3BeforeSend(linesRef.current, draftRef.current, today);
    if (!pre.ok) return refuse(pre);
    sending.current = true;
    setError(null);
    setScreen('status');
    flow.start();
    step('status');
    let started = Date.now();
    try {
      started = traceRef.current?.saveAttempt?.({ v: 3, rev: revRef.current, lines: linesRef.current.length }) ?? started;
    } catch {
      /* tracing only */
    }
    const done = (ok: boolean, r: V3SubmitResult) => {
      try {
        traceRef.current?.saveDone?.(started, ok, { v: 3, kind: r.kind, http: r.http, error: r.error });
      } catch {
        /* tracing only */
      }
    };
    const post = () =>
      submitV3({ formId, exp, sig, rev: revRef.current, answers: v3DraftToAnswers(linesRef.current, draftRef.current, today) });

    let r = await post();
    let fresh: number[] = [];
    if (r.kind === 'lines_changed') {
      fresh = applyLines(r.lines, r.rev);
      if (!fresh.length) {
        // Nothing new to fill: send once more on the new revision (as today).
        r = await post();
        if (r.kind === 'lines_changed') fresh = applyLines(r.lines, r.rev);
      }
    }
    sending.current = false;
    done(r.kind === 'saved', r);

    switch (r.kind) {
      case 'saved':
        clearStoredDraft();
        flow.saved();
        return;
      case 'lines_changed': {
        const n = Math.max(1, fresh.length);
        setScreen('list');
        setTab('need');
        setQuery('');
        setOpen(null);
        openRef.current = null;
        setError({ text: n === 1 ? tr('receive.linesChangedOne') : tr('receive.linesChanged', { n: I(n) }), retry: 'first' });
        return;
      }
      case 'not_open':
        return onNotOpen(r.status, r.closed_reason, r.newer, 'submit');
      case 'in_flight':
        return showNotice('beingSaved');
      case 'failed':
        return showNotice('failed');
      case 'link_invalid':
        return showNotice('linkInvalid');
      case 'error': {
        if (r.reason === 'invalid') return refuse(r.problems.ok ? { ...r.problems, other: true, ok: false } : r.problems);
        if (r.reason === 'bot') return setError({ text: tr('receive.v3.errBot'), retry: 'send' });
        if (r.reason === 'network') return setError({ text: tr('receive.v3.errNetwork'), retry: 'send' });
        // The server's own wording is never shown (text freeze): the prototype's generic error.
        return setError({ text: tr('receive.v3.errGeneric'), retry: 'send' });
      }
    }
  }, [applyLines, clearStoredDraft, exp, flow, formId, onNotOpen, refuse, showNotice, sig, step, today, tr]);

  const closeError = useCallback(() => {
    setError(null);
    if (screenRef.current === 'status') setScreen('confirm');
  }, []);

  const retryError = useCallback(() => {
    const e = error;
    if (!e) return;
    if (e.retry === 'send') return void send();
    setError(null);
    setScreen('list');
    goFirstMissing();
  }, [error, goFirstMissing, send]);

  // ── Android back / Escape (6.1) ──
  const palShown = (() => {
    if (open === null || screen !== 'list') return false;
    if (palListOpen) return true;
    const line = lines.find((l) => l.index === open);
    const d = byIndex.get(open);
    return !!line && !!d && shouldAutoOpenPalletList(line, d, draft, today, palClosed);
  })();

  const onBack = useCallback(() => {
    if (viewer) return setViewer(false);
    if (sheet?.kind === 'pkg') return setSheet(null);
    if (sheet?.kind === 'palList') return setSheet(null);
    if (sheet?.kind === 'pallets') return cancelPalletsSheet();
    if (sheet?.kind === 'extra') return setSheet(null);
    if (error) return closeError();
    if (kbOpen) {
      (document.activeElement as HTMLElement | null)?.blur?.();
      return setKbOpen(false);
    }
    if (screen === 'loose') return cancelLoose();
    if (screen === 'list' && open !== null && palShown) {
      setPalListOpen(false);
      return setPalClosed(true);
    }
    if (screen === 'list' && open !== null) return closeCard();
    if (screen === 'confirm') {
      step('back_to_list');
      return setScreen('list');
    }
  }, [viewer, sheet, cancelPalletsSheet, error, closeError, kbOpen, screen, cancelLoose, open, palShown, closeCard, step]);

  const depth =
    (viewer ? 1 : 0) +
    (sheet ? 1 : 0) +
    (error ? 1 : 0) +
    (screen === 'loose' ? 1 : 0) +
    (screen === 'list' && open !== null ? 1 : 0) +
    (palShown ? 1 : 0) +
    (screen === 'confirm' ? 1 : 0);
  useBackStack(depth, onBack, isFormScreen(screen) || error !== null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onBack();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onBack]);

  useEffect(() => {
    if (screen === 'pallets') step('pallets_step');
  }, [screen, step]);

  // ── The open card's API ──
  const openLine = open === null ? undefined : lines.find((l) => l.index === open);
  const openD = open === null ? undefined : byIndex.get(open);
  const api: OpenCardApi | null =
    openLine && openD
      ? (() => {
          const o = openLine.index;
          const line = openLine;
          return {
            kb,
            kbOpen,
            qtyEdit,
            onQtyEdit: (v: boolean) => setQtyEdit(v),
            onCartons: (v: string) => patchLine(o, (x) => setCartonsPatch(line, x, v)),
            onQty: (v: string) => patchLine(o, { qty: v.replace(/[^\d.,]/g, '').slice(0, 12), edited: true }),
            onOpenPackaging: () => {
              setSheet({ kind: 'pkg', index: o });
              step('pkg_picker', { line: o });
            },
            onReset: () => {
              patchLine(o, resetToNotePatch(line));
              setQtyEdit(false);
            },
            onGap: (g: Gap | null) => patchLine(o, { gap: g, edited: true }),
            onGapNote: (v: string) => patchLine(o, { gapNote: v.slice(0, 500) }),
            // As the prototype's gapNoteBlur: a line made complete by its typed reason closes 1.4 s after leaving the field.
            onGapNoteBlur: () => {
              const dx = draftRef.current.lines.find((l) => l.index === o);
              if (dx && lineStatusV3(line, dx, draftRef.current, today) === 'ready') maybeCollapse();
            },
            onDateType: (raw: string, caret: number | null) => {
              const before = draftRef.current.lines.find((l) => l.index === o)?.expiry ?? '';
              const after = typeDate(raw, before, caret);
              patchLine(o, { expiry: after });
              if (dateJustCompleted(before, after, today)) closeKeyboard();
            },
            onDatePick: (dotted: string) => patchLine(o, { expiry: dotted, noExpiry: false }),
            onDateFocus: (e: FocusEvent<HTMLInputElement>) => {
              patchLine(o, (x) => (x.ack ? {} : { ack: true }));
              kb.onFocus(e);
            },
            onDateBlur: () => {
              patchLine(o, (x) => {
                const v = expandDate(x.expiry);
                return v === x.expiry ? {} : { expiry: v };
              });
              kb.onBlur();
            },
            onToggleNoExpiry: () => patchLine(o, (x) => ({ noExpiry: !x.noExpiry })),
            onStartSplit: () => patchLine(o, (x) => startSplitPatch(line, x)),
            onSplitQty: (k: number, v: string) => patchLine(o, (x) => setSplitQtyPatch(line, x, k, v.replace(/[^\d.,]/g, '').slice(0, 12))),
            onSplitType: (k: number, raw: string, caret: number | null) =>
              patchLine(o, (x) => ({ split: (x.split ?? []).map((r, j) => (j === k ? { ...r, date: typeDate(raw, r.date, caret) } : r)) })),
            onSplitBlur: (k: number) => {
              patchLine(o, (x) => {
                const rows = x.split ?? [];
                const v = rows[k] ? expandDate(rows[k].date) : '';
                return !rows[k] || v === rows[k].date ? {} : { split: rows.map((r, j) => (j === k ? { ...r, date: v } : r)) };
              });
              kb.onBlur();
            },
            onSplitRemove: (k: number) => patchLine(o, (x) => removeSplitRowPatch(line, x, k)),
            onSplitAdd: () => patchLine(o, (x) => addSplitRowPatch(line, x, today)),
            palletListOpen: palShown,
            onPalletChange: () => {
              step('pal_list', { line: o });
              if (draftRef.current.pallets >= 2) {
                setPalListOpen(true);
                setPalClosed(false);
                later(() => revealStep3(true));
              } else setSheet({ kind: 'palList', index: o });
            },
            onPalletClose: () => {
              setPalListOpen(false);
              setPalClosed(true);
            },
            onPalletPick: (v: PalletPick) => pickPallet(o, v),
          };
        })()
      : null;

  // ── Render ──
  const shell = (children: ReactNode) => (
    <div className={css.page}>
      <main dir={rtl ? 'rtl' : 'ltr'} lang={rtl ? 'he' : 'en'} className={`${css.root} ${rubik.variable}`} data-v3-screen={screen}>
        {children}
      </main>
    </div>
  );

  const supplierShort = shortSupplierName(header.supplier);
  const headerRow = (
    <HeaderRow
      supplier={supplierShort}
      invoiceNumber={header.invoice_number}
      pallets={draft.pallets}
      tr={tr}
      onNotePhoto={() => {
        setViewer(true);
        step('note_photo');
      }}
      onPallets={() => {
        setSheet({ kind: 'pallets', snap: { pallets: draftRef.current.pallets, loose: { ...draftRef.current.loose }, looseYes } });
        step('pallets_sheet');
      }}
    />
  );

  if (screen === 'notice') {
    return shell(
      <NoticeScreen
        kind={notice}
        redirecting={bot.redirecting}
        redirectKey={bot.redirectKey}
        rtl={rtl}
        tr={tr}
        botHref={botChatHref(boot.botWaNumber)}
        onClose={bot.openBotChat}
        onRefresh={() => window.location.reload()}
        onOpenNewer={() => (newer ? goToNewer(newer) : bot.openBotChat())}
      />,
    );
  }

  let body: ReactNode = null;
  if (screen === 'status') {
    body = (
      <StatusScreen
        supplier={supplierShort}
        invoiceNumber={header.invoice_number}
        erp={boot.erp}
        flow={flow}
        redirecting={bot.redirecting}
        redirectKey={bot.redirectKey}
        rtl={rtl}
        tr={tr}
        botHref={botChatHref(boot.botWaNumber)}
        onClose={bot.openBotChat}
      />
    );
  } else if (screen === 'pallets') {
    body = (
      <StepPallets
        header={header}
        lineCount={lines.length}
        pallets={draft.pallets}
        looseOn={looseOn}
        looseCount={looseCount}
        rtl={rtl}
        tr={tr}
        onPallets={setPallets}
        onToggleLoose={() => toggleLooseCheck('pallets')}
        onEditLoose={() => openLoose('pallets')}
        onContinue={() => {
          if (!(draftRef.current.pallets > 0 || Object.keys(draftRef.current.loose).length > 0)) return;
          commit({ ...draftRef.current, stage: 'list' });
          setOpen(null);
          openRef.current = null;
          setTab('need');
          setScreen('list');
          step('list');
        }}
      />
    );
  } else if (screen === 'loose') {
    const packs: Record<number, { n: number; text: string }> = {};
    for (const l of lines) {
      const d = byIndex.get(l.index);
      const n = d ? packagesOf(d) : 1;
      packs[l.index] = { n, text: pkgText(n, d?.packaging || l.packaging || '', lang) };
    }
    body = (
      <LooseScreen
        lines={lines}
        loose={draft.loose}
        packs={packs}
        query={looseQuery}
        lang={lang}
        rtl={rtl}
        tr={tr}
        onQuery={setLooseQuery}
        onToggle={(index) => {
          const m = { ...draftRef.current.loose };
          if (index in m) delete m[index];
          else m[index] = packs[index]?.n ?? 1;
          setLoose(m, index);
        }}
        onStep={(index, delta) => {
          const m = { ...draftRef.current.loose };
          if (!(index in m)) return;
          m[index] = Math.max(1, Math.min(packs[index]?.n ?? 1, m[index] + delta));
          setLoose(m);
        }}
        onConfirm={confirmLoose}
        onClose={cancelLoose}
      />
    );
  } else if (screen === 'confirm') {
    body = (
      <>
        {headerRow}
        <ConfirmScreen
          lines={lines}
          draft={draft}
          lang={lang}
          tr={tr}
          onGo={goFromConfirm}
          onBack={() => {
            step('back_to_list');
            setScreen('list');
          }}
          onSubmit={() => void send()}
        />
      </>
    );
  } else {
    // The list.
    const headHidden = headCollapsed || kbOpen;
    const shown = search.active
      ? search.lines
      : lines.filter((l) => {
          const ready = statuses.get(l.index) === 'ready';
          return l.index === open || (tab === 'need' ? !ready : ready);
        });
    const doneCount = lines.length - remaining.length;
    body = (
      <>
        {!headHidden && headerRow}
        <SearchRow
          query={query}
          onQuery={onQuery}
          collapsed={headHidden}
          shown={search.active ? search.lines.length : null}
          total={lines.length}
          rtl={rtl}
          tr={tr}
        />
        {!search.active && <TabToggle tab={tab} need={remaining.length} done={doneCount} tr={tr} onTab={onTab} />}
        <div
          ref={listRef}
          data-part="list"
          className={css.scroll}
          onScroll={(e) => {
            const t = e.currentTarget.scrollTop;
            if (t > V3.HEADER_COLLAPSE_AT && !headCollapsed) setHeadCollapsed(true);
            else if (t < V3.HEADER_EXPAND_AT && headCollapsed) setHeadCollapsed(false);
          }}
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            position: 'relative',
            borderTop: `1px solid ${P.line}`,
            background: P.surf,
            padding: '8px 10px 0',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          {shown.map((line) => {
            const d = byIndex.get(line.index);
            if (!d) return null;
            return (
              <LineCard
                key={line.index}
                line={line}
                d={d}
                draft={draft}
                status={statuses.get(line.index) ?? 'expiry'}
                today={today}
                lang={lang}
                tr={tr}
                onToggle={toggleCard}
                api={line.index === open ? api : null}
              />
            );
          })}
          {/* As drawn: the heading and the rows sit straight in the list, no card around them. */}
          {!search.active && tab === 'done' && draft.extras.length > 0 && (
            <>
              <div data-part="extras" style={{ flex: 'none', padding: '16px 16px 4px', font: font(600, 15), color: P.ink }}>
                {tr('receive.v3.extrasTitle')}
              </div>
              {draft.extras.map((x) => (
                <div
                  key={x.key}
                  data-extra=""
                  style={{ minHeight: 60, flex: 'none', padding: '0 16px', borderBottom: `1px solid ${P.line}`, display: 'flex', alignItems: 'center', gap: 10 }}
                >
                  <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                    <span style={{ font: font(500, 17), color: P.ink }}>{x.name}</span>
                    <span style={{ font: font(400, 15), color: P.ink2 }}>{`${I(x.quantity)} ${EXTRA_UNIT_LABELS[x.unit][lang]}`}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      commit({ ...draftRef.current, extras: draftRef.current.extras.filter((e) => e.key !== x.key) });
                      emit('receive_extra', { v: 3, action: 'remove' });
                    }}
                    style={{ ...BARE, ...UNDERLINE, height: 48, padding: '0 4px', font: font(500, 16), flex: 'none', whiteSpace: 'nowrap' }}
                  >
                    {tr('receive.v3.remove')}
                  </button>
                </div>
              ))}
            </>
          )}
          {shown.length === 0 && (
            <div style={{ padding: '20px 16px 4px', flex: 'none' }}>
              {search.active ? (
                <span style={{ font: font(600, 19), color: P.ink }}>{tr('receive.v3.notFound')}</span>
              ) : tab === 'done' ? (
                <span style={{ font: font(500, 17), color: P.ink2 }}>{tr('receive.v3.doneEmpty')}</span>
              ) : null}
            </div>
          )}
          <div style={{ padding: '2px 4px 16px', flex: 'none' }}>
            <button
              type="button"
              onClick={() => {
                setSheet({ kind: 'extra', name: query.trim() });
                step('extra_sheet');
              }}
              style={{ ...BARE, height: 48, display: 'flex', alignItems: 'center', gap: 4, font: font(400, 15), padding: 0 }}
            >
              <V3Icon name="add" size={20} />
              <span style={{ ...UNDERLINE }}>{tr('receive.v3.addExtra')}</span>
            </button>
          </div>
        </div>
        {!kbOpen && (
          <BottomBar
            remaining={remaining.length}
            rtl={rtl}
            tr={tr}
            onNext={() => {
              emit('receive_next', { v: 3, left: remaining.length });
              goFirstMissing();
            }}
            onConfirm={openConfirm}
          />
        )}
      </>
    );
  }

  // ── Layers ──
  const sheetLine = sheet && (sheet.kind === 'pkg' || sheet.kind === 'palList') ? lines.find((l) => l.index === sheet.index) : undefined;
  const sheetD = sheetLine ? byIndex.get(sheetLine.index) : undefined;
  let sheetEl: ReactNode = null;
  if (sheet?.kind === 'pallets') {
    sheetEl = (
      <PalletsSheet
        pallets={draft.pallets}
        looseOn={looseOn}
        looseCount={looseCount}
        tr={tr}
        onPallets={setPallets}
        onToggleLoose={() => toggleLooseCheck('list')}
        onEditLoose={() => openLoose('list')}
        canConfirm={draft.pallets > 0 || looseCount > 0}
        onConfirm={() => {
          if (draftRef.current.pallets > 0 || Object.keys(draftRef.current.loose).length > 0) setSheet(null);
        }}
        onCancel={cancelPalletsSheet}
      />
    );
  } else if (sheet?.kind === 'palList' && sheetLine && sheetD) {
    const v = palletOf(sheetLine, sheetD, draft);
    sheetEl = (
      <PalletListSheet
        pallets={draft.pallets}
        value={v === null || v === 'none' ? null : v}
        tr={tr}
        onPick={(pv) => {
          pickPallet(sheetLine.index, pv);
          setSheet(null);
        }}
        onClose={() => setSheet(null)}
      />
    );
  } else if (sheet?.kind === 'pkg' && sheetLine && sheetD) {
    sheetEl = (
      <PackagingSheet
        notePkg={sheetLine.packaging}
        value={sheetD.packaging}
        lang={lang}
        rtl={rtl}
        tr={tr}
        onPick={(k) => {
          patchLine(sheetLine.index, { packaging: k, edited: true });
          setSheet(null);
          step('pkg_pick', { line: sheetLine.index, packaging: k });
        }}
        onClose={() => setSheet(null)}
      />
    );
  } else if (sheet?.kind === 'extra') {
    sheetEl = (
      <ExtraSheet
        initialName={sheet.name}
        extrasCount={draft.extras.length}
        lang={lang}
        rtl={rtl}
        tr={tr}
        onAdd={(x: { name: string; quantity: string; unit: ExtraUnit }) => {
          const key = `v3x-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
          commit({ ...draftRef.current, extras: [...draftRef.current.extras, { key, ...x }] });
          try {
            traceRef.current?.extraEdit?.(key, x);
          } catch {
            /* tracing only */
          }
          emit('receive_extra', { v: 3, action: 'add', unit: x.unit });
          setSheet(null);
          setQuery('');
          if (openRef.current !== null) closeCard();
          setTab('done');
        }}
        onClose={() => setSheet(null)}
      />
    );
  }

  return shell(
    <>
      {body}
      {sheetEl}
      {error && <ErrorSheet text={error.text} tr={tr} onRetry={retryError} onClose={closeError} />}
      {viewer && (
        <NotePhotoViewer
          photos={boot.notePhotos}
          tr={tr}
          onClose={() => setViewer(false)}
          onPage={(page) => step('note_page', { page })}
        />
      )}
    </>,
  );
}

export default ReceiveFormV3;
