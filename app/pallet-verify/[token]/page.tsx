'use client';

import { use, useCallback, useEffect, useRef, useState } from 'react';
import {
  CheckCircle,
  XCircle,
  Loader2,
  AlertTriangle,
  Scale,
  Boxes,
  Check,
} from 'lucide-react';
import { SmartScanner } from '@/components/scanner/SmartScanner';
import { SwipeConfirm } from '@/components/shared/SwipeConfirm';
import { NonMeatTypeAFlow } from './NonMeatTypeAFlow';
import { MeatManualCountFlow, type PalletCompleteResult } from './MeatManualCountFlow';
import { DebugLogPanel } from '@/components/shared/DebugLogPanel';
import { MI, PalletIcon } from '@/components/terminal/MI';
import { DesignHeader } from '@/components/terminal/DesignHeader';
import { ProgressHeader } from '@/components/terminal/ProgressHeader';
import { BottomSheet, type BottomSheetHandle } from '@/components/terminal/BottomSheet';
import { ToolDock, type ToolChip } from '@/components/terminal/ToolDock';
import { ActiveScanCard } from '@/components/terminal/ActiveScanCard';
import { HistoryRow } from '@/components/terminal/HistoryRow';
import { EditPanel } from '@/components/terminal/EditPanel';
import { DoneOverlay } from '@/components/terminal/DoneOverlay';
import { Toast, useLockToast } from '@/components/terminal/Toast';
import { useDrawerHost } from '@/components/terminal/DrawerHost';
import { PalletsBrowser } from '@/components/terminal/PalletsBrowser';
import SplitJobScreen, { SPLIT_CLAIM_ERROR_KEYS } from '@/components/terminal/SplitJobScreen';
import { installDebugLogCapture } from '@/lib/debug-log';
import { LanguageContext, useLangDir, t } from '@/lib/i18n';
import type { Language, MultiPalletSession, MultiPalletBoxScan, ParsedBarcode } from '@/types';
import { groupKeyForBox, groupBoxesByName } from '@/lib/group-key';
import { matchInvoiceItem } from '@/lib/invoice-match';
import { isSplitSession } from '@/lib/session-mode';
import { findDuplicateOwner } from '@/lib/duplicate-guard';
import { useSettingsStore } from '@/stores/settings-store';
import { scanSuccessFeedback, scanDuplicateFeedback } from '@/lib/scan-feedback';
import {
  savePalletScans,
  loadPalletScans,
  saveLooseScans,
  loadLooseScans,
  clearPalletScans,
  clearLooseScans,
  clearAllScans,
} from '@/lib/pallet-scan-cache';

// Set up the in-page console-log capture once at module load. Idempotent —
// safe even with React Strict Mode mounting twice.
if (typeof window !== 'undefined') {
  installDebugLogCapture();
}

// ── Type detection using OCR-derived weights only ──

type DetectedType = 'unknown' | 'single-uniform' | 'single-nonuniform' | 'mix';

function detectType(
  boxes: BoxScan[],
  mergeMap?: Map<string, string>,
): DetectedType {
  if (boxes.length < 2) return 'unknown';
  // Group by OCR'd Hebrew name (with worker-accepted merges applied),
  // never by barcode digits — barcode is a per-box dedup key only.
  const groups = groupBoxesByName(boxes, mergeMap);
  if (groups.size > 1) return 'mix';
  const weights = boxes.map((b) => b.weight).filter((w) => w > 0);
  if (weights.length < 2) return 'unknown';
  const range = Math.max(...weights) - Math.min(...weights);
  return range < UNIFORM_WEIGHT_TOLERANCE ? 'single-uniform' : 'single-nonuniform';
}

// ── Local box type with OCR state ──

type OcrStatus = 'processing' | 'done' | 'failed';

interface BoxScan extends MultiPalletBoxScan {
  ocr_status: OcrStatus;
  // Captured frame from the moment the barcode was detected. Kept around so
  // the user can retry OCR or view the image when OCR fails (e.g. blurry).
  image_data?: string;
  // How this box entered: 'scan' = 1D barcode decoded; 'manual' = worker tapped
  // "capture anyway" because the barcode wouldn't decode (glare/fold/tear) and
  // the box identity comes from the OCR'd printed digits instead.
  captured_via?: 'scan' | 'manual';
  // Set on a manual box when OCR couldn't read the printed digits either — no
  // dedupe ID is possible, so it's counted but flagged ⚠️ for the worker.
  needs_review?: boolean;
}

// Digits-only normaliser for comparing the full printed barcode number across
// bar-scanned and OCR-captured boxes (NOT the 13-digit SKU, which repeats
// across every box of one product).
function digitsOnly(s: string | null | undefined): string {
  return (s || '').replace(/\D/g, '');
}

// ── Uniform-pair detection state ──
//
// When the same-named boxes all come back with the EXACT same printed weight
// (a fixed-weight product), the warehouse domain rule says ALL boxes of that
// item on this pallet are that weight. Worker scans 4 samples and reports the
// real total count via a prompt instead of scanning every box. Any weight
// difference at all (catch-weight) means each box must be scanned.
//
// Pre-2026-05-15 this was keyed on the barcode-derived `sku` (first 13
// digits). That broke when OCR misread a digit and put physically-identical
// boxes into different SKU buckets. Now keyed on the name-derived group key
// from `groupKeyForBox` (see `lib/group-key.ts`).

interface UniformGroup {
  name_key: string;             // normalized-name group key, NOT a barcode
  item_name: string;
  item_name_hebrew: string;
  avg_weight: number;
  total_count: number;          // user-entered (or declared count for Complete-as-single)
  sample_barcodes: string[];    // the scanned-sample barcodes (2+)
}

// Shape persisted to localStorage so a reload restores in-progress scans.
// `image_data` (base64) is stripped from boxes before saving to stay under the
// localStorage quota — the OCR fields are what matter on restore.
interface PalletScanSnapshot {
  v: 1;
  scannedBoxes: BoxScan[];
  uniformGroups: [string, UniformGroup][];
  acceptedMerges: [string, string][];
  confirmedBoxCount: number;
  boxCountInput: string;
  forcedMix: boolean;
  detectedType: DetectedType;
}
interface LooseScanSnapshot {
  v: 1;
  looseBoxes: BoxScan[];
}
const stripImage = (b: BoxScan): BoxScan => {
  const { image_data: _img, ...rest } = b;
  return rest;
};

// Only ever the single-vs-mix choice now (shown after >=4 OCR'd boxes of one
// product at the same weight). The per-item mandatory_count mode was removed:
// any mix pallet = scan every box.
type UniformPrompt =
  | { mode: 'single_or_mix'; name_key: string; item_name: string; item_name_hebrew: string; avg_weight: number; sample_barcodes: string[] };

// "Same weight" means the printed weights are EXACTLY equal — a fixed-weight
// product stamps the identical kg on every box. Catch-weight boxes that merely
// look close (e.g. 10.090 vs 10.080 — 10 g apart, or even 1 g apart) are
// DIFFERENT and must each be scanned, so there is no grace band. This epsilon
// (0.1 g — below the 1 g label resolution) only absorbs floating-point
// representation noise. Mirrored by UNIFORM_WEIGHT_TOLERANCE_KG in
// app/api/multi-pallet-complete/route.ts.
const UNIFORM_WEIGHT_TOLERANCE = 0.0001;

// ── Page state machine ──

type Phase = 'loading' | 'job' | 'scanning' | 'confirming' | 'pallet_done' | 'loose_scanning' | 'loose_confirming' | 'all_done' | 'error';

export default function PalletVerifyPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);

  // Split jobs only: identifies which worker this scan link belongs to. The
  // bot stamps `?w=<chat_id>` on each worker's own link when the manager
  // splits a delivery. Absent on every single-scanner session — read once,
  // it never changes for the life of this page.
  const workerChatId = typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search).get('w') ?? ''
    : '';

  const [phase, setPhase] = useState<Phase>('loading');
  const [session, setSession] = useState<MultiPalletSession | null>(null);
  const [currentPallet, setCurrentPallet] = useState(1);
  // Damaged-sticker manual-count mode for the CURRENT pallet (meat feature).
  // When true, the scanner is replaced by MeatManualCountFlow so the worker
  // can declare per-item box counts without scanning. Reset on pallet advance.
  const [manualMode, setManualMode] = useState(false);
  const [boxCountInput, setBoxCountInput] = useState('');
  const [confirmedBoxCount, setConfirmedBoxCount] = useState(0);
  const [scannedBoxes, setScannedBoxes] = useState<BoxScan[]>([]);
  const [detectedType, setDetectedType] = useState<DetectedType>('unknown');
  const [lpn, setLpn] = useState('');
  const [lpnUrl, setLpnUrl] = useState('');
  const [error, setError] = useState<string | null>(null);

  const processedRef = useRef<Set<string>>(new Set());
  const [looseBoxes, setLooseBoxes] = useState<BoxScan[]>([]);

  // Hydrate the Sound / Vibration settings from localStorage so scan-feedback
  // honours the worker's toggles (defaults to ON until hydrated).
  const hydrateSettings = useSettingsStore((s) => s.hydrate);
  useEffect(() => {
    hydrateSettings();
  }, [hydrateSettings]);

  // SmartScanner hands us a fn to flash its red "already scanned" indicator.
  // Used when a manually-captured box is rejected as a duplicate after OCR.
  const dupFlashRef = useRef<(() => void) | null>(null);
  const looseDupFlashRef = useRef<(() => void) | null>(null);

  // Language flows from the bot via the session payload. Set the
  // <html dir="rtl"> + lang attribute so Tailwind logical utilities
  // (ms-*, me-*, text-start, text-end) flip automatically for Hebrew
  // workers. The LanguageContext.Provider further down powers useT()
  // for any future translated strings.
  const language: Language = (session?.language as Language) || 'English';
  useLangDir(language);
  const tr = useCallback(
    (key: Parameters<typeof t>[1], vars?: Parameters<typeof t>[2]) => t(language, key, vars),
    [language],
  );
  // The terminal components (ToolDock, drawer, edit panel, toast…) translate
  // via useT(), which reads LanguageContext — every phase return below must
  // be wrapped so Hebrew sessions don't fall back to the English default.
  const withLang = (node: React.ReactElement) => (
    <LanguageContext.Provider value={language}>{node}</LanguageContext.Provider>
  );
  const looseProcessedRef = useRef<Set<string>>(new Set());
  // Modal: full-size view of a captured frame (used after OCR failures so the
  // worker can confirm whether the photo is bad or worth retrying).
  const [viewingImage, setViewingImage] = useState<string | null>(null);
  // Uniform-pair state (per pallet — reset between pallets).
  const [uniformGroups, setUniformGroups] = useState<Map<string, UniformGroup>>(new Map());
  const [pendingUniformPrompt, setPendingUniformPrompt] = useState<UniformPrompt | null>(null);
  // The worker confirmed the pallet is mix ("other products too"), or used the
  // "fewer than 4 boxes" escape. Suppresses the single-vs-mix prompt and lets
  // the pallet-total input appear so they scan-all + enter the total. Per pallet.
  const [forcedMix, setForcedMix] = useState(false);
  const forcedMixRef = useRef(false);
  useEffect(() => { forcedMixRef.current = forcedMix; }, [forcedMix]);
  // Refs mirror the above state for read-during-callback access without stale
  // closure issues (used inside runOcr's success path).
  const uniformGroupsRef = useRef<Map<string, UniformGroup>>(new Map());
  const pendingUniformPromptRef = useRef<UniformPrompt | null>(null);
  useEffect(() => { uniformGroupsRef.current = uniformGroups; }, [uniformGroups]);
  useEffect(() => { pendingUniformPromptRef.current = pendingUniformPrompt; }, [pendingUniformPrompt]);
  // Which scanned-box row is expanded to reveal its Delete action. Two-step
  // (tap row → tap Delete) guards against misclicks. Reset between pallets.
  const [selectedBarcode, setSelectedBarcode] = useState<string | null>(null);
  // Edit-a-scan: the box (by barcode) currently being edited + its in-flight
  // name/weight values. Null when no edit modal is open. Reset between pallets.
  const [editForm, setEditForm] = useState<
    {
      barcode: string;
      name_he: string;
      name_en: string;
      weight: string;
      expiry: string;
      // Captured sticker frame so the modal can show what the OCR actually saw.
      // Worker can't fix the name/weight blind — showing the photo is the whole
      // point of this view. Optional because rescue/legacy boxes might not have one.
      image_data?: string;
      // Source collection: pallet phase (scannedBoxes) vs loose phase (looseBoxes).
      // handleSaveEdit branches on this to update the right state.
      isLoose?: boolean;
    } | null
  >(null);
  // Invoice item catalog for this delivery (mirrored to a ref so runOcr — which
  // is reached via a memoized scan callback — always sees it without stale
  // closures). Used to bias the OCR prompt AND snap OCR'd names to canonical
  // invoice names so OCR drift doesn't fragment one item into several groups.
  const invoiceItemsRef = useRef<MultiPalletSession['ocr_data']>([]);
  useEffect(() => { invoiceItemsRef.current = session?.ocr_data ?? []; }, [session]);
  // Same reasoning, for the split-mode duplicate-box guard (Task 16):
  // handleBarcodeDetected and runOcr's manual-capture branch both need the
  // current session (roster/completed_pallets) and pallet number to call
  // findDuplicateOwner, but both are reached through refs/frozen closures —
  // see the sessionRef.current guards below for why direct `session` /
  // `currentPallet` reads there would be stale.
  const sessionRef = useRef<MultiPalletSession | null>(null);
  useEffect(() => { sessionRef.current = session; }, [session]);
  const currentPalletRef = useRef(1);
  useEffect(() => { currentPalletRef.current = currentPallet; }, [currentPallet]);
  // Deferred-single-confirm state: when the worker picks "Complete as
  // single-item" in the uniform-pair prompt, we capture the group params
  // here and surface the pallet box-count input in the footer. Locking
  // the group + auto-confirm happens on count submit.
  const [pendingSingleGroup, setPendingSingleGroup] = useState<{
    name_key: string;
    item_name: string;
    item_name_hebrew: string;
    avg_weight: number;
    sample_barcodes: string[];
  } | null>(null);
  // AI consolidation state: worker-accepted merges (originalKey → canonicalKey).
  // These get applied wherever we call `groupBoxesByName` and threaded into
  // the webhook so the bot's Pallet Items rows reflect the merged groups.
  const [acceptedMerges, setAcceptedMerges] = useState<Map<string, string>>(new Map());
  // Pair-fingerprints the worker explicitly rejected this session, so the AI
  // banner won't re-prompt the same suggestion repeatedly. Fingerprint =
  // sorted pair of keys joined by `||`.
  const [rejectedMergePairs, setRejectedMergePairs] = useState<Set<string>>(new Set());
  // Latest suggestion from /api/consolidate-items that the worker hasn't yet
  // accepted or rejected. Single banner at a time.
  const [pendingMerge, setPendingMerge] = useState<{
    from_keys: string[];
    to_key: string;
    sample_names: { he?: string; en?: string }[];
    box_counts: number[];
  } | null>(null);
  // Validation error for the deferred pallet box-count input.
  const [palletCountError, setPalletCountError] = useState<string | null>(null);
  // Force-create confirm: when the worker scanned FEWER boxes than they
  // declared (likely a miscount) and taps "Create LPN anyway", this opens a
  // warning modal before the pallet is confirmed with the actual scanned count.
  const [pendingForceConfirm, setPendingForceConfirm] = useState(false);
  // Terminal chrome: bottom-sheet handle, side drawer host, lock/info toast,
  // active-card expand state, and the swipe-gated next-pallet number.
  const sheetRef = useRef<BottomSheetHandle>(null);
  const looseSheetRef = useRef<BottomSheetHandle>(null);
  const drawer = useDrawerHost(token);
  const { toast, showToast, showLockToast } = useLockToast(tr('terminal.lockedToast'));
  const [showPallets, setShowPallets] = useState(false);
  const [activeExpanded, setActiveExpanded] = useState(false);
  const [pendingNextPallet, setPendingNextPallet] = useState<number | null>(null);

  // ── AI consolidation: debounced call after scans settle ──
  //
  // 1.5 s after each change to `scannedBoxes` we fingerprint the current
  // name-groups and call /api/consolidate-items. If Gemini suggests a merge
  // we haven't already rejected, surface it as a banner. Cached by
  // fingerprint so we don't re-call when nothing changed.
  const lastConsolidationFingerprintRef = useRef<string>('');
  useEffect(() => {
    // Only run during scanning phase. Skip while OCR is still in flight.
    if (phase !== 'scanning') return;
    const doneBoxes = scannedBoxes.filter((b) => b.ocr_status === 'done');
    if (doneBoxes.length < 2) return;
    const groupedNow = groupBoxesByName(doneBoxes, acceptedMerges);
    if (groupedNow.size < 2) return; // nothing to merge against itself

    const groups = Array.from(groupedNow.entries()).map(([key, bs]) => ({
      key,
      name_he: bs.find((b) => b.item_name_hebrew)?.item_name_hebrew || '',
      name_en: bs.find((b) => b.item_name)?.item_name || '',
      box_count: bs.length,
      sample_weights_kg: bs.map((b) => b.weight).filter((w) => w > 0).slice(0, 5),
    }));
    // Fingerprint = sorted(key:count) — skip duplicate calls for the same
    // shape of groups (e.g. when scrolling re-renders the page).
    const fingerprint = groups
      .map((g) => `${g.key}#${g.box_count}`)
      .sort()
      .join('|');
    if (fingerprint === lastConsolidationFingerprintRef.current) return;

    const handle = setTimeout(async () => {
      lastConsolidationFingerprintRef.current = fingerprint;
      try {
        const res = await fetch('/api/consolidate-items', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ language, groups }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) return;
        const data = await res.json();
        const suggestions = Array.isArray(data.suggested_merges) ? data.suggested_merges : [];
        // Pick the first suggestion the worker hasn't already rejected. Show
        // one at a time to keep the UX simple.
        for (const m of suggestions) {
          const pairFp = [...m.from_keys].sort().join('||');
          if (rejectedMergePairs.has(pairFp)) continue;
          const sampleNames = m.from_keys.map((k: string) => {
            const bs = groupedNow.get(k) ?? [];
            return {
              he: bs.find((b) => b.item_name_hebrew)?.item_name_hebrew,
              en: bs.find((b) => b.item_name)?.item_name,
            };
          });
          const boxCounts = m.from_keys.map((k: string) => groupedNow.get(k)?.length ?? 0);
          setPendingMerge({
            from_keys: m.from_keys,
            to_key: m.to_key,
            sample_names: sampleNames,
            box_counts: boxCounts,
          });
          return;
        }
        setPendingMerge(null);
      } catch {
        // Swallow — Layer A grouping is the safety net.
      }
    }, 1500);
    return () => clearTimeout(handle);
    // We intentionally don't depend on `acceptedMerges` directly — the
    // fingerprint already reflects it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scannedBoxes, phase, language, acceptedMerges, rejectedMergePairs]);

  // Accept the pending merge: apply each from_key → to_key to acceptedMerges.
  function handleAcceptMerge() {
    if (!pendingMerge) return;
    setAcceptedMerges((prev) => {
      const next = new Map(prev);
      for (const k of pendingMerge.from_keys) {
        if (k !== pendingMerge.to_key) next.set(k, pendingMerge.to_key);
      }
      return next;
    });
    setPendingMerge(null);
  }

  // Reject + suppress this exact pair for the rest of the session.
  function handleRejectMerge() {
    if (!pendingMerge) return;
    const pairFp = [...pendingMerge.from_keys].sort().join('||');
    setRejectedMergePairs((prev) => {
      const next = new Set(prev);
      next.add(pairFp);
      return next;
    });
    setPendingMerge(null);
  }

  // ── Load session ──

  // Persist in-progress scans to localStorage so a reload never loses them.
  // The phase guard makes this naturally safe vs the restore-on-mount below:
  // while phase is 'loading' nothing is written, so the loader restores first
  // and only then (phase → 'scanning') do we start mirroring to storage.
  useEffect(() => {
    if (phase === 'scanning') {
      const snap: PalletScanSnapshot = {
        v: 1,
        scannedBoxes: scannedBoxes.map(stripImage),
        uniformGroups: Array.from(uniformGroups.entries()),
        acceptedMerges: Array.from(acceptedMerges.entries()),
        confirmedBoxCount,
        boxCountInput,
        forcedMix,
        detectedType,
      };
      savePalletScans(token, currentPallet, snap);
    } else if (phase === 'loose_scanning') {
      const snap: LooseScanSnapshot = { v: 1, looseBoxes: looseBoxes.map(stripImage) };
      saveLooseScans(token, snap);
    }
  }, [
    token, currentPallet, phase, scannedBoxes, looseBoxes, uniformGroups,
    acceptedMerges, confirmedBoxCount, boxCountInput, forcedMix, detectedType,
  ]);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(`/api/multi-pallet-session?token=${token}`);
        if (!res.ok) {
          setError(t(undefined, 'palletVerify.sessionExpired'));
          setPhase('error');
          return;
        }
        const data: MultiPalletSession = await res.json();
        if (data.status === 'completed') {
          clearAllScans(token);
          setSession(data);
          setPhase('all_done');
          return;
        }
        setSession(data);

        // Split jobs: no cursor. Resume whatever this worker already holds
        // (a claimed pallet or the claimed loose task), or send them to the
        // job screen to claim something. Everything below this branch is
        // the untouched single-mode path.
        if (isSplitSession(data)) {
          const mine = (data.pallets ?? []).find(
            (p) => p.owner === workerChatId && p.status === 'claimed',
          );
          if (mine) {
            // Resume the slot they already hold. Restored the same way the
            // single-mode path below restores `data.current_pallet` — split
            // sessions never advance that field, so the claimed slot number
            // is the only correct cache key here.
            setCurrentPallet(mine.n);
            const cached = loadPalletScans<PalletScanSnapshot>(token, mine.n);
            if (cached?.scannedBoxes?.length) {
              setScannedBoxes(cached.scannedBoxes);
              setUniformGroups(new Map(cached.uniformGroups || []));
              setAcceptedMerges(new Map(cached.acceptedMerges || []));
              if (cached.confirmedBoxCount > 0) setConfirmedBoxCount(cached.confirmedBoxCount);
              if (cached.boxCountInput) setBoxCountInput(cached.boxCountInput);
              setForcedMix(!!cached.forcedMix);
              if (cached.detectedType) setDetectedType(cached.detectedType);
              cached.scannedBoxes.forEach((b) => b.barcode && processedRef.current.add(b.barcode));
            }
            setPhase('scanning');
          } else if (data.loose?.owner === workerChatId && data.loose?.status === 'claimed') {
            // Resume: this worker already holds the loose-box task (either
            // pinned by the manager at plan time, or claimed before a reload).
            const cachedLoose = loadLooseScans<LooseScanSnapshot>(token);
            if (cachedLoose?.looseBoxes?.length) {
              setLooseBoxes(cachedLoose.looseBoxes);
              cachedLoose.looseBoxes.forEach((b) => b.barcode && looseProcessedRef.current.add(b.barcode));
            }
            setPhase('loose_scanning');
          } else {
            setPhase('job');
          }
          return;
        }

        // All pallets confirmed but loose boxes still pending → restore loose phase
        // (e.g. user refreshed the tab between pallet 2/2 confirm and scanning loose boxes)
        if (data.current_pallet > data.pallet_count && (data.loose_box_count || 0) > 0) {
          const cachedLoose = loadLooseScans<LooseScanSnapshot>(token);
          if (cachedLoose?.looseBoxes?.length) {
            setLooseBoxes(cachedLoose.looseBoxes);
            cachedLoose.looseBoxes.forEach((b) => b.barcode && looseProcessedRef.current.add(b.barcode));
          }
          setPhase('loose_scanning');
          return;
        }

        setCurrentPallet(data.current_pallet);
        // Restore in-progress scans for this pallet from localStorage (survives
        // reload). The server only knows the pallet index + declared count;
        // the individual boxes live only here.
        const cached = loadPalletScans<PalletScanSnapshot>(token, data.current_pallet);
        if (cached?.scannedBoxes?.length) {
          setScannedBoxes(cached.scannedBoxes);
          setUniformGroups(new Map(cached.uniformGroups || []));
          setAcceptedMerges(new Map(cached.acceptedMerges || []));
          if (cached.confirmedBoxCount > 0) setConfirmedBoxCount(cached.confirmedBoxCount);
          if (cached.boxCountInput) setBoxCountInput(cached.boxCountInput);
          setForcedMix(!!cached.forcedMix);
          if (cached.detectedType) setDetectedType(cached.detectedType);
          // Repopulate the dedup set so a re-scan of a restored sticker is caught.
          cached.scannedBoxes.forEach((b) => b.barcode && processedRef.current.add(b.barcode));
        } else if (data.current_box_count && data.current_box_count > 0) {
          // Resumed session — count was set in a previous tab/refresh.
          setConfirmedBoxCount(data.current_box_count);
          setBoxCountInput(String(data.current_box_count));
        }
        // New flow: always start in scanning. The box-count input is
        // surfaced in the footer after 2 OCR-completed scans (or after
        // the user picks "Single-item" in the uniform-pair prompt).
        setPhase('scanning');
      } catch {
        setError(t(undefined, 'palletVerify.failedLoad'));
        setPhase('error');
      }
    }
    load();
    // workerChatId comes from the URL query string and is stable for the
    // life of this page — it deliberately isn't a dependency so this loader
    // still only ever runs once per token, matching every other phase-load
    // effect in this file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // ── Split jobs: on-demand session refresh ──
  //
  // The job screen's `onRefresh` prop, and every split-aware branch below
  // that returns to 'job'. A plain re-GET + setSession — unlike the mount
  // loader above, it never touches phase or per-pallet cache restoration;
  // the caller decides what happens next.
  const reloadSession = useCallback(async () => {
    try {
      const res = await fetch(`/api/multi-pallet-session?token=${token}`);
      if (!res.ok) return;
      const data: MultiPalletSession = await res.json();
      setSession(data);
    } catch {
      // Best-effort — the job screen just keeps showing the last-known state.
    }
  }, [token]);

  // Split jobs only: once this worker holds the claimed loose-box task
  // (either they just tapped "Take loose boxes ×N" on the job screen, or
  // the manager pinned them as its owner at plan time), leave the job
  // screen and start scanning it. SplitJobScreen has no phase-transition
  // callback for loose — only `onClaimed`, which is pallet-numbered — so
  // this effect is what actually makes that button go anywhere once the
  // claim succeeds.
  useEffect(() => {
    if (phase !== 'job' || !session || !isSplitSession(session)) return;
    if (session.loose?.owner === workerChatId && session.loose?.status === 'claimed') {
      const cachedLoose = loadLooseScans<LooseScanSnapshot>(token);
      if (cachedLoose?.looseBoxes?.length) {
        setLooseBoxes(cachedLoose.looseBoxes);
        cachedLoose.looseBoxes.forEach((b) => b.barcode && looseProcessedRef.current.add(b.barcode));
      }
      setPhase('loose_scanning');
    }
  }, [phase, session, workerChatId, token]);

  // ── Barcode detected — SmartScanner passes the captured frame as imageData ──
  // The barcode IS on the sticker, so that frame is the sticker. Auto-OCR it.

  const handleBarcodeDetected = useCallback(
    (_barcode: string, _parsed: ParsedBarcode, imageData?: string) => {
      const barcode = _barcode.trim();
      if (processedRef.current.has(barcode)) {
        scanDuplicateFeedback(); // already scanned this sticker
        return;
      }

      // Split-mode duplicate-box guard (Task 16): refuse a box already
      // registered on a teammate's (different) pallet on this delivery.
      // Runs BEFORE processedRef.current.add()/scanSuccessFeedback() below —
      // a clash must never be marked "processed" in this page's local
      // dedupe set, or a rescan after the clash is resolved (e.g. the
      // manager reassigns that pallet) would silently hit the "already
      // scanned" branch above instead of re-running this guard, leaving the
      // worker stuck with a generic duplicate buzz and no way to add the
      // box. findDuplicateOwner itself no-ops for single-scanner / non-meat
      // sessions, so this is a no-op cost for the unaffected common case.
      const activeSession = sessionRef.current;
      if (activeSession) {
        const clash = findDuplicateOwner(activeSession, barcode, currentPalletRef.current);
        if (clash) {
          const lang = activeSession.language || 'English';
          const who = (activeSession.roster ?? []).find((r) => r.chat_id === clash.owner)?.nickname
            || t(lang, 'split.anotherWorker');
          dupFlashRef.current?.(); // red "already scanned" flash — same cue as every other rejected scan
          scanDuplicateFeedback();
          setError(t(lang, 'split.duplicateBox', { who, pallet: clash.pallet_n }));
          return; // the box is NOT added, NOT marked processed
        }
      }

      processedRef.current.add(barcode);
      scanSuccessFeedback(); // good scan — box added below
      setError(null); // clear any earlier rejection banner now that a scan succeeded

      // Barcode is an identifier only — extract first 13 digits as dedup key
      const digits = barcode.replace(/\D/g, '');
      const sku = digits.length >= 13 ? digits.slice(0, 13) : digits || barcode;

      const box: BoxScan = {
        barcode,
        sku,
        item_name: '',
        item_name_hebrew: '',
        weight: 0,
        expiry: '',
        scanned_at: new Date().toISOString(),
        ocr_status: 'processing',
        image_data: imageData,
      };

      setScannedBoxes((prev) => [...prev, box]);

      // Fire OCR with the frame captured at detection time
      if (imageData) {
        const capturedIndex = processedRef.current.size - 1; // index of this box
        runOcr(barcode, imageData, capturedIndex);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  // ── Manual capture — barcode wouldn't decode (glare/fold/tear) ──
  // No decoded barcode here, so we register a provisional box and let OCR
  // resolve its real identity (the printed digit string) + dedupe afterwards.

  const handleManualCapture = useCallback((imageData: string) => {
    const provisional = `MANUAL-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const box: BoxScan = {
      barcode: provisional,
      sku: provisional,
      item_name: '',
      item_name_hebrew: '',
      weight: 0,
      expiry: '',
      scanned_at: new Date().toISOString(),
      ocr_status: 'processing',
      image_data: imageData,
      captured_via: 'manual',
    };
    setScannedBoxes((prev) => [...prev, box]);
    runOcr(provisional, imageData, 0, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Retry / Rescan helpers (pallet phase) ──

  function retryPalletOcr(barcode: string) {
    setScannedBoxes((prev) => {
      const target = prev.find((b) => b.barcode === barcode);
      if (!target?.image_data) return prev;
      // Schedule the OCR call after this state update commits. Preserve the
      // manual flag so a retried manual-capture box still resolves its digits.
      const img = target.image_data;
      const manual = target.captured_via === 'manual';
      setTimeout(() => runOcr(barcode, img, 0, manual), 0);
      return prev.map((b) =>
        b.barcode === barcode ? { ...b, ocr_status: 'processing' as OcrStatus } : b
      );
    });
  }

  function rescanPalletBox(barcode: string) {
    setScannedBoxes((prev) => {
      const target = prev.find((b) => b.barcode === barcode);
      const filtered = prev.filter((b) => b.barcode !== barcode);
      setDetectedType(detectType(filtered, acceptedMerges));

      // If the rescanned box belonged to a locked uniform group and the group
      // would be left with fewer than 2 same-weight samples, drop the group
      // (worker can re-scan and re-prompt). Keyed on name, not on the
      // barcode-derived sku.
      if (target) {
        const targetKey = acceptedMerges.get(groupKeyForBox(target)) ?? groupKeyForBox(target);
        setUniformGroups((groups) => {
          const g = groups.get(targetKey);
          if (!g) return groups;
          const remainingSamples = filtered.filter((b) => {
            const k = acceptedMerges.get(groupKeyForBox(b)) ?? groupKeyForBox(b);
            return k === targetKey && b.ocr_status === 'done';
          });
          if (remainingSamples.length < 2) {
            const next = new Map(groups);
            next.delete(targetKey);
            return next;
          }
          return groups;
        });
        // Also clear a pending prompt that's about this same item.
        setPendingUniformPrompt((p) => (p && p.name_key === targetKey ? null : p));
      }

      return filtered;
    });
    processedRef.current.delete(barcode);
  }

  // ── OCR helper ──

  function runOcr(lookupKey: string, imageData: string, capturedIndex: number, manual = false) {
    // Pass the invoice catalog so the bot's OCR prompt picks a known canonical
    // Hebrew name (closed set) instead of free-form reading.
    const candidates = invoiceItemsRef.current.map((it) => ({
      name_hebrew: it.item_name_hebrew,
      name_english: it.item_name_english,
      code: it.item_code,
    }));
    fetch('/api/multi-pallet-ocr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: imageData, barcode: manual ? '' : lookupKey, candidates }),
    })
      .then((r) => r.json())
      .then((data) => {
        setScannedBoxes((prev) => {
          // find the box by its (provisional, for manual) barcode key
          const idx = prev.findIndex((b) => b.barcode === lookupKey);
          if (idx === -1) return prev;

          if (!(data.success && data.ocr_data)) {
            return prev.map((b, i) => (i === idx ? { ...b, ocr_status: 'failed' as OcrStatus } : b));
          }

          const rawHe = data.ocr_data.product_name_hebrew || '';
          const rawEn = data.ocr_data.product_name_english || '';
          // Snap the OCR'd name to the closest invoice item so drift
          // ("כדורי עוף" vs "כדורי עוף-ת. הזנה") groups as one canonical
          // item. No confident match (e.g. loose/unlisted box) → keep raw.
          const match = matchInvoiceItem(rawHe, rawEn, invoiceItemsRef.current);

          // Manual capture: there was no decoded barcode, so resolve this box's
          // dedupe identity from the OCR'd printed digit string.
          let resolvedBarcode = prev[idx].barcode;
          let resolvedSku = prev[idx].sku;
          let needsReview = false;
          if (manual) {
            const digits = digitsOnly(data.ocr_data.barcode_digits);
            if (digits.length >= 13) {
              // Dedupe against every OTHER box (bar-scanned or manual) by the
              // FULL printed number — not the SKU, which repeats per product.
              const dup = prev.some((b, i) => i !== idx && digitsOnly(b.barcode) === digits);
              if (dup) {
                dupFlashRef.current?.(); // red "already scanned" flash
                scanDuplicateFeedback();
                return prev.filter((_, i) => i !== idx); // drop the provisional box
              }
              // Split-mode duplicate-box guard (Task 16): the manual-capture
              // path never has a decoded barcode at accept time — the box was
              // pushed with a provisional placeholder ID — so this OCR-resolved
              // digit string is the FIRST point its real identity is known.
              // This is where a teammate's already-registered box must be
              // caught for this path; findDuplicateOwner no-ops for
              // single-scanner / non-meat sessions.
              const activeSession = sessionRef.current;
              if (activeSession) {
                const clash = findDuplicateOwner(activeSession, digits, currentPalletRef.current);
                if (clash) {
                  const lang = activeSession.language || 'English';
                  const who = (activeSession.roster ?? []).find((r) => r.chat_id === clash.owner)?.nickname
                    || t(lang, 'split.anotherWorker');
                  dupFlashRef.current?.();
                  scanDuplicateFeedback();
                  setError(t(lang, 'split.duplicateBox', { who, pallet: clash.pallet_n }));
                  return prev.filter((_, i) => i !== idx); // drop the provisional box
                }
              }
              resolvedBarcode = digits;
              resolvedSku = digits.slice(0, 13);
              processedRef.current.add(digits); // so a later bar-scan of this sticker is caught
              setError(null); // clear any earlier rejection banner now that this box committed
            } else {
              needsReview = true; // OCR couldn't read the digits → can't dedupe
            }
          }
          // Even when OCR "succeeded", flag the box if the model didn't return
          // a usable name OR a positive weight. These rows would otherwise ship
          // to Airtable as blanks; the worker must open the edit modal, see
          // the captured sticker, and fix them before advancing.
          const heName = (data.ocr_data.product_name_hebrew || '').trim();
          const enName = (data.ocr_data.product_name_english || '').trim();
          const ocrWeight = data.ocr_data.weight_kg ?? 0;
          if ((!heName && !enName) || !(ocrWeight > 0)) {
            needsReview = true;
          }

          const updated = prev.map((b, i) => {
            if (i !== idx) return b;
            return {
              ...b,
              barcode: resolvedBarcode,
              sku: resolvedSku,
              ocr_status: 'done' as OcrStatus,
              item_name: match?.item_name_english || rawEn,
              item_name_hebrew: match?.item_name_hebrew || rawHe,
              weight: data.ocr_data.weight_kg ?? 0,
              expiry: data.ocr_data.expiry_date || '',
              needs_review: needsReview || undefined,
            };
          });
          setDetectedType(detectType(updated, acceptedMerges));
          // Check if the box that just finished OCR triggers a uniform-pair prompt.
          maybeTriggerUniformPrompt(updated, resolvedBarcode);
          return updated;
        });
      })
      .catch(() => {
        setScannedBoxes((prev) => {
          const idx = prev.findIndex((b) => b.barcode === lookupKey);
          if (idx === -1) return prev;
          return prev.map((b, i) => (i === idx ? { ...b, ocr_status: 'failed' } : b));
        });
      });
  }

  // Classify the pallet once >=4 boxes have finished OCR (and none are still
  // processing). Only the single-uniform case (one product, all same weight)
  // raises the single-vs-mix choice. Variable-weight or multi-product pallets
  // raise NO prompt — they fall through to the pallet-total input (mix path).
  function maybeTriggerUniformPrompt(latestBoxes: BoxScan[], _justFinishedBarcode: string) {
    if (pendingUniformPromptRef.current) return;     // already prompting
    if (forcedMixRef.current) return;                // worker already said it's mix
    if (uniformGroupsRef.current.size > 0) return;   // single already locked in
    const done = latestBoxes.filter(
      (b) => b.ocr_status === 'done' && b.weight > 0 && (b.item_name || b.item_name_hebrew),
    );
    const anyProcessing = latestBoxes.some((b) => b.ocr_status === 'processing');
    if (anyProcessing || done.length < 4) return;    // wait for >=4 OCR'd boxes
    const keyOf = (b: BoxScan) => acceptedMerges.get(groupKeyForBox(b)) ?? groupKeyForBox(b);
    const distinct = new Set(done.map(keyOf));
    if (distinct.size !== 1) return;                 // multiple products -> mix path
    const ws = done.map((b) => b.weight);
    if (Math.max(...ws) - Math.min(...ws) >= UNIFORM_WEIGHT_TOLERANCE) return; // varies -> mix
    const sample = done[0];
    const avg = ws.reduce((a, b) => a + b, 0) / ws.length;
    setPendingUniformPrompt({
      mode: 'single_or_mix',
      name_key: keyOf(sample),
      item_name: sample.item_name || '',
      item_name_hebrew: sample.item_name_hebrew || '',
      avg_weight: Math.round(avg * 1000) / 1000,
      sample_barcodes: done.map((b) => b.barcode),
    });
  }

  // ── Loose box barcode detected ──

  const handleLooseBarcodeDetected = useCallback(
    (_barcode: string, _parsed: ParsedBarcode, imageData?: string) => {
      const barcode = _barcode.trim();
      if (looseProcessedRef.current.has(barcode)) {
        scanDuplicateFeedback(); // already scanned this loose box
        return;
      }
      looseProcessedRef.current.add(barcode);
      scanSuccessFeedback(); // good scan — box added below
      const digits = barcode.replace(/\D/g, '');
      const sku = digits.length >= 13 ? digits.slice(0, 13) : digits || barcode;
      const box: BoxScan = {
        barcode, sku, item_name: '', item_name_hebrew: '',
        weight: 0, expiry: '', scanned_at: new Date().toISOString(),
        ocr_status: 'processing',
        image_data: imageData,
      };
      setLooseBoxes((prev) => [...prev, box]);
      if (imageData) runLooseOcr(barcode, imageData);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  // Manual capture for the loose phase — same fallback as the pallet phase.
  const handleLooseManualCapture = useCallback((imageData: string) => {
    const provisional = `MANUAL-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const box: BoxScan = {
      barcode: provisional, sku: provisional, item_name: '', item_name_hebrew: '',
      weight: 0, expiry: '', scanned_at: new Date().toISOString(),
      ocr_status: 'processing', image_data: imageData, captured_via: 'manual',
    };
    setLooseBoxes((prev) => [...prev, box]);
    runLooseOcr(provisional, imageData, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Retry / Rescan helpers (loose phase) ──

  function retryLooseOcr(barcode: string) {
    setLooseBoxes((prev) => {
      const target = prev.find((b) => b.barcode === barcode);
      if (!target?.image_data) return prev;
      const img = target.image_data;
      const manual = target.captured_via === 'manual';
      setTimeout(() => runLooseOcr(barcode, img, manual), 0);
      return prev.map((b) =>
        b.barcode === barcode ? { ...b, ocr_status: 'processing' as OcrStatus } : b
      );
    });
  }

  function rescanLooseBox(barcode: string) {
    setLooseBoxes((prev) => prev.filter((b) => b.barcode !== barcode));
    looseProcessedRef.current.delete(barcode);
  }

  // ── Uniform-prompt action handlers ──

  // "Complete as single-item" path: capture the group and surface the
  // pallet box-count input in the footer. Locking + auto-confirm happens
  // on count submit (handlePalletCountSubmit). Box count is unknown at
  // this moment in the new deferred-count flow.
  function handleCompleteAsSingle() {
    const p = pendingUniformPrompt;
    if (!p || p.mode !== 'single_or_mix') return;
    setPendingSingleGroup({
      name_key: p.name_key,
      item_name: p.item_name,
      item_name_hebrew: p.item_name_hebrew,
      avg_weight: p.avg_weight,
      sample_barcodes: p.sample_barcodes,
    });
    setPendingUniformPrompt(null);
    setBoxCountInput('');
    setPalletCountError(null);
  }

  // Worker backed out of "Single-item" choice → drop the captured group
  // and let the regular footer count input show (mix path).
  function handleCancelSingleConfirm() {
    setPendingSingleGroup(null);
    setBoxCountInput('');
    setPalletCountError(null);
  }

  function handleContinueAsMix() {
    setForcedMix(true);            // pallet is mix → show pallet-total input, scan all
    setPendingUniformPrompt(null);
  }

  // ── Edit a scan (name + weight) ──

  // Open the edit modal pre-filled from the box's current values. `isLoose`
  // tells handleSaveEdit which collection (scannedBoxes vs looseBoxes) the
  // box lives in — the modal itself is shared between both phases.
  function openEdit(box: BoxScan, isLoose = false) {
    setSelectedBarcode(null);
    setEditForm({
      barcode: box.barcode,
      name_he: box.item_name_hebrew || '',
      name_en: box.item_name || '',
      weight: box.weight > 0 ? String(box.weight) : '',
      expiry: box.expiry || '',
      image_data: box.image_data,
      isLoose,
    });
    // The design edit panel lives inside the bottom sheet — grow it so the
    // whole panel (field boxes + keypad) is visible.
    (isLoose ? looseSheetRef : sheetRef).current?.snapTo(2);
  }

  // Apply the edit: update the box, then re-group exactly like rescanPalletBox —
  // changing the name moves the box's group key, so recompute detectedType and
  // drop any uniform group / pending prompt that no longer has ≥2 done samples.
  // Loose-phase edits skip the regrouping (loose has no uniform groups) and
  // just patch the looseBoxes row.
  function handleSaveEdit() {
    if (!editForm) return;
    const { barcode, name_he, name_en, isLoose } = editForm;
    const expiry = editForm.expiry.trim();
    const w = parseFloat(editForm.weight);

    // Same patch shape for both collections. Crucially: clear needs_review
    // when the worker's edit gives us BOTH a non-empty name AND a positive
    // weight — otherwise leave the flag as-is so the gate still holds.
    function patch(b: BoxScan): BoxScan {
      if (b.barcode !== barcode) return b;
      const newWeight = Number.isFinite(w) && w > 0 ? w : b.weight;
      const hasName = !!(name_he.trim() || name_en.trim());
      const hasWeight = newWeight > 0;
      return {
        ...b,
        ocr_status: 'done' as OcrStatus,
        item_name: name_en,
        item_name_hebrew: name_he,
        weight: newWeight,
        expiry,
        needs_review: hasName && hasWeight ? undefined : b.needs_review,
      };
    }

    if (isLoose) {
      setLooseBoxes((prev) => prev.map(patch));
      setEditForm(null);
      return;
    }

    setScannedBoxes((prev) => {
      const updated = prev.map(patch);
      setDetectedType(detectType(updated, acceptedMerges));
      // Drop locked uniform groups left with <2 samples after the name change.
      setUniformGroups((groups) => {
        const next = new Map(groups);
        for (const key of groups.keys()) {
          const samples = updated.filter((b) => {
            const k = acceptedMerges.get(groupKeyForBox(b)) ?? groupKeyForBox(b);
            return k === key && b.ocr_status === 'done';
          });
          if (samples.length < 2) next.delete(key);
        }
        return next;
      });
      // Clear a pending prompt whose item no longer has ≥2 done samples.
      setPendingUniformPrompt((p) => {
        if (!p) return p;
        const samples = updated.filter((b) => {
          const k = acceptedMerges.get(groupKeyForBox(b)) ?? groupKeyForBox(b);
          return k === p.name_key && b.ocr_status === 'done';
        });
        return samples.length >= 2 ? p : null;
      });
      return updated;
    });
    setEditForm(null);
  }

  // ── Derived: committed count for progress + canConfirm ──
  function committedCount(): number {
    let nonUniformIndividuals = 0;
    for (const box of scannedBoxes) {
      const k = acceptedMerges.get(groupKeyForBox(box)) ?? groupKeyForBox(box);
      if (!uniformGroups.has(k)) nonUniformIndividuals += 1;
    }
    let lockedTotal = 0;
    for (const g of uniformGroups.values()) lockedTotal += g.total_count;
    return nonUniformIndividuals + lockedTotal;
  }

  // Share the current scan list as text (WhatsApp share sheet on Android;
  // clipboard fallback) — the dock's real שיתוף action.
  async function handleShareSummary() {
    const src = phase === 'loose_scanning' || phase === 'loose_confirming' ? looseBoxes : scannedBoxes;
    const lines: string[] = [
      tr('palletVerify.docPrefix', { doc: session?.document_number || '—' }),
    ];
    src.forEach((b, i) => {
      const nm = b.item_name_hebrew || b.item_name || '—';
      lines.push(
        `${i + 1}. ${nm}${b.weight > 0 ? ` · ${b.weight.toFixed(3)} kg` : ''}${b.barcode ? ` · ${b.barcode}` : ''}`,
      );
    });
    const text = lines.join('\n');
    try {
      if (navigator.share) {
        await navigator.share({ text });
        return;
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      // fall through to clipboard
    }
    try {
      await navigator.clipboard.writeText(text);
      showToast(tr('terminal.shareCopied'));
    } catch {
      /* nothing else to fall back to */
    }
  }

  // Terminal tool dock: locked chips (no backend) + the real actions.
  function buildDockChips(opts: { gap: () => void }): ToolChip[] {
    return [
      { id: 'create', icon: 'add', label: tr('terminal.toolCreateCarton'), tint: 'blue', iconColor: '#33b1f0', locked: true },
      { id: 'labels', icon: 'label', label: tr('terminal.toolLabels'), tint: 'neutral', locked: true },
      { id: 'warehouses', icon: 'warehouse', label: tr('terminal.toolWarehouses'), tint: 'neutral', locked: true },
      { id: 'pallets', icon: <PalletIcon />, label: tr('terminal.toolPallets'), tint: 'neutral', onPress: () => setShowPallets(true) },
      {
        id: 'delete', icon: 'delete_sweep', label: tr('terminal.toolDelete'), tint: 'red',
        onPress: () => showToast(tr('terminal.deleteHint'), 'delete_sweep', '#ef8a8a'),
      },
      { id: 'share', icon: 'ios_share', label: tr('terminal.toolShare'), tint: 'blue', onPress: handleShareSummary },
      { id: 'assign', icon: 'send', flip: true, label: tr('terminal.toolAssign'), tint: 'green', locked: true },
      {
        id: 'gap', icon: 'report_problem', label: tr('terminal.toolGap'), tint: 'amber', iconColor: '#fbbf5c',
        onPress: opts.gap,
      },
    ];
  }

  // Always-visible bug-report widget. Tap the floating 🐛 button to see
  // captured console logs and copy them out — no Chrome DevTools needed.
  const debugPanel = <DebugLogPanel />;

  // משטחים pallets browser overlay (opened from the tool dock).
  const palletsBrowser = showPallets ? (
    <PalletsBrowser token={token} onBack={() => setShowPallets(false)} />
  ) : null;

  // Full-screen captured-image viewer (used for OCR-failed Diagnostics).
  // fixed/inset-0 means it overlays whatever phase is currently rendering.
  const imageModal = viewingImage ? (
    <div
      onClick={() => setViewingImage(null)}
      className="fixed inset-0 z-[60] bg-black/90 flex items-center justify-center p-4"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={viewingImage}
        alt="Captured frame from barcode detection"
        className="max-w-full max-h-full rounded-lg shadow-xl"
        onClick={(e) => e.stopPropagation()}
      />
      <button
        onClick={() => setViewingImage(null)}
        className="absolute top-4 right-4 bg-raised text-ink px-4 py-2 rounded-lg font-semibold text-sm shadow-lg"
      >
        {tr('palletVerify.closeButton')}
      </button>
      <p className="absolute bottom-4 left-1/2 -translate-x-1/2 text-ink-inverse text-xs opacity-70 whitespace-nowrap">
        {tr('pallet.tapOutsideToClose')}
      </p>
    </div>
  ) : null;

  // Edit-a-scan: the terminal design's in-sheet edit panel (field boxes +
  // numeric keypad + calendar). Rendered INSIDE the bottom sheet in place of
  // the active card + history while editForm is set. Same editForm state and
  // handleSaveEdit wiring as the old full-screen modal.
  const editPanelNode = editForm ? (
    <EditPanel
      cartonNumber={(() => {
        const list = editForm.isLoose ? looseBoxes : scannedBoxes;
        const i = list.findIndex((b) => b.barcode === editForm.barcode);
        return i >= 0 ? i + 1 : '—';
      })()}
      name={editForm.name_he}
      weight={editForm.weight}
      expiry={editForm.expiry}
      barcode={editForm.barcode}
      itemChips={(session?.ocr_data ?? [])
        .filter((it) => it.item_name_hebrew || it.item_name_english)
        .map((it) => ({
          label: it.item_name_hebrew || it.item_name_english,
          active: editForm.name_he === it.item_name_hebrew && !!it.item_name_hebrew,
          onPick: () =>
            setEditForm({ ...editForm, name_he: it.item_name_hebrew, name_en: it.item_name_english }),
        }))}
      imageData={editForm.image_data}
      onViewImage={editForm.image_data ? () => setViewingImage(editForm.image_data!) : undefined}
      onNameChange={(v) => setEditForm({ ...editForm, name_he: v })}
      onWeightChange={(v) => setEditForm({ ...editForm, weight: v })}
      onExpiryChange={(v) => setEditForm({ ...editForm, expiry: v })}
      onSave={handleSaveEdit}
      onCancel={() => setEditForm(null)}
    />
  ) : null;

  function runLooseOcr(lookupKey: string, imageData: string, manual = false) {
    fetch('/api/multi-pallet-ocr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: imageData, barcode: manual ? '' : lookupKey }),
    })
      .then((r) => r.json())
      .then((data) => {
        setLooseBoxes((prev) => {
          const idx = prev.findIndex((b) => b.barcode === lookupKey);
          if (idx === -1) return prev;

          if (!(data.success && data.ocr_data)) {
            return prev.map((b, i) => (i === idx ? { ...b, ocr_status: 'failed' as OcrStatus } : b));
          }

          let resolvedBarcode = prev[idx].barcode;
          let resolvedSku = prev[idx].sku;
          let needsReview = false;
          if (manual) {
            const digits = digitsOnly(data.ocr_data.barcode_digits);
            if (digits.length >= 13) {
              const dup = prev.some((b, i) => i !== idx && digitsOnly(b.barcode) === digits);
              if (dup) {
                looseDupFlashRef.current?.();
                scanDuplicateFeedback();
                return prev.filter((_, i) => i !== idx);
              }
              resolvedBarcode = digits;
              resolvedSku = digits.slice(0, 13);
              looseProcessedRef.current.add(digits);
            } else {
              needsReview = true;
            }
          }
          // Same widened gate as the pallet phase: a successful OCR with no
          // name OR a non-positive weight is still bad data and must be
          // resolved before the worker can finish the loose phase.
          const heName = (data.ocr_data.product_name_hebrew || '').trim();
          const enName = (data.ocr_data.product_name_english || '').trim();
          const ocrWeight = data.ocr_data.weight_kg ?? 0;
          if ((!heName && !enName) || !(ocrWeight > 0)) {
            needsReview = true;
          }

          return prev.map((b, i) => {
            if (i !== idx) return b;
            return {
              ...b,
              barcode: resolvedBarcode,
              sku: resolvedSku,
              ocr_status: 'done' as OcrStatus,
              item_name: data.ocr_data.product_name_english || '',
              item_name_hebrew: data.ocr_data.product_name_hebrew || '',
              weight: data.ocr_data.weight_kg ?? 0,
              expiry: data.ocr_data.expiry_date || '',
              needs_review: needsReview || undefined,
            };
          });
        });
      })
      .catch(() => {
        setLooseBoxes((prev) => {
          const idx = prev.findIndex((b) => b.barcode === lookupKey);
          if (idx === -1) return prev;
          return prev.map((b, i) => (i === idx ? { ...b, ocr_status: 'failed' } : b));
        });
      });
  }

  // ── Confirm loose boxes ──

  async function handleConfirmLooseBoxes() {
    setPhase('loose_confirming');
    setError(null);
    try {
      const res = await fetch('/api/multi-pallet-loose-complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          scanned_boxes: looseBoxes.map(({ ocr_status: _, ...box }) => box),
          // Split jobs only: which worker is closing the loose-box task.
          // Ignored server-side on a single-scanner session. Task 7's
          // ownership guard 403s a split submit without this (not_your_loose_task).
          worker_chat_id: workerChatId,
        }),
      });
      const data = await res.json();
      if (!data.success) {
        // loose_not_claimed / not_your_loose_task arrive as raw reason codes
        // (split-only, added by Task 7's guard) — everything else the server
        // already translated. A raw code must never reach the worker.
        const known = data.error ? SPLIT_CLAIM_ERROR_KEYS[data.error] : undefined;
        setError(known ? tr(known) : (data.error || tr('palletVerify.failedLooseComplete')));
        setPhase('loose_scanning');
        return;
      }
      if (session && isSplitSession(session)) {
        // Split jobs: the loose task may not be the final piece of the
        // delivery — another worker could still be mid-pallet. Return to the
        // job screen instead of assuming the whole thing is done.
        //
        // The reload MUST land before phase flips to 'job'. The watcher
        // effect above (~line 571) drives 'job' → 'loose_scanning' off
        // session.loose.status === 'claimed'; if we set phase='job' first
        // and let reloadSession() run in the background, React commits a
        // render with phase='job' + the STALE session (loose still
        // 'claimed') — that stale value matches the watcher's condition, so
        // it immediately bounces the worker back into loose_scanning with
        // whatever was still in localStorage, right after they just
        // submitted it. Awaiting first means the session we render 'job'
        // against already has loose.status === 'done', so the watcher never
        // fires. Also clear the loose cache + dedup set (mirroring what the
        // single-scanner branch does via clearAllScans below) so even a
        // legitimate future loose-scanning entry never replays boxes that
        // were already submitted.
        setLooseBoxes([]);
        looseProcessedRef.current.clear();
        clearLooseScans(token);
        await reloadSession();
        setPhase('job');
        return;
      }
      clearAllScans(token);
      setPhase('all_done');
    } catch {
      setError(tr('palletVerify.networkError'));
      setPhase('loose_scanning');
    }
  }

  // ── Pallet box-count submitted (deferred footer input) ──
  //
  // Two paths converge here:
  //   1. pendingSingleGroup set → worker picked "Complete as single-item"
  //      earlier; lock the group at total_count = N and auto-confirm.
  //   2. pendingSingleGroup null → mix/non-uniform path; just persist
  //      the count to Redis and let the worker keep scanning.

  function handlePalletCountSubmit() {
    const count = parseInt(boxCountInput, 10);
    if (isNaN(count) || count < 1) {
      setPalletCountError(tr('palletVerify.invalidBoxNumber'));
      return;
    }
    // The total can't be smaller than what's already on the pallet.
    const minRequired = Math.max(2, scannedBoxes.length);
    if (count < minRequired) {
      setPalletCountError(tr('palletVerify.deferredCountTooLow', { min: minRequired }));
      return;
    }
    setPalletCountError(null);
    setConfirmedBoxCount(count);

    if (pendingSingleGroup) {
      // Single-item path: lock the group at total_count = count, then
      // auto-confirm on next tick once React commits the state.
      const group: UniformGroup = {
        name_key: pendingSingleGroup.name_key,
        item_name: pendingSingleGroup.item_name,
        item_name_hebrew: pendingSingleGroup.item_name_hebrew,
        avg_weight: pendingSingleGroup.avg_weight,
        total_count: count,
        sample_barcodes: pendingSingleGroup.sample_barcodes,
      };
      setUniformGroups((prev) => {
        const next = new Map(prev);
        next.set(group.name_key, group);
        return next;
      });
      setPendingSingleGroup(null);
      setTimeout(() => handleConfirmPallet(), 0);
    } else {
      // Mix / non-uniform path: persist the count for resume safety.
      fetch('/api/multi-pallet-session', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, current_box_count: count }),
      }).catch(() => {});
    }
  }

  // ── Confirm pallet ──

  // Shared post-success advance: mirror what the API persisted, then either
  // finish (all_done / loose phase) or roll to the next pallet after a 4s
  // confirmation pause. Used by BOTH the normal confirm and the damaged-sticker
  // manual-count flow so the two paths stay in lockstep.
  function applyCompletion(
    data: PalletCompleteResult,
    palletTypeLabel: 'single' | 'mix',
    boxCount: number,
  ) {
    setLpn(data.lpn || '');
    setLpnUrl(data.lpn_url || '');

    if (session && isSplitSession(session)) {
      // Split jobs: this worker just finished the ONE slot they claimed —
      // there is no cursor to advance and no "next pallet" number to swipe
      // into (next_pallet/all_done are cursor-derived and meaningless per
      // worker here, per the API route's own comment). Hand back to the job
      // screen so they can claim whatever's next, which might not even be a
      // pallet at all, or might go to someone else entirely. Clear this
      // pallet's cache and reset every per-pallet UI flag the same way
      // advanceToNextPallet does for single-mode, so a newly claimed pallet
      // never inherits stale state (confirmedBoxCount, manualMode, etc.)
      // left over from the one just confirmed.
      clearPalletScans(token, currentPallet);
      resetPalletUiState();
      setPhase('job');
      reloadSession();
      return;
    }

    setSession((prev) =>
      prev
        ? {
            ...prev,
            current_pallet: data.next_pallet ?? prev.current_pallet,
            completed_pallets: [
              ...prev.completed_pallets,
              {
                pallet_number: data.pallet_number ?? prev.current_pallet,
                lpn: data.lpn ?? '',
                pallet_type: palletTypeLabel,
                box_count: boxCount,
              },
            ],
          }
        : prev,
    );

    if (data.all_done) {
      clearAllScans(token);
      if (session && session.loose_box_count > 0) {
        setPhase('loose_scanning');
      } else {
        setPhase('all_done');
      }
    } else {
      setPhase('pallet_done');
      fetch('/api/multi-pallet-session', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, current_box_count: 0 }),
      }).catch(() => {});
      clearPalletScans(token, currentPallet);
      // Terminal design: the worker swipes "קליטת משטח הבא" on the done
      // overlay to advance (replaces the old 4s auto-advance timer — gives
      // time to print the sticker first).
      setPendingNextPallet(typeof data.next_pallet === 'number' ? data.next_pallet : currentPallet + 1);
    }
  }

  // Reset every per-pallet UI flag (scans, uniform groups, edit/merge state,
  // damaged-sticker mode, …). Shared by advanceToNextPallet (single-mode:
  // rolls into the next cursor pallet) and applyCompletion's split-mode
  // branch (returns to the job screen instead) — both need a clean slate
  // before the worker starts the next pallet, whichever one that turns out
  // to be.
  function resetPalletUiState() {
    setBoxCountInput('');
    setConfirmedBoxCount(0);
    setScannedBoxes([]);
    processedRef.current.clear();
    setDetectedType('unknown');
    setUniformGroups(new Map());
    setPendingUniformPrompt(null);
    setForcedMix(false);
    setSelectedBarcode(null);
    setEditForm(null);
    setPendingSingleGroup(null);
    setPalletCountError(null);
    setAcceptedMerges(new Map());
    setRejectedMergePairs(new Set());
    setPendingMerge(null);
    setManualMode(false); // damaged mode is per-pallet — reset for the next
    setActiveExpanded(false);
  }

  // Reset all per-pallet state and start scanning the next pallet. Fired by
  // the swipe on the pallet_done overlay.
  function advanceToNextPallet() {
    setCurrentPallet(pendingNextPallet ?? currentPallet + 1);
    setPendingNextPallet(null);
    resetPalletUiState();
    setPhase('scanning');
  }

  // Split jobs only: the manager released or reassigned this worker's
  // claimed pallet mid-scan (409 no_claimed_pallet from either the normal
  // scan-every-box confirm below or MeatManualCountFlow's damaged-sticker
  // POST — both hit the exact same server-side guard). Nothing was written
  // server-side, so there is nothing to undo — discard the local scans and
  // send the worker back to the job screen. A toast carries the message:
  // SplitJobScreen has no prop for an injected message, so the page's own
  // toast (already rendered alongside it) is what the worker actually sees.
  function handlePalletReleased() {
    clearPalletScans(token, currentPallet);
    resetPalletUiState();
    showToast(tr('split.palletReleased'), 'report_problem', '#f8a3a3');
    setPhase('job');
    reloadSession();
  }

  async function handleConfirmPallet() {
    if (scannedBoxes.length < 2) return;
    setPhase('confirming');
    setError(null);

    // Build uniform_groups overrides from locked groups (and image_data is
    // intentionally stripped from scanned_boxes — the server doesn't need it).
    // `name_key` is the normalized-name grouping key, NOT the barcode digits.
    const uniformGroupsPayload = Array.from(uniformGroups.values()).map((g) => ({
      name_key: g.name_key,
      total_count: g.total_count,
      avg_weight: g.avg_weight,
    }));

    // Worker-accepted AI merges (originalKey → canonicalKey). Server applies
    // when grouping for the webhook so Pallet Items reflects the merged set.
    const mergeMapPayload: Record<string, string> = {};
    for (const [from, to] of acceptedMerges.entries()) mergeMapPayload[from] = to;

    try {
      const res = await fetch('/api/multi-pallet-complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          scanned_boxes: scannedBoxes.map(({ ocr_status: _, image_data: _img, ...box }) => box),
          box_count: confirmedBoxCount,
          uniform_groups: uniformGroupsPayload,
          merge_map: mergeMapPayload,
          // Split jobs only: which worker is finishing this pallet. Ignored
          // server-side on a single-scanner session (the cursor's owner is
          // always session.chat_id there).
          worker_chat_id: workerChatId,
        }),
      });
      const data = await res.json();

      if (res.status === 409 && data.error === 'no_claimed_pallet') {
        handlePalletReleased();
        return;
      }

      if (!data.success) {
        // A handful of split-only reasons come back as raw codes — everything
        // else the server already translated into a full sentence. A raw
        // code must never reach the worker.
        const known = data.error ? SPLIT_CLAIM_ERROR_KEYS[data.error] : undefined;
        setError(known ? tr(known) : (data.error || tr('palletVerify.failedComplete')));
        setPhase('scanning');
        return;
      }

      // Per the user's config model: any non-uniform weights even on a single
      // item-name → 'mix' (scenario 2 / "Mix (a)"). Only same-name AND
      // same-weight counts as single. Advance via the shared helper.
      const palletTypeLabel: 'single' | 'mix' =
        detectedType === 'single-uniform' ? 'single' : 'mix';
      applyCompletion(data, palletTypeLabel, confirmedBoxCount);
    } catch {
      setError(tr('palletVerify.networkError'));
      setPhase('scanning');
    }
  }

  // ── Derived ──

  const pallet_count = session?.pallet_count || 1;
  // Confirm is only enabled when:
  //  - no uniform prompt is awaiting an answer, and
  //  - the committed count (non-uniform individuals + locked group totals)
  //    matches the declared box count for this pallet (with a 2-box minimum),
  //    AND
  //  - every scanned box has resolved data (no `needs_review` flag).
  //    Worker must tap each warning, see the captured sticker, and fix
  //    the name/weight before the pallet can advance.
  const committed = committedCount();
  // OCR-complete box count + whether any scan is still being read. Used to gate
  // classification and the pallet-total input to ">=4 boxes, OCR done".
  const doneCount = scannedBoxes.filter(
    (b) => b.ocr_status === 'done' && b.weight > 0 && (b.item_name || b.item_name_hebrew),
  ).length;
  const anyProcessing = scannedBoxes.some((b) => b.ocr_status === 'processing');
  const unresolvedWarnings = scannedBoxes.filter((b) => b.needs_review).length;
  const hasUnresolvedWarnings = unresolvedWarnings > 0;
  // Meat short-shipment feature: unreadable boxes NO LONGER hard-block. They
  // become a soft warning routed to "Create LPN anyway" so a worker is never
  // stuck on a pallet. When the feature is off, the old behaviour holds
  // (warnings block until each box is fixed or deleted).
  const softWarnings = !!session?.meat_discrepancy;
  const warningsBlock = hasUnresolvedWarnings && !softWarnings;
  const canConfirm =
    !pendingUniformPrompt &&
    !pendingSingleGroup &&
    confirmedBoxCount > 0 &&
    committed >= confirmedBoxCount &&
    !hasUnresolvedWarnings;
  // Force-create: the worker committed FEWER than declared (a miscount) OR
  // there are unreadable boxes we're allowed to wave through (feature on).
  // Creates the LPN with the committed count behind a warning modal; unreadable
  // boxes are recorded unverified. A 2-box minimum still applies.
  const canForceConfirm =
    !pendingUniformPrompt &&
    !pendingSingleGroup &&
    confirmedBoxCount > 0 &&
    committed >= 2 &&
    !warningsBlock &&
    (committed < confirmedBoxCount || (hasUnresolvedWarnings && softWarnings));

  // Group scanned boxes by normalized OCR'd Hebrew name (with worker-accepted
  // AI merges applied). Barcode digits are intentionally NOT used — they're
  // per-box dedup keys, never product identifiers. See lib/group-key.ts.
  const groupedByName = groupBoxesByName(scannedBoxes, acceptedMerges);
  // Object<key, boxes[]> shape for the existing render paths (Object.entries
  // is what the JSX below expects).
  const groupedItems: Record<string, BoxScan[]> = {};
  for (const [k, v] of groupedByName.entries()) groupedItems[k] = v;

  // ── Type badge ──

  function TypeBadge() {
    if (detectedType === 'unknown')
      return <span className="text-xs text-ink-muted">{tr('palletVerify.scan2Detect')}</span>;
    if (detectedType === 'single-uniform')
      return (
        <span className="inline-flex items-center gap-1 text-xs bg-ok-weak text-ok-weak-ink rounded-full px-2 py-0.5 font-bold">
          <CheckCircle className="w-3.5 h-3.5 shrink-0" />
          {tr('palletVerify.singleUniformBadge')}
        </span>
      );
    if (detectedType === 'single-nonuniform')
      return (
        <span className="inline-flex items-center gap-1 text-xs bg-warn-weak text-warn-weak-ink rounded-full px-2 py-0.5 font-bold">
          <Scale className="w-3.5 h-3.5 shrink-0" />
          {tr('palletVerify.singleNonuniformBadge')}
        </span>
      );
    return (
      <span className="inline-flex items-center gap-1 text-xs bg-brand-weak text-brand-weak-ink rounded-full px-2 py-0.5 font-bold">
        <Boxes className="w-3.5 h-3.5 shrink-0" />
        {tr('palletVerify.mixBadge')}
      </span>
    );
  }

  if (phase === 'error') {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-6 bg-canvas">
        <XCircle className="text-danger w-12 h-12 mb-4" />
        <p className="text-lg font-semibold text-danger-weak-ink text-center">{error}</p>
        {debugPanel}
      </div>
    );
  }

  if (phase === 'loading') {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-6 bg-canvas">
        <Loader2 className="animate-spin text-brand w-10 h-10 mb-4" />
        <p className="text-ink-body">{tr('palletVerify.loadingSession')}</p>
        {debugPanel}
      </div>
    );
  }

  // Split jobs only: the worker has no claimed pallet (and no claimed loose
  // task) right now — show the job screen instead of a numbered "pallet N of
  // M" cursor. Claiming (or resuming) hands off to the scanning phase below
  // completely unchanged; confirming a pallet returns here (applyCompletion).
  //
  // Gated on category !== 'non_meat': split is meat-only in phase 1, but
  // nothing upstream stops a split session from also being non_meat. If the
  // job screen rendered here, a worker could claim a slot and get handed to
  // NonMeatTypeAFlow below — a component with no worker_chat_id wiring — and
  // its completion POST would 409 every time. Falling through instead lets
  // the (unconditional, phase-agnostic) non-meat handoff just below take
  // over immediately, exactly as it already does for single-scanner sessions.
  if (phase === 'job' && session?.category !== 'non_meat') {
    return withLang(
      <>
        <SplitJobScreen
          session={session!}
          workerChatId={workerChatId}
          onClaimed={(n) => { setCurrentPallet(n); setPhase('scanning'); }}
          onRefresh={reloadSession}
        />
        <Toast toast={toast} />
      </>,
    );
  }

  // Weight-based non-meat (Type A) runs a completely different scanner UX:
  // one box per invoice item per pallet, count pre-filled from the invoice.
  // Hand off to the self-contained flow; the meat path below is untouched.
  if (session?.category === 'non_meat') {
    return <NonMeatTypeAFlow token={token} initialSession={session} />;
  }

  // Damaged-sticker manual-count mode: replace the scanner for the CURRENT
  // pallet with a per-item declared-count form (never blocks). Only while
  // actively scanning — once a pallet is confirmed the parent phases
  // (pallet_done / all_done / loose_scanning) take over rendering.
  if (manualMode && session && phase === 'scanning') {
    return (
      <MeatManualCountFlow
        token={token}
        session={session}
        lang={language}
        workerChatId={workerChatId}
        onComplete={applyCompletion}
        onCancel={() => setManualMode(false)}
        onReleased={handlePalletReleased}
      />
    );
  }

  if (phase === 'all_done') {
    const looseCount = session?.loose_box_count || 0;
    const completed = session?.completed_pallets || [];
    const totalBoxes = completed.reduce((s, p) => s + (p.box_count || 0), 0);
    const langSuffix = language === 'Hebrew' ? '&lang=Hebrew' : '';
    // Terminal design "כל המשטחים נקלטו" card: stats, real per-pallet sticker
    // links (the design's primary "ניפוק מדבקות" action), and the ERP-finalize
    // button rendered LOCKED (no scanner→Priority integration exists).
    return withLang(
      <div className="h-dvh relative bg-canvas overflow-hidden">
        <div className="absolute inset-0 z-[70] bg-[rgba(5,8,10,.74)] backdrop-blur-[3px] flex items-center justify-center p-[22px]">
          <div className="w-full max-w-[330px] max-h-[90dvh] overflow-y-auto no-scrollbar bg-overlay-card border border-[#1e3a2e] rounded-[20px] px-5 py-[22px] shadow-[0_26px_64px_rgba(0,0,0,.72)] animate-doneRise">
            <div className="flex justify-center mb-[13px]">
              <div className="w-[66px] h-[66px] rounded-full bg-ok-weak flex items-center justify-center animate-donePop">
                <MI name="check_circle" size={38} style={{ color: '#4ade80' }} />
              </div>
            </div>
            <div className="text-center text-[19px] font-black text-ink-inverse">
              {tr('terminal.allDoneTitle')}
            </div>
            <div className="text-center text-[12px] font-semibold text-ink-muted mt-1" >
              {tr('palletVerify.docPrefix', { doc: session?.document_number || '—' })}
            </div>
            <div className="flex gap-2 mt-4">
              <div className="flex-1 bg-sunken border border-line rounded-[11px] px-[6px] py-[10px] text-center">
                <div className="text-[16px] font-black text-ink-inverse">{pallet_count}</div>
                <div className="text-[9px] font-bold text-ink-muted mt-[2px]">{tr('terminal.toolPallets')}</div>
              </div>
              <div className="flex-1 bg-sunken border border-line rounded-[11px] px-[6px] py-[10px] text-center">
                <div className="text-[16px] font-black text-ink-inverse">{totalBoxes || '—'}</div>
                <div className="text-[9px] font-bold text-ink-muted mt-[2px]">{tr('terminal.statCartons')}</div>
              </div>
            </div>

            {/* Real: per-pallet sticker links (design list-row style) */}
            {completed.length > 0 && (
              <div className="mt-4 flex flex-col gap-2">
                <div className="text-[9px] font-extrabold text-[#cbd5e1] tracking-[2px]">
                  {tr('pallet.stickers.title')}
                </div>
                {completed.map((p) => (
                  <a
                    key={p.lpn}
                    href={`/pallet/${encodeURIComponent(p.lpn)}?token=${encodeURIComponent(token)}${langSuffix}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-[10px] bg-[rgba(10,15,20,.5)] border border-line rounded-[13px] px-[13px] py-[11px]"
                  >
                    <span className="flex-none w-8 h-8 rounded-[9px] bg-tile border border-line flex items-center justify-center font-mono font-black text-[13px] text-[#e8eef2]">
                      {p.pallet_number}
                    </span>
                    <span className="flex-1 min-w-0 font-mono text-[11px] font-bold text-ink truncate" dir="ltr">
                      {p.lpn}
                    </span>
                    <span className="flex-none inline-flex items-center gap-1 text-brand-weak-ink text-[11px] font-extrabold">
                      <MI name="print" size={16} /> {tr('palletVerify.printSticker')}
                    </span>
                  </a>
                ))}
              </div>
            )}

            {looseCount > 0 && (
              <div className="mt-3 bg-warn-weak border border-warn/30 rounded-[11px] p-3 text-[11px] font-semibold text-warn-weak-ink">
                {tr('palletVerify.looseBoxesNote', { count: looseCount })}
              </div>
            )}

            {/* Locked: ERP finalize (design's "סגירה ושליחה לפריוריטי") */}
            <button
              onClick={showLockToast}
              className="flex items-center justify-center gap-[7px] w-full mt-4 border border-[#35516a] text-[#e8eef2] text-[12px] font-extrabold rounded-[11px] py-[11px] opacity-60"
            >
              <MI name="lock" size={15} style={{ color: '#f6b45a' }} />
              <MI name="cloud_sync" size={17} className="text-brand-weak-ink" />
              {tr('terminal.sendToPriority')}
            </button>

            <p className="text-[10px] text-ink-muted text-center mt-3">
              {tr('palletVerify.expiryNote')}
            </p>
          </div>
        </div>
        <Toast toast={toast} />
        {debugPanel}
      </div>
    );
  }

  if (phase === 'loose_scanning' || phase === 'loose_confirming') {
    const declared = session?.loose_box_count || 0;
    const scanned = looseBoxes.length;
    // Block loose-finish on unresolved warnings, same gate as the pallet phase.
    // Loose boxes go straight to Box Inventory with no further OCR pass, so
    // bad data here is just as harmful as on a pallet.
    const unresolvedLooseWarnings = looseBoxes.filter((b) => b.needs_review).length;
    const hasUnresolvedLooseWarnings = unresolvedLooseWarnings > 0;
    const canConfirmLoose =
      scanned >= Math.min(2, declared) &&
      (declared === 0 || scanned >= declared) &&
      !hasUnresolvedLooseWarnings;

    // Terminal layout: newest scan becomes the active card, the rest are
    // history rows (flat, newest first — the design's list shape).
    const looseNewestFirst = [...looseBoxes].reverse();
    const looseActive = looseNewestFirst[0];
    const looseRest = looseNewestFirst.slice(1);

    // Two-step row actions (tap row → tap action), same handlers as before.
    const looseRowTrailing = (box: BoxScan) => {
      if (selectedBarcode !== box.barcode) return undefined;
      if (box.ocr_status === 'failed') {
        return (
          <span className="flex gap-1">
            {box.image_data && (
              <button
                onClick={(e) => { e.stopPropagation(); setViewingImage(box.image_data!); }}
                className="px-2 py-1 bg-sunken text-ink-body rounded-[8px] text-[10px] font-semibold"
              >
                {tr('ocr.view')}
              </button>
            )}
            <button
              onClick={(e) => { e.stopPropagation(); retryLooseOcr(box.barcode); }}
              className="px-2 py-1 bg-brand-weak text-brand-weak-ink rounded-[8px] text-[10px] font-semibold"
            >
              {tr('ocr.retry')}
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); rescanLooseBox(box.barcode); setSelectedBarcode(null); }}
              className="px-2 py-1 bg-danger text-ink-inverse rounded-[8px] text-[10px] font-semibold"
            >
              {tr('palletVerify.deleteScan')}
            </button>
          </span>
        );
      }
      return (
        <span className="flex gap-1">
          <button
            onClick={(e) => { e.stopPropagation(); openEdit(box, true); }}
            className="px-2 py-1 bg-brand text-ink-inverse rounded-[8px] text-[10px] font-semibold"
          >
            {tr('palletVerify.editScan')}
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); rescanLooseBox(box.barcode); setSelectedBarcode(null); }}
            className="px-2 py-1 bg-danger text-ink-inverse rounded-[8px] text-[10px] font-semibold"
          >
            {tr('palletVerify.deleteScan')}
          </button>
        </span>
      );
    };

    const looseFooter = (
      <>
        {error && <p className="text-danger-weak-ink text-sm text-center mb-2">{error}</p>}
        {canConfirmLoose && phase !== 'loose_confirming' ? (
          <SwipeConfirm
            variant="warn"
            onConfirm={handleConfirmLooseBoxes}
            label={tr('palletVerify.swipeConfirmLoose', { count: scanned })}
          />
        ) : (
          <button
            disabled
            className="w-full py-3 rounded-[13px] font-extrabold text-base bg-sunken text-ink-muted cursor-not-allowed"
          >
            {canConfirmLoose
              ? tr('palletVerify.confirmLooseBtn', { count: scanned })
              : hasUnresolvedLooseWarnings
              ? tr('palletVerify.warningsBlockConfirm', { count: unresolvedLooseWarnings })
              : declared > 0
              ? tr('palletVerify.scanMoreLoose', { count: Math.max(0, declared - scanned) })
              : tr('palletVerify.scanAtLeast2')}
          </button>
        )}
        {hasUnresolvedLooseWarnings && (
          <p className="flex items-center justify-center gap-1 text-[11px] text-warn-weak-ink text-center mt-1.5">
            <AlertTriangle className="w-3 h-3 shrink-0" /> {tr('palletVerify.warningsBlockConfirm', { count: unresolvedLooseWarnings })}
          </p>
        )}
      </>
    );

    return withLang(
      <div className="h-dvh flex flex-col bg-canvas overflow-hidden">
        <DesignHeader
          title={tr('palletVerify.looseHeader', { scanned, declared })}
          subtitle={tr('palletVerify.docPrefix', { doc: session?.document_number || '—' })}
          onMenu={drawer.open}
        />
        <ProgressHeader
          label={tr('terminal.progressLabelLoose')}
          count={scanned}
          total={declared}
          unitLabel={tr('terminal.statCartons')}
          tone={declared > 0 && scanned >= declared ? 'done' : 'warn'}
        />

        {/* Camera area with the floating bottom sheet over it */}
        <div className="flex-1 min-h-0 relative bg-black">
          <div className="absolute inset-0">
            {/* Scanner — explicit key forces a fresh mount so the internal
                scanContinuously() closure picks up handleLooseBarcodeDetected
                instead of the stale pallet-phase handler. */}
            <SmartScanner
              key="loose-scanner"
              frame="corner"
              className="h-full"
              onBarcodeDetected={handleLooseBarcodeDetected}
              onManualCapture={handleLooseManualCapture}
              onDuplicateFlash={(fn) => { looseDupFlashRef.current = fn; }}
              scannedBarcodes={new Map()}
              ocrResults={new Map()}
            />
          </div>
          {phase === 'loose_confirming' && (
            <div className="absolute inset-0 z-40 bg-black/60 flex items-center justify-center">
              <div className="bg-overlay-card border border-line rounded-[13px] px-4 py-3 flex items-center gap-2 animate-doneRise">
                <Loader2 className="animate-spin w-5 h-5 text-warn" />
                <span className="text-sm font-bold text-ink">{tr('palletVerify.savingLoose')}</span>
              </div>
            </div>
          )}

          <BottomSheet
            ref={looseSheetRef}
            toolbar={
              <ToolDock
                chips={buildDockChips({
                  gap: () => showToast(tr('terminal.gapNotApplicable'), 'report_problem', '#fbbf5c'),
                })}
                onLockedPress={showLockToast}
              />
            }
            footer={editForm?.isLoose ? undefined : looseFooter}
          >
            {editForm?.isLoose ? (
              editPanelNode
            ) : (
              <>
                {looseActive && (
                  <ActiveScanCard
                    tone="warn"
                    index={looseBoxes.length}
                    name={looseActive.item_name_hebrew || looseActive.item_name || '—'}
                    value={looseActive.weight > 0 ? looseActive.weight.toFixed(2) : '—'}
                    unit={tr('common.kg')}
                    barcode={looseActive.barcode}
                    expiry={looseActive.expiry || undefined}
                    status={
                      looseActive.ocr_status === 'processing'
                        ? 'reading'
                        : looseActive.ocr_status === 'failed'
                        ? 'failed'
                        : 'done'
                    }
                    expanded={activeExpanded}
                    onToggleExpand={() => setActiveExpanded((v) => !v)}
                    onEdit={() => openEdit(looseActive, true)}
                  />
                )}
                {looseRest.map((box, i) => (
                  <HistoryRow
                    key={box.barcode + i}
                    index={looseBoxes.length - 1 - i}
                    name={box.item_name_hebrew || box.item_name || '—'}
                    barcode={box.barcode}
                    weight={box.weight > 0 ? box.weight.toFixed(2) : undefined}
                    unitLabel={tr('common.kg')}
                    status={
                      box.ocr_status === 'processing'
                        ? 'pending'
                        : box.ocr_status === 'failed' || box.needs_review
                        ? box.ocr_status === 'failed' ? 'failed' : 'pending'
                        : 'done'
                    }
                    onClick={() => setSelectedBarcode(selectedBarcode === box.barcode ? null : box.barcode)}
                    trailing={looseRowTrailing(box)}
                  />
                ))}
              </>
            )}
          </BottomSheet>
        </div>

        <Toast toast={toast} />
        {drawer.node}
        {palletsBrowser}
        {imageModal}
        {debugPanel}
      </div>
    );
  }

  if (phase === 'pallet_done') {
    // Terminal design done overlay: stats + swipe "קליטת משטח הבא" (replaces
    // the old 4s auto-advance) + real sticker deep-link for THIS pallet.
    const doneBoxCount =
      session?.completed_pallets?.[session.completed_pallets.length - 1]?.box_count || committed;
    const doneWeight = scannedBoxes.reduce((s, b) => s + (b.weight > 0 ? b.weight : 0), 0);
    return withLang(
      <div className="h-dvh relative bg-canvas overflow-hidden">
        <DoneOverlay
          title={tr('terminal.palletDoneTitle', { n: currentPallet })}
          subtitle={lpn ? `LPN ${lpn}` : undefined}
          stats={[
            { value: <span dir="ltr">{currentPallet}/{pallet_count}</span>, label: tr('terminal.statPallet') },
            { value: doneBoxCount, label: tr('terminal.statCartons') },
            {
              value: doneWeight > 0
                ? <>{doneWeight.toFixed(1)}<span className="text-[9px] font-extrabold text-ink-muted"> {tr('common.kg')}</span></>
                : '—',
              label: tr('terminal.statWeight'),
              wide: true,
            },
          ]}
        >
          <div className="mt-4">
            <SwipeConfirm
              onConfirm={advanceToNextPallet}
              label={tr('terminal.swipeNextPallet')}
            />
          </div>
          {lpnUrl && (
            <a
              href={`${lpnUrl}?token=${encodeURIComponent(token)}${language === 'Hebrew' ? '&lang=Hebrew' : ''}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-[7px] w-full mt-[9px] border border-[#35516a] text-[#e8eef2] text-[12px] font-extrabold rounded-[11px] py-[11px]"
            >
              <MI name="print" size={17} className="text-brand-weak-ink" /> {tr('terminal.issuePalletLabels')}
            </a>
          )}
        </DoneOverlay>
        {debugPanel}
      </div>
    );
  }

  // ── Scanning / confirming — the terminal main screen ──

  // Newest scan = the blue active card; the rest = flat history rows
  // (newest first, the design's list shape). Grouping still drives the
  // uniform/mix logic — only the presentation is flat.
  const newestFirst = [...scannedBoxes].reverse();
  const activeBox = newestFirst[0];
  const restBoxes = newestFirst.slice(1);

  // Two-step row actions (tap row → tap action), same handlers as before.
  const palletRowTrailing = (box: BoxScan) => {
    if (selectedBarcode !== box.barcode) return undefined;
    if (box.ocr_status === 'failed') {
      return (
        <span className="flex gap-1">
          {box.image_data && (
            <button
              onClick={(e) => { e.stopPropagation(); setViewingImage(box.image_data!); }}
              className="px-2 py-1 bg-sunken text-ink-body rounded-[8px] text-[10px] font-semibold"
            >
              {tr('ocr.view')}
            </button>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); retryPalletOcr(box.barcode); }}
            className="px-2 py-1 bg-brand-weak text-brand-weak-ink rounded-[8px] text-[10px] font-semibold"
          >
            {tr('ocr.retry')}
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); rescanPalletBox(box.barcode); setSelectedBarcode(null); }}
            className="px-2 py-1 bg-danger text-ink-inverse rounded-[8px] text-[10px] font-semibold"
          >
            {tr('palletVerify.deleteScan')}
          </button>
        </span>
      );
    }
    return (
      <span className="flex gap-1">
        <button
          onClick={(e) => { e.stopPropagation(); openEdit(box); }}
          className="px-2 py-1 bg-brand text-ink-inverse rounded-[8px] text-[10px] font-semibold"
        >
          {tr('palletVerify.editScan')}
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); rescanPalletBox(box.barcode); setSelectedBarcode(null); }}
          className="px-2 py-1 bg-danger text-ink-inverse rounded-[8px] text-[10px] font-semibold"
        >
          {tr('palletVerify.deleteScan')}
        </button>
      </span>
    );
  };

  // Guidance line from the old header — where does the worker stand now.
  const statusText = canConfirm
    ? tr('palletVerify.readyToConfirm')
    : pendingUniformPrompt
    ? tr('palletVerify.waitingInput')
    : confirmedBoxCount === 0
    ? (committed < 2 ? tr('palletVerify.scanToStart') : tr('palletVerify.setTotalBelow'))
    : tr('palletVerify.moreBoxesToGo', { count: Math.max(0, confirmedBoxCount - committed) });

  // Footer — priority-ordered modes:
  // (1) single_or_mix uniform prompt (Complete / Continue),
  // (2) deferred pallet box-count input,
  // (3) standard confirm (swipe) / force-confirm / disabled reason.
  const mainFooter = (
    <>
      {error && <p className="text-danger-weak-ink text-sm text-center mb-2">{error}</p>}
      {!canConfirm && (
        <p className="text-[10px] font-bold text-ink-muted text-center mb-2">{statusText}</p>
      )}

      {pendingUniformPrompt?.mode === 'single_or_mix' ? (
        <div className="space-y-2">
          <p className="text-xs text-ink-body text-center mb-1">
            {tr('palletVerify.uniformChoose')}
          </p>
          <button
            onClick={handleCompleteAsSingle}
            disabled={phase === 'confirming'}
            className="flex items-center justify-center gap-[6px] w-full py-3 rounded-[13px] font-black text-[14px] bg-ok text-canvas disabled:bg-sunken disabled:text-ink-muted"
          >
            <MI name="check_circle" size={18} /> {tr('palletVerify.uniformCompleteBtn')}
          </button>
          <button
            onClick={handleContinueAsMix}
            disabled={phase === 'confirming'}
            className="flex items-center justify-center gap-[6px] w-full py-3 rounded-[13px] font-extrabold text-[13px] bg-tile border-2 border-brand text-brand-weak-ink"
          >
            <MI name="add" size={18} /> {tr('palletVerify.uniformContinueMix')}
          </button>
        </div>
      ) : (confirmedBoxCount === 0 && !anyProcessing && (doneCount >= 4 || forcedMix || !!pendingSingleGroup)) ? (
        <div className="space-y-2">
          <label className="block text-xs text-ink-body font-medium">
            {tr('palletVerify.deferredCountTitle')}
          </label>
          <p className="text-[11px] text-ink-muted">
            {tr('palletVerify.deferredCountHint', { scanned: scannedBoxes.length })}
          </p>
          <div className="flex gap-2">
            <input
              type="number"
              inputMode="numeric"
              min={Math.max(2, scannedBoxes.length)}
              value={boxCountInput}
              onChange={(e) => {
                setBoxCountInput(e.target.value);
                setPalletCountError(null);
              }}
              onKeyDown={(e) => e.key === 'Enter' && handlePalletCountSubmit()}
              placeholder={tr('palletVerify.boxCountPlaceholder')}
              className="flex-1 min-w-0 text-center text-xl font-black font-mono text-ink bg-sunken border-2 border-line-strong rounded-[12px] py-2 px-3 transition outline-none focus:border-brand focus:ring-4 focus:ring-brand/20 placeholder:text-ink-muted placeholder:font-medium placeholder:text-base placeholder:font-sans"
              autoFocus
            />
            <button
              onClick={handlePalletCountSubmit}
              className="shrink-0 px-5 py-2 rounded-[12px] bg-brand text-ink-inverse font-black text-sm"
            >
              {tr('palletVerify.uniformSet')}
            </button>
          </div>
          {palletCountError && (
            <p className="text-danger-weak-ink text-xs">{palletCountError}</p>
          )}
          {pendingSingleGroup && (
            <button
              onClick={handleCancelSingleConfirm}
              className="w-full text-xs text-ink-muted underline pt-1"
            >
              {tr('palletVerify.cancelSingle')}
            </button>
          )}
        </div>
      ) : (
        <>
          {!canConfirm && canForceConfirm ? (
            <button
              onClick={() => setPendingForceConfirm(true)}
              disabled={phase === 'confirming'}
              className="flex items-center justify-center gap-[6px] w-full py-3 rounded-[13px] font-black text-[14px] bg-warn text-canvas disabled:bg-sunken disabled:text-ink-muted"
            >
              <MI name="report_problem" size={18} /> {tr('palletVerify.forceCreateBtn')}
            </button>
          ) : canConfirm && phase !== 'confirming' ? (
            <SwipeConfirm
              onConfirm={handleConfirmPallet}
              label={tr('palletVerify.swipeConfirmPallet', { current: currentPallet })}
            />
          ) : (
            <button
              disabled
              className="w-full py-3 rounded-[13px] font-extrabold text-base bg-sunken text-ink-muted cursor-not-allowed"
            >
              {canConfirm
                ? tr('palletVerify.confirmPalletBtn', { current: currentPallet })
                : hasUnresolvedWarnings
                ? tr('palletVerify.warningsBlockConfirm', { count: unresolvedWarnings })
                : committed < 2
                ? tr('palletVerify.scanMoreToContinue', { count: 2 - committed })
                : tr('palletVerify.boxesNeeded', { count: Math.max(0, confirmedBoxCount - committed) })}
            </button>
          )}
          {confirmedBoxCount === 0 && !forcedMix && !pendingSingleGroup && doneCount < 4 && doneCount >= 1 && !anyProcessing && (
            <button
              onClick={() => setForcedMix(true)}
              className="w-full text-xs text-ink-muted underline pt-2"
            >
              {tr('palletVerify.fewerThan4')}
            </button>
          )}
          {hasUnresolvedWarnings && (
            <p className="flex items-center justify-center gap-1 text-[11px] text-warn-weak-ink text-center mt-1.5">
              <AlertTriangle className="w-3 h-3 shrink-0" />{' '}
              {softWarnings
                ? tr('palletVerify.unreadableSoftNote', { count: unresolvedWarnings })
                : tr('palletVerify.warningsBlockConfirm', { count: unresolvedWarnings })}
            </p>
          )}
        </>
      )}
      {softWarnings && !manualMode && phase === 'scanning' && (
        <button
          onClick={() => setManualMode(true)}
          className="w-full mt-2 text-xs text-warn-weak-ink font-medium underline"
        >
          {tr('palletVerify.stickersDamaged')}
        </button>
      )}
    </>
  );

  return withLang(
    <div className="h-dvh flex flex-col bg-canvas overflow-hidden">
      <DesignHeader
        title={
          confirmedBoxCount > 0
            ? tr('palletVerify.palletHeaderWithCount', { current: currentPallet, total: pallet_count, count: confirmedBoxCount })
            : tr('palletVerify.palletHeaderShort', { current: currentPallet, total: pallet_count })
        }
        subtitle={tr('palletVerify.docPrefix', { doc: session?.document_number || '—' })}
        onMenu={drawer.open}
        right={<span className="pe-1"><TypeBadge /></span>}
      />
      <ProgressHeader
        label={tr('terminal.progressLabel', { n: currentPallet, total: pallet_count })}
        count={committed}
        total={confirmedBoxCount}
        unitLabel={tr('terminal.statCartons')}
        tone={canConfirm ? 'done' : 'brand'}
      />

      {/* Camera area with the floating bottom sheet over it */}
      <div className="flex-1 min-h-0 relative bg-black">
        <div className="absolute inset-0">
          {/* Scanner — keyed per pallet so each new pallet gets a fresh
              scanner instance (clears the internal cooldown/dedup refs). */}
          <SmartScanner
            key={`pallet-scanner-${currentPallet}`}
            frame="corner"
            className="h-full"
            onBarcodeDetected={handleBarcodeDetected}
            onManualCapture={handleManualCapture}
            onDuplicateFlash={(fn) => { dupFlashRef.current = fn; }}
            scannedBarcodes={new Map()}
            ocrResults={new Map()}
          />
        </div>
        {phase === 'confirming' && (
          <div className="absolute inset-0 z-40 bg-black/60 flex items-center justify-center">
            <div className="bg-overlay-card border border-line rounded-[13px] px-4 py-3 flex items-center gap-2 animate-doneRise">
              <Loader2 className="animate-spin w-5 h-5 text-brand" />
              <span className="text-sm font-bold text-ink">{tr('palletVerify.savingPallet')}</span>
            </div>
          </div>
        )}

        <BottomSheet
          ref={sheetRef}
          toolbar={
            <ToolDock
              chips={buildDockChips({
                gap: () =>
                  canForceConfirm
                    ? setPendingForceConfirm(true)
                    : showToast(tr('terminal.gapNotApplicable'), 'report_problem', '#fbbf5c'),
              })}
              onLockedPress={showLockToast}
            />
          }
          footer={editForm && !editForm.isLoose ? undefined : mainFooter}
        >
          {editForm && !editForm.isLoose ? (
            editPanelNode
          ) : (
            <>
              {/* AI consolidation banner — Gemini thinks two groups are the
                  same product (OCR drift). Worker confirms or dismisses. */}
              {pendingMerge && (
                <div className="bg-amber-card border-[1.5px] border-warn/55 rounded-[14px] p-3">
                  <p className="flex items-center gap-1 text-xs font-bold text-warn-weak-ink mb-1">
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {tr('palletVerify.aiMergeBanner')}
                  </p>
                  <ul className="text-xs text-warn-weak-ink mb-2 space-y-0.5">
                    {pendingMerge.sample_names.map((nm, i) => {
                      const fallbackKey = pendingMerge.from_keys[i]?.replace(/^(he|en|unknown):/, '') ?? '';
                      const display = nm.he || nm.en || fallbackKey;
                      const count = pendingMerge.box_counts[i] ?? 0;
                      return (
                        <li key={pendingMerge.from_keys[i] ?? i} className="flex items-baseline gap-1">
                          <span className="font-semibold">{display}</span>
                          <span>×{count}</span>
                        </li>
                      );
                    })}
                  </ul>
                  <div className="flex gap-2">
                    <button
                      onClick={handleAcceptMerge}
                      className="flex items-center justify-center gap-[6px] flex-1 min-w-0 py-2 rounded-[10px] bg-warn text-canvas text-xs font-bold"
                    >
                      <Check className="w-3.5 h-3.5" /> {tr('palletVerify.aiMergeAccept')}
                    </button>
                    <button
                      onClick={handleRejectMerge}
                      className="shrink-0 px-4 py-2 rounded-[10px] bg-tile border border-warn/30 text-warn-weak-ink text-xs font-bold"
                    >
                      {tr('palletVerify.aiMergeReject')}
                    </button>
                  </div>
                </div>
              )}

              {/* Locked uniform single-item groups */}
              {uniformGroups.size > 0 && (
                <div className="bg-ok-weak border border-ok/30 rounded-[13px] px-3 py-2">
                  <p className="flex items-center gap-1 text-[11px] font-bold text-ok-weak-ink mb-1">
                    <CheckCircle className="w-3.5 h-3.5 shrink-0" /> {tr('palletVerify.uniformItemsHeader')}
                  </p>
                  <ul className="text-xs text-ok-weak-ink space-y-0.5">
                    {Array.from(uniformGroups.values()).map((g) => {
                      const name = g.item_name_hebrew || g.item_name || g.name_key.replace(/^(he|en|unknown):/, '');
                      return (
                        <li key={g.name_key}>
                          {tr('palletVerify.uniformLockedItem', { name, count: g.total_count, weight: g.avg_weight })}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}

              {activeBox && (
                <ActiveScanCard
                  index={scannedBoxes.length}
                  name={activeBox.item_name_hebrew || activeBox.item_name || '—'}
                  value={activeBox.weight > 0 ? activeBox.weight.toFixed(2) : '—'}
                  unit={tr('common.kg')}
                  barcode={activeBox.barcode}
                  expiry={activeBox.expiry || undefined}
                  status={
                    activeBox.ocr_status === 'processing'
                      ? 'reading'
                      : activeBox.ocr_status === 'failed'
                      ? 'failed'
                      : 'done'
                  }
                  expanded={activeExpanded}
                  onToggleExpand={() => setActiveExpanded((v) => !v)}
                  onEdit={() => openEdit(activeBox)}
                />
              )}
              {activeBox && selectedBarcode === activeBox.barcode && (
                <div className="flex justify-end -mt-1">{palletRowTrailing(activeBox)}</div>
              )}

              {restBoxes.map((box, i) => (
                <HistoryRow
                  key={box.barcode + i}
                  index={scannedBoxes.length - 1 - i}
                  name={box.item_name_hebrew || box.item_name || '—'}
                  barcode={box.barcode}
                  weight={box.weight > 0 ? box.weight.toFixed(2) : undefined}
                  unitLabel={tr('common.kg')}
                  status={
                    box.ocr_status === 'processing'
                      ? 'pending'
                      : box.ocr_status === 'failed'
                      ? 'failed'
                      : box.needs_review
                      ? 'pending'
                      : 'done'
                  }
                  onClick={() => setSelectedBarcode(selectedBarcode === box.barcode ? null : box.barcode)}
                  trailing={palletRowTrailing(box)}
                />
              ))}

              {detectedType === 'mix' && Object.keys(groupedItems).length > 1 && (
                <p className="text-xs text-ink-muted text-center">
                  {tr('palletVerify.itemTypesDetected', { count: Object.keys(groupedItems).length })}
                </p>
              )}
            </>
          )}
        </BottomSheet>
      </div>

      <Toast toast={toast} />
      {drawer.node}
      {palletsBrowser}
      {imageModal}
      {pendingForceConfirm && (
        // Terminal design "פער מול התעודה" — amber discrepancy card with
        // scanned/expected/shortfall tiles + swipe-to-confirm. Same handler
        // wiring as the old force-confirm buttons.
        <div className="fixed inset-0 z-[72] bg-[rgba(5,8,10,0.74)] backdrop-blur-[3px] flex items-center justify-center p-[22px]">
          <div className="w-full max-w-[330px] bg-amber-card border border-[rgba(245,158,11,0.5)] rounded-[20px] px-5 py-[22px] shadow-[0_26px_64px_rgba(0,0,0,0.72)] animate-doneRise">
            <div className="flex justify-center mb-[13px]">
              <div className="w-16 h-16 rounded-full bg-[rgba(245,158,11,0.16)] flex items-center justify-center">
                <MI name="report_problem" size={34} style={{ color: '#fbbf5c' }} />
              </div>
            </div>
            <h2 className="text-center text-[19px] font-black text-ink-inverse">{tr('palletVerify.discrepancyTitle')}</h2>
            <p className="text-center text-xs font-semibold text-[#d8c9a0] mt-1">{tr('palletVerify.discrepancySubtitle')}</p>
            <div className="flex gap-2 mt-4">
              <div className="flex-1 bg-amber-well border border-[rgba(245,158,11,0.28)] rounded-[11px] px-1.5 py-2.5 text-center">
                <div className="font-mono font-black text-base text-ink-inverse" dir="ltr">{committed}</div>
                <div className="text-[8.5px] font-bold text-[#d8c9a0] mt-0.5">{tr('palletVerify.discrepancyScanned')}</div>
              </div>
              <div className="flex-1 bg-amber-well border border-[rgba(245,158,11,0.28)] rounded-[11px] px-1.5 py-2.5 text-center">
                <div className="font-mono font-black text-base text-ink-inverse" dir="ltr">{confirmedBoxCount}</div>
                <div className="text-[8.5px] font-bold text-[#d8c9a0] mt-0.5">{tr('palletVerify.discrepancyExpected')}</div>
              </div>
              <div className="flex-1 bg-amber-well border border-[rgba(245,158,11,0.28)] rounded-[11px] px-1.5 py-2.5 text-center">
                <div className="font-mono font-black text-base text-[#fbbf5c]" dir="ltr">{Math.max(0, confirmedBoxCount - committed)}</div>
                <div className="text-[8.5px] font-bold text-[#d8c9a0] mt-0.5">{tr('palletVerify.discrepancyShortfall')}</div>
              </div>
            </div>
            <p className="text-center text-[11px] text-[#d8c9a0]/80 mt-3">
              {tr('palletVerify.forceConfirmWarning', { committed, declared: confirmedBoxCount })}
            </p>
            <div className="mt-4">
              <SwipeConfirm
                variant="warn"
                label={tr('palletVerify.discrepancySwipe')}
                onConfirm={() => { setPendingForceConfirm(false); handleConfirmPallet(); }}
              />
            </div>
            <button
              onClick={() => setPendingForceConfirm(false)}
              className="w-full mt-2 py-2 text-ink-muted text-xs font-extrabold transition"
            >
              {tr('common.cancel')}
            </button>
          </div>
        </div>
      )}
      {debugPanel}
    </div>
  );
}
