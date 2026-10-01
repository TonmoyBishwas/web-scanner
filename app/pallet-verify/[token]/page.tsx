'use client';

import { use, useCallback, useEffect, useRef, useState } from 'react';
import {
  CheckCircle,
  XCircle,
  Loader2,
  AlertTriangle,
  Check,
} from 'lucide-react';
import { SmartScanner, type RejectKind } from '@/components/scanner/SmartScanner';
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
import { ScanActions } from '@/components/terminal/ScanActions';
import { HistoryRow } from '@/components/terminal/HistoryRow';
import { EditPanel } from '@/components/terminal/EditPanel';
import { findBarcodeConflict, type BarcodeConflict } from '@/lib/barcode-parser';
import { DoneOverlay } from '@/components/terminal/DoneOverlay';
import { Toast, useLockToast } from '@/components/terminal/Toast';
import { PriorityPushStatus } from '@/components/terminal/PriorityPushStatus';
import { useDrawerHost } from '@/components/terminal/DrawerHost';
import { PalletsBrowser } from '@/components/terminal/PalletsBrowser';
import { CartonCreator } from '@/components/terminal/CartonCreator';
import { LabelsBrowser } from '@/components/terminal/LabelsBrowser';
import { IdenticalBoxesForm } from '@/components/terminal/IdenticalBoxesForm';
import {
  dedupCodes,
  expandIdenticalBoxes,
  releasedSources,
  sourceStillListed,
  type IdenticalForm,
} from '@/lib/identical-boxes';
import { isMintedLabelBarcode, labelSheetUrl, liveRowPlaces, loadLabelSize, openListsForPhase } from '@/lib/label-batches';
import { blockingLabels, LABELS_NOT_PRINTED } from '@/lib/label-gate';
import { useUnprintedLabels } from '@/lib/use-unprinted-labels';
import { toIsoDate, normalizeExpiry } from '@/lib/expiry';
import type { CartonLabel } from '@/types';
import SplitJobScreen, { SPLIT_CLAIM_ERROR_KEYS } from '@/components/terminal/SplitJobScreen';
import { installDebugLogCapture } from '@/lib/debug-log';
import { startScannerTrace, trace } from '@/lib/scanner-trace';
import { LanguageContext, useLangDir, t } from '@/lib/i18n';
import type { Language, MultiPalletSession, MultiPalletBoxScan, ParsedBarcode } from '@/types';
import { groupKeyForBox, groupBoxesByName } from '@/lib/group-key';
import { matchInvoiceItem } from '@/lib/invoice-match';
import { isSplitSession } from '@/lib/session-mode';
import { findDuplicateOwner } from '@/lib/duplicate-guard';
import { classifyRead, noteRepeatedRead } from '@/lib/carton-barcode';
import { useBackClose } from '@/lib/use-back-close';
import { useSettingsStore } from '@/stores/settings-store';
import { scanSuccessFeedback, scanDuplicateFeedback, scanAlreadyCountedFeedback } from '@/lib/scan-feedback';
import {
  SCAN_NOTICE_MS,
  HIGHLIGHT_ROW_MS,
  shouldSoundDuplicate,
  clearDuplicateSounds,
  findCountedCarton,
  findCountedCartonByDigits,
  canOfferDifferentCarton,
} from '@/lib/scan-notice';
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
  // A 31-digit carton barcode encodes the weight and expiry, so it is a free
  // second reading of the same sticker. When the two disagree one of them is
  // wrong and the worker is still holding the box. Deliberately NOT folded
  // into `needs_review`: that flag BLOCKS the pallet from closing, and a
  // parser validated on 67 cartons from two suppliers must not be able to
  // stop a delivery. This only warns and offers the value.
  barcode_conflict?: BarcodeConflict;
  // Minted by "all boxes identical" (lib/identical-boxes.ts): the worker
  // declared every carton of this product the same, and this row's barcode
  // is a warehouse-printed label, not a supplier sticker. Such rows are
  // never offered the single-item shortcut — their count is already exact.
  minted?: boolean;
  label_batch_id?: string;
  // The supplier barcode a minted row stands in for. It stays in the dedup
  // set while any row of that batch is on the list (lib/identical-boxes.ts).
  source_barcode?: string;
}

// Digits-only normaliser for comparing the full printed barcode number across
// bar-scanned and OCR-captured boxes (NOT the 13-digit SKU, which repeats
// across every box of one product).
function digitsOnly(s: string | null | undefined): string {
  return (s || '').replace(/\D/g, '');
}

// A manual capture is pushed with a placeholder id and only gets a real one
// when OCR reads the printed digits — or, failing that, when the worker types
// them. `MANUAL-…` must NEVER reach the database: it is not a barcode, so an
// outbound box-sticker scan could never match the row it created.
const PROVISIONAL_PREFIX = 'MANUAL-';
const isProvisional = (barcode: string) => barcode.startsWith(PROVISIONAL_PREFIX);

// What a carton with no readable barcode at all is booked as. It has to be
// non-empty — the bot skips any box whose barcode is falsy
// (`airtable_service.create_pallet_box_inventory`), so an empty string would
// silently drop the carton out of `box_inventory` — and it has to be visibly
// not-a-barcode so nothing ever tries to match it against a scan.
const NO_BARCODE_PREFIX = 'NOBC-';
const noBarcodeId = (doc: string, pallet: number, n: number) =>
  `${NO_BARCODE_PREFIX}${(doc || 'DOC').replace(/[^A-Za-z0-9]/g, '').slice(0, 10)}-P${pallet}-${n}`;

/** A real GS1 carton barcode carries at least the 13-digit item prefix. */
const MIN_BARCODE_DIGITS = 13;

/**
 * Last line of defence before the wire. Every path that books a box is
 * supposed to have replaced the placeholder by now (typed digits, or the
 * NOBC- marker); this makes sure a future one that forgets cannot write
 * `MANUAL-1789…` into `box_inventory.barcode`, where it would look like a
 * scannable code and match nothing for the rest of the carton's life.
 */
function stripProvisionalIds<T extends { barcode: string; sku?: string }>(
  boxes: T[],
  doc: string,
  pallet: number,
): T[] {
  return boxes.map((b, i) =>
    isProvisional(b.barcode)
      ? { ...b, barcode: noBarcodeId(doc, pallet, i + 1), sku: b.sku && !isProvisional(b.sku) ? b.sku : '' }
      : b,
  );
}

/** `2027-06-16` → `16/06/27`, for a toast that has to stay one short line. */
function isoToDdmmyyyyShort(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  return m ? `${m[3]}/${m[2]}/${m[1].slice(2)}` : iso;
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

/**
 * A routine scan outcome shown over the camera for SCAN_NOTICE_MS (see
 * lib/scan-notice.ts): blue "already counted" or amber "misread". Never a
 * failure — those stay in the page's red, persistent `error`.
 */
interface ScanNotice {
  text: string;
  tone: 'info' | 'warn';
  /**
   * "Different carton?": the counted carton a re-read matched, to copy into
   * a label of its own when the worker says the carton in hand is another
   * one with a byte-identical label. `box.barcode` is the code just read.
   */
  different?: { box: BoxScan; loose: boolean; n: number };
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
  /** The supplier's shipping-pallet label scanned on this pallet (MEV-10). */
  supplierPalletRef?: string;
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

// How many OCR'd boxes must agree before the scanner offers the single-item
// shortcut ("scan a couple, declare the total, we multiply"). Two is the
// smallest number that can establish "same weight" at all, and it is what the
// floor actually does: on an all-identical pallet, scanning every box is wasted
// work. Raised to 4 in May 2026 to cut down on premature prompts, lowered back
// to 2 in Aug 2026 at the user's request — the tradeoff being that on a mix
// pallet whose first two boxes happen to match, the choice appears early. That
// is why maybeTriggerUniformPrompt retracts an open prompt the moment a later
// box contradicts it.
const UNIFORM_MIN_SAMPLES = 2;

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
  // Scanner trace (debugging trail, per-user opt-in; see lib/scanner-trace.ts).
  // Idempotent per page load; must precede the session fetch below.
  startScannerTrace({ token, page: 'pallet-verify', workerChatId });

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
  // Red and persistent: something failed and the worker must act (network,
  // session, a split clash, a save error). Routine scan outcomes — a carton
  // read twice, a misread — are `scanNotice` instead.
  const [error, setError] = useState<string | null>(null);
  const [scanNotice, setScanNotice] = useState<ScanNotice | null>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The carton a notice names, highlighted in the list for HIGHLIGHT_ROW_MS.
  const [flashBarcode, setFlashBarcode] = useState<string | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Last re-read time per barcode, so a camera parked on a counted sticker
  // ticks once, not every 3 s (lib/scan-notice.ts). Cleared on a new pallet
  // and on any row delete, so a re-scan after a delete is never muted.
  const dupSoundsRef = useRef<Map<string, number>>(new Map());
  // The pallet total being changed (pencil / CARTONS counter): the old total,
  // while the count input is open again. Null otherwise.
  const [totalEdit, setTotalEdit] = useState<number | null>(null);

  const processedRef = useRef<Set<string>>(new Set());
  const [looseBoxes, setLooseBoxes] = useState<BoxScan[]>([]);
  // Mirrors of the two scan lists for the frozen-closure detect handlers, so a
  // duplicate can be NAMED (which carton, when) instead of just buzzed (SCN-21).
  const scannedBoxesRef = useRef<BoxScan[]>([]);
  const looseBoxesRef = useRef<BoxScan[]>([]);
  useEffect(() => { scannedBoxesRef.current = scannedBoxes; }, [scannedBoxes]);
  useEffect(() => { looseBoxesRef.current = looseBoxes; }, [looseBoxes]);
  // The supplier's own shipping-pallet number, when its label was scanned on
  // this pallet. Pallet identity — never a carton (MEV-10).
  const [supplierPalletRef, setSupplierPalletRef] = useState<string>('');

  // Hydrate the Sound / Vibration settings from localStorage so scan-feedback
  // honours the worker's toggles (defaults to ON until hydrated).
  const hydrateSettings = useSettingsStore((s) => s.hydrate);
  useEffect(() => {
    hydrateSettings();
  }, [hydrateSettings]);

  useEffect(() => {
    trace('phase', phase, { pallet: currentPallet });
  }, [phase, currentPallet]);

  // SmartScanner hands us a fn to flash its rejection indicator: blue
  // "already counted" for a duplicate, red for a misread or a split clash.
  // Used when a manually-captured box is turned down after OCR.
  const dupFlashRef = useRef<((kind?: RejectKind) => void) | null>(null);
  // Checksum-refused digits seen so far (per page load): the third identical
  // capture is accepted as printed (lib/carton-barcode.ts).
  const refusedReadsRef = useRef<Map<string, number>>(new Map());
  const looseDupFlashRef = useRef<((kind?: RejectKind) => void) | null>(null);

  // ── Scan notices (lib/scan-notice.ts) ──
  // Plain functions over refs and state setters only, so the frozen-closure
  // detect handlers can call the first render's copies safely.

  /** Show a notice; it replaces any current one and clears itself. */
  function showScanNotice(notice: ScanNotice) {
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    setScanNotice(notice);
    noticeTimerRef.current = setTimeout(() => {
      noticeTimerRef.current = null;
      setScanNotice(null);
    }, SCAN_NOTICE_MS);
  }

  /** Take the notice down now: the worker did something that answers it. */
  function clearScanNotice() {
    if (noticeTimerRef.current) {
      clearTimeout(noticeTimerRef.current);
      noticeTimerRef.current = null;
    }
    setScanNotice(null);
  }

  /** Highlight the carton a notice names (its row rings and pulses blue). */
  function highlightRow(barcode: string) {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    setFlashBarcode(barcode);
    flashTimerRef.current = setTimeout(() => {
      flashTimerRef.current = null;
      setFlashBarcode(null);
    }, HIGHLIGHT_ROW_MS);
  }

  // A notice belongs to the screen it was raised on: a phase change (confirm,
  // next pallet, loose phase) takes it down, and starts the re-read ticks
  // afresh.
  useEffect(() => {
    if (noticeTimerRef.current) {
      clearTimeout(noticeTimerRef.current);
      noticeTimerRef.current = null;
    }
    setScanNotice(null);
    clearDuplicateSounds(dupSoundsRef.current);
  }, [phase]);

  useEffect(() => () => {
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
  }, []);

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
  // Minting a replacement carton sticker from inside the editor.
  const [mintingBarcode, setMintingBarcode] = useState(false);
  // Set only after a mint actually failed, which is what surfaces the
  // book-without-a-barcode escape. Hidden otherwise: it is a worse outcome
  // than a real sticker and should not be an equal-weight choice.
  const [mintFailed, setMintFailed] = useState(false);
  // Edit-a-scan: the box (by barcode) currently being edited + its in-flight
  // name/weight values. Null when no edit modal is open. Reset between pallets.
  const [editForm, setEditForm] = useState<
    {
      barcode: string;
      name_he: string;
      name_en: string;
      weight: string;
      expiry: string;
      /** Supplier batch/lot. Free text — OCR leaves it blank far more often
          than it fills it, so this is usually the only way it gets entered. */
      batch: string;
      /** The carton barcode's own reading, when it contradicts the OCR. */
      conflict?: BarcodeConflict;
      /**
       * This carton still has no identity (a manual capture whose printed
       * digits the OCR could not read). While true the panel asks for the
       * digits, and the box stays flagged until it has some answer.
       */
      unidentified: boolean;
      /** Digits the worker is typing for an unidentified carton. */
      barcodeInput: string;
      /**
       * Set when the worker has declared the carton has no readable barcode:
       * the NOBC- marker it will be booked under. Wins over `barcodeInput`.
       */
      forcedId?: string;
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
  // active-card expand state, and the next-pallet number the pallet_done
  // card's "Scan pallet N" button advances to.
  const sheetRef = useRef<BottomSheetHandle>(null);
  const looseSheetRef = useRef<BottomSheetHandle>(null);
  const drawer = useDrawerHost(token);
  const { toast, showToast, showLockToast } = useLockToast(tr('terminal.lockedToast'));
  const [showPallets, setShowPallets] = useState(false);
  // צור קרטון / מדבקות — mint and print a sticker for a carton that arrived
  // with none. Both are label-only: no stock is written here, the printed
  // sticker is scanned onto the pallet through the normal flow.
  const [showCartonCreator, setShowCartonCreator] = useState(false);
  // "All boxes identical" — the captured row the worker tapped it on, and
  // which phase's list it belongs to. See IdenticalBoxesForm. `anotherOf` is
  // the "Different carton?" link on an already-counted notice: the form then
  // saves a label for ONE more carton copied from carton #anotherOf, and the
  // counted carton stays on the list (the new row is added, not swapped in).
  const [identicalFor, setIdenticalFor] = useState<{ box: BoxScan; loose: boolean; anotherOf?: number } | null>(null);
  const [showLabels, setShowLabels] = useState(false);
  // Labels SAVED this session but not printed yet (identical / New carton /
  // edit-panel barcode). Server truth, refreshed after every save, print or
  // delete and whenever the tab comes back from the print sheet. Drives the
  // amber badge on the Labels chip and the marker on each unprinted row.
  const unprinted = useUnprintedLabels(token);
  const unprintedBarcodes = new Set(unprinted.labels.map((l) => l.barcode));
  // The print gate (lib/label-gate.ts): the unprinted labels that stop the
  // list in front of the worker from being booked — its own cartons' labels,
  // plus every New carton label. While it is non-empty the confirm slide
  // becomes an amber "Print N labels first", and the confirm handlers refuse.
  // The completion routes enforce the same rule with a 409; this is the UX.
  const labelGate = blockingLabels(
    unprinted.labels,
    (openListsForPhase(phase).loose ? looseBoxes : scannedBoxes).map((b) => b.barcode),
  );
  const [activeExpanded, setActiveExpanded] = useState(false);
  const [pendingNextPallet, setPendingNextPallet] = useState<number | null>(null);
  // "Scan pallet N" on the pallet_done card is a plain tap (moving on books
  // nothing — the server cursor already advanced inside multi-pallet-complete),
  // so it arms only 500 ms after the card appears: the tail of the confirm
  // slide that just booked the pallet must not land on it as a tap. Disarmed
  // again in the cleanup when the phase leaves pallet_done, so the next card
  // starts dimmed too.
  const [nextArmed, setNextArmed] = useState(false);
  useEffect(() => {
    if (phase !== 'pallet_done') return;
    const id = setTimeout(() => setNextArmed(true), 500);
    return () => {
      clearTimeout(id);
      setNextArmed(false);
    };
  }, [phase]);
  // The other half of a double-tap on "Scan pallet N": the card is gone by
  // the time the second tap lands, and at 360 px the button sits exactly over
  // the tool dock (Delete / Pallets / New carton …) of the scanning screen. A
  // transparent shield over that screen swallows taps for 400 ms after the
  // advance, so a double-tap does one thing.
  const [advanceShield, setAdvanceShield] = useState(false);
  useEffect(() => {
    if (!advanceShield) return;
    const id = setTimeout(() => setAdvanceShield(false), 400);
    return () => clearTimeout(id);
  }, [advanceShield]);

  // Device Back dismisses the full-screen image viewer instead of unloading
  // the scan session. The decision modals below (uniform count, force-confirm,
  // merge) deliberately do NOT register — they need an explicit answer, and a
  // stray Back press must not silently discard the worker's input.
  useBackClose(Boolean(viewingImage), () => setViewingImage(null));

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
        supplierPalletRef: supplierPalletRef || undefined,
      };
      savePalletScans(token, currentPallet, snap);
    } else if (phase === 'loose_scanning') {
      const snap: LooseScanSnapshot = { v: 1, looseBoxes: looseBoxes.map(stripImage) };
      saveLooseScans(token, snap);
    }
  }, [
    token, currentPallet, phase, scannedBoxes, looseBoxes, uniformGroups, supplierPalletRef,
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
              trace('ui', 'restored_from_cache', { pallet: mine.n, boxes: cached.scannedBoxes.length, confirmedBoxCount: cached.confirmedBoxCount, forcedMix: !!cached.forcedMix });
              setScannedBoxes(cached.scannedBoxes);
              setUniformGroups(new Map(cached.uniformGroups || []));
              setAcceptedMerges(new Map(cached.acceptedMerges || []));
              if (cached.confirmedBoxCount > 0) setConfirmedBoxCount(cached.confirmedBoxCount);
              if (cached.boxCountInput) setBoxCountInput(cached.boxCountInput);
              setForcedMix(!!cached.forcedMix);
          if (cached.supplierPalletRef) setSupplierPalletRef(cached.supplierPalletRef);
              if (cached.detectedType) setDetectedType(cached.detectedType);
              restoreUniformPrompt(cached);
              for (const code of dedupCodes(cached.scannedBoxes)) processedRef.current.add(code);
            }
            setPhase('scanning');
          } else if (data.loose?.owner === workerChatId && data.loose?.status === 'claimed') {
            // Resume: this worker already holds the loose-box task (either
            // pinned by the manager at plan time, or claimed before a reload).
            const cachedLoose = loadLooseScans<LooseScanSnapshot>(token);
            if (cachedLoose?.looseBoxes?.length) {
      trace('ui', 'restored_loose_from_cache', { boxes: cachedLoose.looseBoxes.length });
              setLooseBoxes(cachedLoose.looseBoxes);
              for (const code of dedupCodes(cachedLoose.looseBoxes)) looseProcessedRef.current.add(code);
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
      trace('ui', 'restored_loose_from_cache', { boxes: cachedLoose.looseBoxes.length });
            setLooseBoxes(cachedLoose.looseBoxes);
            for (const code of dedupCodes(cachedLoose.looseBoxes)) looseProcessedRef.current.add(code);
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
          trace('ui', 'restored_from_cache', { pallet: data.current_pallet, boxes: cached.scannedBoxes.length, confirmedBoxCount: cached.confirmedBoxCount, forcedMix: !!cached.forcedMix });
          setScannedBoxes(cached.scannedBoxes);
          setUniformGroups(new Map(cached.uniformGroups || []));
          setAcceptedMerges(new Map(cached.acceptedMerges || []));
          if (cached.confirmedBoxCount > 0) setConfirmedBoxCount(cached.confirmedBoxCount);
          if (cached.boxCountInput) setBoxCountInput(cached.boxCountInput);
          setForcedMix(!!cached.forcedMix);
          if (cached.supplierPalletRef) setSupplierPalletRef(cached.supplierPalletRef);
          if (cached.detectedType) setDetectedType(cached.detectedType);
          restoreUniformPrompt(cached);
          // Repopulate the dedup set so a re-scan of a restored sticker is caught.
          for (const code of dedupCodes(cached.scannedBoxes)) processedRef.current.add(code);
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
      trace('ui', 'restored_loose_from_cache', { boxes: cachedLoose.looseBoxes.length });
        setLooseBoxes(cachedLoose.looseBoxes);
        for (const code of dedupCodes(cachedLoose.looseBoxes)) looseProcessedRef.current.add(code);
      }
      setPhase('loose_scanning');
    }
  }, [phase, session, workerChatId, token]);

  // ── Barcode detected — SmartScanner passes the captured frame as imageData ──
  // The barcode IS on the sticker, so that frame is the sticker. Auto-OCR it.

  const handleBarcodeDetected = useCallback(
    (_barcode: string, _parsed: ParsedBarcode, imageData?: string) => {
      const read = _barcode.trim();
      // A read that cannot be a carton barcode (a fragment, a failed check
      // digit) is a misread: show the digits, store nothing (SCN-13).
      const verdict = classifyRead(read);
      trace('ui', 'scan_detected', { barcode: read, pallet: currentPalletRef.current, ok: verdict.ok, reason: verdict.ok ? undefined : verdict.reason, duplicate: processedRef.current.has(read), has_image: !!imageData });
      if (!verdict.ok) {
        if (verdict.reason === 'pallet_label') {
          // The supplier's shipping-pallet label: keep it as the pallet's
          // identity, never as a carton (MEV-10 — IN264172698 booked it as
          // a sixth carton). Neutral cue, no red hold.
          setSupplierPalletRef(read);
          showToast(t(sessionRef.current?.language || 'English', 'terminal.palletLabelRead', { digits: read }), 'local_shipping');
          return;
        }
        const acceptAnyway = verdict.reason === 'checksum' && noteRepeatedRead(refusedReadsRef.current, read);
        if (!acceptAnyway) {
          dupFlashRef.current?.('rejected');
          scanDuplicateFeedback();
          // Amber: one small action (scan it again), nothing failed for good.
          showScanNotice({
            text: t(sessionRef.current?.language || 'English',
              verdict.reason === 'too_short' ? 'terminal.barcodeTooShort' : 'terminal.barcodeMisread',
              { digits: read }),
            tone: 'warn',
          });
          return;
        }
        trace('ui', 'scan_accepted_as_printed', { barcode: read, pallet: currentPalletRef.current });
        showToast(t(sessionRef.current?.language || 'English', 'terminal.barcodeAcceptedAsPrinted', { digits: read }), 'check');
      }
      const barcode = read;
      if (processedRef.current.has(read)) {
        // Already on the list. Not an error — on a pallet scanned in place the
        // camera re-reads counted cartons all day — so it is a blue notice
        // that names the carton (SCN-21) and highlights its row, a soft tick
        // (once, not every 3 s while the camera rests on it), and nothing
        // red. "Different carton?" is the explicit way in for a physically
        // different carton whose label is byte-identical.
        const hit = findCountedCarton(scannedBoxesRef.current, read);
        if (shouldSoundDuplicate(dupSoundsRef.current, read, Date.now())) scanAlreadyCountedFeedback();
        showScanNotice({
          text: t(sessionRef.current?.language || 'English', 'terminal.alreadyCounted', { n: hit?.n ?? '?' }),
          tone: 'info',
          different: hit && canOfferDifferentCarton(read, hit.row)
            ? { box: { ...hit.row, barcode: read }, loose: false, n: hit.n }
            : undefined,
        });
        if (hit) highlightRow(hit.row.barcode);
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
        const clash = findDuplicateOwner(activeSession, read, currentPalletRef.current);
        if (clash) {
          const lang = activeSession.language || 'English';
          const who = (activeSession.roster ?? []).find((r) => r.chat_id === clash.owner)?.nickname
            || t(lang, 'split.anotherWorker');
          dupFlashRef.current?.('clash'); // red: another worker has this carton — act on it
          scanDuplicateFeedback();
          setError(t(lang, 'split.duplicateBox', { who, pallet: clash.pallet_n }));
          return; // the box is NOT added, NOT marked processed
        }
      }

      processedRef.current.add(barcode);
      scanSuccessFeedback(); // good scan — box added below
      setError(null); // clear any earlier rejection banner now that a scan succeeded
      clearScanNotice();

      // Barcode is an identifier only — extract first 13 digits as dedup key
      const digits = read.replace(/\D/g, '');
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
        // Archive the same frame. Done here rather than after OCR so a box
        // whose OCR fails — the one the worker will retype by hand, and the
        // one most worth having a picture of — still keeps its photo.
        archiveStickerPhoto(barcode, imageData, 'pallet');
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
    trace('ui', 'manual_capture', { provisional, pallet: currentPalletRef.current, image_chars: imageData.length });
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
    trace('ui', 'retry_ocr', { barcode });
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
    const released = dropPalletRows(new Set([barcode]));
    trace('ui', 'delete_box', { barcode, pallet: currentPallet, released: released.length ? released : undefined });
    discardSavedLabel(barcode);
  }

  // Take rows off the current pallet's list — one (the row's Delete) or a
  // whole label batch (Labels → Delete) — and re-group what is left. When the
  // last row standing in for a supplier code goes ("all boxes identical",
  // deleted row by row), that code leaves the dedup set too, so the sample
  // carton can be scanned again instead of reading as already scanned.
  // Returns the supplier codes it released.
  function dropPalletRows(gone: ReadonlySet<string>): string[] {
    const released = releasedSources(scannedBoxesRef.current, gone);
    setScannedBoxes((prev) => {
      const removed = prev.filter((b) => gone.has(b.barcode));
      const filtered = prev.filter((b) => !gone.has(b.barcode));
      setDetectedType(detectType(filtered, acceptedMerges));

      // If a removed box belonged to a locked uniform group and the group
      // would be left with fewer than 2 same-weight samples, drop the group
      // (worker can re-scan and re-prompt). Keyed on name, not on the
      // barcode-derived sku.
      const targetKeys = new Set(
        removed.map((b) => acceptedMerges.get(groupKeyForBox(b)) ?? groupKeyForBox(b)),
      );
      if (targetKeys.size > 0) {
        setUniformGroups((groups) => {
          let next = groups;
          for (const targetKey of targetKeys) {
            if (!next.has(targetKey)) continue;
            const remainingSamples = filtered.filter((b) => {
              const k = acceptedMerges.get(groupKeyForBox(b)) ?? groupKeyForBox(b);
              return k === targetKey && b.ocr_status === 'done';
            });
            if (remainingSamples.length < 2) {
              if (next === groups) next = new Map(groups);
              next.delete(targetKey);
            }
          }
          return next;
        });
        // Also clear a pending prompt that's about one of these items.
        setPendingUniformPrompt((p) => (p && targetKeys.has(p.name_key) ? null : p));
      }

      return filtered;
    });
    for (const code of gone) processedRef.current.delete(code);
    for (const code of released) processedRef.current.delete(code);
    // A delete answers any notice about the list, and a re-scan of the
    // carton just taken off must tick again, never be muted.
    clearDuplicateSounds(dupSoundsRef.current);
    clearScanNotice();
    return released;
  }

  // A deleted row's saved label goes with it while it is still unprinted —
  // otherwise it lingers in Labels as an orphan nobody can place (batch
  // 0877ca78). The server decides: only this session's labels, only status
  // 'created', never a New carton label (that one exists for itself; deleting
  // its scan row just un-scans the carton). A printed label stays, because
  // the sticker exists. Only warehouse-minted codes are ever sent.
  function discardSavedLabel(barcode: string | undefined) {
    if (!barcode || !isMintedLabelBarcode(barcode)) return;
    fetch(
      `/api/carton-labels?token=${encodeURIComponent(token)}&barcode=${encodeURIComponent(barcode)}`,
      { method: 'DELETE' },
    )
      .then(() => unprinted.refresh())
      .catch(() => { /* the label stays; Labels can still delete it */ });
  }

  // ── Sticker photo archive ──
  // The captured frame IS the sticker, and it is the only record of what was
  // actually printed on the box: the barcode carries no weight/name/expiry, so
  // every one of those values came from reading this picture. It used to be
  // handed to OCR and dropped, which left a weight dispute weeks later with
  // nothing to look at. Upload it in the background and keep the URL on the
  // box; the bot writes it to box_inventory.box_image_url (every bot insert
  // path already reads an `image_url` field — this is the missing sender).
  //
  // Deliberately fire-and-forget. A slow or failed upload must never hold up
  // scanning or block a pallet, and a box with no photo behaves exactly as it
  // did before this existed.
  const uploadedStickersRef = useRef<Set<string>>(new Set());

  function archiveStickerPhoto(
    barcode: string,
    imageData: string,
    target: 'pallet' | 'loose',
  ) {
    if (!barcode || !imageData) return;
    // Guards a retried OCR, a re-render, and StrictMode's double-invoked
    // updater — all three would otherwise upload the same frame twice.
    if (uploadedStickersRef.current.has(barcode)) return;
    uploadedStickersRef.current.add(barcode);

    fetch('/api/cloudinary/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image: imageData,
        barcode,
        document_number: sessionRef.current?.document_number,
        image_type: 'box',
      }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (!data?.success || !data.secure_url) throw new Error(data?.error || 'no url');
        const patch = (prev: BoxScan[]) =>
          prev.map((b) => (b.barcode === barcode ? { ...b, image_url: data.secure_url } : b));
        if (target === 'loose') setLooseBoxes(patch);
        else setScannedBoxes(patch);
      })
      .catch(() => {
        // Let a later retry try again rather than marking this frame done.
        uploadedStickersRef.current.delete(barcode);
      });
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
      body: JSON.stringify({ image: imageData, barcode: manual ? '' : lookupKey, candidates, token }),
    })
      .then((r) => r.json())
      .then((data) => {
        // A manual capture whose printed digits are a carton already on the
        // list: drop the provisional row and SAY so, naming the carton the
        // photo actually shows. Decided out here, not in the updater below (a
        // state updater may run twice under StrictMode — a doubled notice
        // and trace). It used to be dropped silently, while the footer kept
        // naming whatever carton an earlier re-read had (IN264172698: three
        // captures of #9 under a line blaming #8).
        if (manual && data?.success && data.ocr_data) {
          const digits = digitsOnly(data.ocr_data.barcode_digits);
          const hit = digits.length >= 13
            ? findCountedCartonByDigits(scannedBoxesRef.current, digits, lookupKey)
            : null;
          if (hit) {
            trace('ui', 'manual_capture_duplicate', { provisional: lookupKey, digits, of: hit.n });
            dupFlashRef.current?.('duplicate');
            scanAlreadyCountedFeedback();
            showScanNotice({
              text: t(sessionRef.current?.language || 'English', 'terminal.photoAlreadyCounted', { n: hit.n }),
              tone: 'info',
              different: canOfferDifferentCarton(digits, hit.row)
                ? { box: { ...hit.row, barcode: digits }, loose: false, n: hit.n }
                : undefined,
            });
            highlightRow(hit.row.barcode);
            setScannedBoxes((prev) => prev.filter((b) => b.barcode !== lookupKey));
            return;
          }
        }

        // Barcode-vs-OCR cross-check. Computed out here, not in the updater:
        // it depends only on the OCR result and the box's own barcode, and a
        // state updater may run twice (StrictMode) — which would double-toast.
        // For a manual capture the identity is the OCR'd digit string, which is
        // exactly what `resolvedBarcode` becomes inside the updater below.
        const conflict = data?.ocr_data
          ? findBarcodeConflict(
              manual ? digitsOnly(data.ocr_data.barcode_digits) : lookupKey,
              data.ocr_data.weight_kg,
              data.ocr_data.expiry_date,
            )
          : null;

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
              // The notice was raised above; this only catches a row the ref
              // had not caught up with yet, so a carton is never counted twice.
              const dup = prev.some((b, i) => i !== idx && digitsOnly(b.barcode) === digits);
              if (dup) {
                dupFlashRef.current?.('duplicate');
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
                  dupFlashRef.current?.('clash');
                  scanDuplicateFeedback();
                  setError(t(lang, 'split.duplicateBox', { who, pallet: clash.pallet_n }));
                  return prev.filter((_, i) => i !== idx); // drop the provisional box
                }
              }
              resolvedBarcode = digits;
              resolvedSku = digits.slice(0, 13);
              processedRef.current.add(digits); // so a later bar-scan of this sticker is caught
              setError(null); // clear any earlier rejection banner now that this box committed
              clearScanNotice();
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
              // Same sticker, same OCR call — these were read and thrown away
              // until 2026-09. Priority needs the production date to open its
              // batch, and the supplier's lot code for traceability/recall.
              production_date: data.ocr_data.production_date || '',
              supplier_batch: data.ocr_data.supplier_batch || '',
              needs_review: needsReview || undefined,
              barcode_conflict: conflict || undefined,
            };
          });
          setDetectedType(detectType(updated, acceptedMerges));
          // Check if the box that just finished OCR triggers a uniform-pair prompt.
          maybeTriggerUniformPrompt(updated, resolvedBarcode);
          // Manual capture had no decoded barcode at scan time, so this is the
          // first moment the photo can be filed under the box's real identity.
          // (Bar-scanned boxes already uploaded at detection; the ref guard
          // makes a second call here a no-op either way.)
          if (manual) archiveStickerPhoto(resolvedBarcode, imageData, 'pallet');
          return updated;
        });

        // Warn, don't block: the worker is still holding the carton, and the
        // barcode has been right in every disagreement we have measured — but
        // three cases is not a licence to overrule the label automatically.
        if (conflict) {
          const label = (data.ocr_data.product_name_hebrew
            || data.ocr_data.product_name_english || '').trim();
          showToast(
            conflict.weight
              ? tr('palletVerify.barcodeConflictWeight', {
                  item: label, bc: conflict.weight.barcode.toFixed(2),
                  ocr: conflict.weight.ocr.toFixed(2),
                })
              : tr('palletVerify.barcodeConflictExpiry', {
                  item: label, bc: isoToDdmmyyyyShort(conflict.expiry!.barcode),
                  ocr: isoToDdmmyyyyShort(conflict.expiry!.ocr),
                }),
            'report_problem', '#fbbf5c',
          );
        }
      })
      .catch(() => {
        setScannedBoxes((prev) => {
          const idx = prev.findIndex((b) => b.barcode === lookupKey);
          if (idx === -1) return prev;
          return prev.map((b, i) => (i === idx ? { ...b, ocr_status: 'failed' } : b));
        });
      });
  }

  // Does the current scan set look like ONE product whose boxes all weigh the
  // same? That is the only configuration where the worker may scan a couple of
  // samples and declare the total instead of scanning every box — the domain
  // rule being that a single item on a pallet is either all-same-weight or
  // all-different-weights. Returns the group description, or null.
  //
  // "Same weight" means EXACTLY equal (UNIFORM_WEIGHT_TOLERANCE is 0.1 g, not
  // the 0.5 kg the older docs claim). Catch-weight meat differs box to box, so
  // it never qualifies — and it must not, because every catch-weight box's own
  // weight is what goes to box_inventory for FEFO on the way out.
  function uniformCandidateFrom(
    done: BoxScan[],
    merges: Map<string, string> = acceptedMerges,
  ): Omit<UniformPrompt, 'mode'> | null {
    if (done.length < UNIFORM_MIN_SAMPLES) return null;
    // Minted rows already carry their exact count — nothing to multiply.
    if (done.some((b) => b.minted)) return null;
    const keyOf = (b: BoxScan) => merges.get(groupKeyForBox(b)) ?? groupKeyForBox(b);
    const distinct = new Set(done.map(keyOf));
    if (distinct.size !== 1) return null;            // multiple products -> mix path
    const ws = done.map((b) => b.weight);
    if (Math.max(...ws) - Math.min(...ws) >= UNIFORM_WEIGHT_TOLERANCE) return null; // varies -> mix
    const sample = done[0];
    const avg = ws.reduce((a, b) => a + b, 0) / ws.length;
    return {
      name_key: keyOf(sample),
      item_name: sample.item_name || '',
      item_name_hebrew: sample.item_name_hebrew || '',
      avg_weight: Math.round(avg * 1000) / 1000,
      sample_barcodes: done.map((b) => b.barcode),
    };
  }

  // The prompt is raised by the OCR success path, so scans restored from the
  // localStorage cache (reload, phone sleep, tab switch) would arrive with no
  // prompt at all — pushing a pallet that qualifies for the shortcut onto the
  // scan-every-box path instead. Re-derive it from the cached snapshot, using
  // the cached flags rather than the refs, which useEffect has not synced yet.
  function restoreUniformPrompt(cached: PalletScanSnapshot) {
    if (cached.forcedMix) return;                       // worker already said mix
    if ((cached.uniformGroups || []).length > 0) return; // single already locked in
    if (cached.confirmedBoxCount > 0) return;            // total already declared
    const boxes = cached.scannedBoxes || [];
    if (boxes.some((b) => b.ocr_status === 'processing')) return;
    const done = boxes.filter(
      (b) => b.ocr_status === 'done' && b.weight > 0 && (b.item_name || b.item_name_hebrew),
    );
    const candidate = uniformCandidateFrom(done, new Map(cached.acceptedMerges || []));
    if (candidate) setPendingUniformPrompt({ mode: 'single_or_mix', ...candidate });
  }

  // Classify the pallet once UNIFORM_MIN_SAMPLES boxes have finished OCR (and
  // none are still processing). Only the single-uniform case raises the
  // single-vs-mix choice. Variable-weight or multi-product pallets raise NO
  // prompt — they fall through to the pallet-total input (mix path).
  function maybeTriggerUniformPrompt(latestBoxes: BoxScan[], _justFinishedBarcode: string) {
    if (forcedMixRef.current) return;                // worker already said it's mix
    if (uniformGroupsRef.current.size > 0) return;   // single already locked in
    const done = latestBoxes.filter(
      (b) => b.ocr_status === 'done' && b.weight > 0 && (b.item_name || b.item_name_hebrew),
    );
    if (latestBoxes.some((b) => b.ocr_status === 'processing')) return;
    const candidate = uniformCandidateFrom(done);
    if (pendingUniformPromptRef.current) {
      // Prompting from two samples means a later box can invalidate the
      // question while it is still on screen (a second product, or a box that
      // weighs something else). Retract it rather than let the worker answer
      // "only this product?" about a pallet that has since become a mix.
      if (!candidate) setPendingUniformPrompt(null);
      return;
    }
    if (!candidate) return;
    setPendingUniformPrompt({ mode: 'single_or_mix', ...candidate });
  }

  // ── Loose box barcode detected ──

  const handleLooseBarcodeDetected = useCallback(
    (_barcode: string, _parsed: ParsedBarcode, imageData?: string) => {
      const read = _barcode.trim();
      const verdict = classifyRead(read);
      trace('ui', 'loose_scan_detected', { barcode: read, ok: verdict.ok, reason: verdict.ok ? undefined : verdict.reason, duplicate: looseProcessedRef.current.has(read), has_image: !!imageData });
      if (!verdict.ok) {
        if (verdict.reason === 'pallet_label') {
          showToast(t(sessionRef.current?.language || 'English', 'terminal.palletLabelRead', { digits: read }), 'local_shipping');
          return;
        }
        const acceptAnyway = verdict.reason === 'checksum' && noteRepeatedRead(refusedReadsRef.current, read);
        if (!acceptAnyway) {
          looseDupFlashRef.current?.('rejected');
          scanDuplicateFeedback();
          showScanNotice({
            text: t(sessionRef.current?.language || 'English',
              verdict.reason === 'too_short' ? 'terminal.barcodeTooShort' : 'terminal.barcodeMisread',
              { digits: read }),
            tone: 'warn',
          });
          return;
        }
        trace('ui', 'loose_scan_accepted_as_printed', { barcode: read });
        showToast(t(sessionRef.current?.language || 'English', 'terminal.barcodeAcceptedAsPrinted', { digits: read }), 'check');
      }
      const barcode = read;
      if (looseProcessedRef.current.has(read)) {
        // Already on the loose list — same blue notice as the pallet phase.
        const hit = findCountedCarton(looseBoxesRef.current, read);
        if (shouldSoundDuplicate(dupSoundsRef.current, read, Date.now())) scanAlreadyCountedFeedback();
        showScanNotice({
          text: t(sessionRef.current?.language || 'English', 'terminal.alreadyCounted', { n: hit?.n ?? '?' }),
          tone: 'info',
          different: hit && canOfferDifferentCarton(read, hit.row)
            ? { box: { ...hit.row, barcode: read }, loose: true, n: hit.n }
            : undefined,
        });
        if (hit) highlightRow(hit.row.barcode);
        return;
      }
      looseProcessedRef.current.add(barcode);
      scanSuccessFeedback(); // good scan — box added below
      setError(null);
      clearScanNotice();
      const digits = read.replace(/\D/g, '');
      const sku = digits.length >= 13 ? digits.slice(0, 13) : digits || barcode;
      const box: BoxScan = {
        barcode, sku, item_name: '', item_name_hebrew: '',
        weight: 0, expiry: '', scanned_at: new Date().toISOString(),
        ocr_status: 'processing',
        image_data: imageData,
      };
      setLooseBoxes((prev) => [...prev, box]);
      if (imageData) {
        runLooseOcr(barcode, imageData);
        archiveStickerPhoto(barcode, imageData, 'loose');
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  // Manual capture for the loose phase — same fallback as the pallet phase.
  const handleLooseManualCapture = useCallback((imageData: string) => {
    const provisional = `MANUAL-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    trace('ui', 'loose_manual_capture', { provisional, image_chars: imageData.length });
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
    trace('ui', 'loose_retry_ocr', { barcode });
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
    // Same release rule as dropPalletRows: the last row of an identical batch
    // frees its supplier code.
    const released = releasedSources(looseBoxesRef.current, new Set([barcode]));
    trace('ui', 'loose_delete_box', { barcode, released: released.length ? released : undefined });
    setLooseBoxes((prev) => prev.filter((b) => b.barcode !== barcode));
    looseProcessedRef.current.delete(barcode);
    for (const code of released) looseProcessedRef.current.delete(code);
    clearDuplicateSounds(dupSoundsRef.current);
    clearScanNotice();
    discardSavedLabel(barcode);
  }

  // ── Uniform-prompt action handlers ──

  // "Complete as single-item" path: capture the group and surface the
  // pallet box-count input in the footer. Locking + auto-confirm happens
  // on count submit (handlePalletCountSubmit). Box count is unknown at
  // this moment in the new deferred-count flow.
  function handleCompleteAsSingle() {
    const p = pendingUniformPrompt;
    trace('ui', 'complete_as_single', { pallet: currentPallet, prompt: p });
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
    trace('ui', 'cancel_single_confirm', { pallet: currentPallet });
    setPendingSingleGroup(null);
    setBoxCountInput('');
    setPalletCountError(null);
  }

  function handleContinueAsMix() {
    trace('ui', 'continue_as_mix', { pallet: currentPallet, scanned: scannedBoxes.length });
    setForcedMix(true);            // pallet is mix → show pallet-total input, scan all
    setPendingUniformPrompt(null);
  }

  // ── Edit a scan (name + weight) ──

  // Open the edit modal pre-filled from the box's current values. `isLoose`
  // tells handleSaveEdit which collection (scannedBoxes vs looseBoxes) the
  // box lives in — the modal itself is shared between both phases.
  function openEdit(box: BoxScan, isLoose = false) {
    trace('ui', 'edit_open', { barcode: box.barcode, isLoose, name_he: box.item_name_hebrew, weight: box.weight, expiry: box.expiry });
    setSelectedBarcode(null);
    setMintingBarcode(false);
    setMintFailed(false);
    setError(null);
    clearScanNotice();
    setEditForm({
      barcode: box.barcode,
      name_he: box.item_name_hebrew || '',
      name_en: box.item_name || '',
      weight: box.weight > 0 ? String(box.weight) : '',
      // Always ISO in the editor, whatever an older row carries — see lib/expiry.ts.
      expiry: normalizeExpiry(box.expiry),
      batch: box.supplier_batch || '',
      conflict: box.barcode_conflict,
      image_data: box.image_data,
      isLoose,
      unidentified: isProvisional(box.barcode),
      barcodeInput: '',
    });
  }

  // Apply the edit: update the box, then re-group exactly like rescanPalletBox —
  // changing the name moves the box's group key, so recompute detectedType and
  // drop any uniform group / pending prompt that no longer has ≥2 done samples.
  // Loose-phase edits skip the regrouping (loose has no uniform groups) and
  // just patch the looseBoxes row.
  // Minting a real sticker for a carton whose printed barcode is destroyed.
  // This is the SAME warehouse-minted label the "New carton" screen creates —
  // `28` + YYMMDD + 8 digits, a GS1 internal prefix that can never collide with
  // a supplier GTIN and is plain digits, so the outbound box-sticker gateway
  // reads it like any other carton code. The worker prints it from Labels and
  // puts it on the box, and from then on that carton behaves normally.
  //
  // Preferred over booking the box with no code at all: this one can actually
  // be scanned again on the way out.
  async function handleCreateBarcode() {
    if (!editForm || mintingBarcode) return;
    trace('ui', 'create_barcode', { barcode: editForm.barcode, isLoose: editForm.isLoose });
    const nameHe = editForm.name_he.trim();
    const nameEn = editForm.name_en.trim();
    if (!nameHe && !nameEn) {
      // The label has to say what it is. Send them to the name field rather
      // than minting a sticker that identifies nothing.
      setError(t(session?.language || 'English', 'terminal.barcodeNeedName'));
      return;
    }
    setMintingBarcode(true);
    setError(null);
    try {
      const list = editForm.isLoose ? looseBoxes : scannedBoxes;
      const box = list.find((b) => b.barcode === editForm.barcode);
      const res = await fetch('/api/carton-labels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          quantity: 1,
          // Booked on THIS row (not label-only like New carton), and saved
          // unprinted — it is printed from Labels with the rest.
          origin: 'receiving',
          pallet_number: editForm.isLoose ? 0 : currentPallet,
          item_name_hebrew: nameHe || null,
          item_name_english: nameEn || null,
          weight_kg: parseFloat(editForm.weight) > 0 ? parseFloat(editForm.weight) : null,
          production_date: box?.production_date || null,
          expiry_date: toIsoDate(editForm.expiry) || null,
          notes: 'Minted in receiving: the carton\'s printed barcode could not be read.',
          label_size: '10x15',
          print_barcode: true,
        }),
      });
      const data = await res.json();
      const minted: string | undefined = data?.labels?.[0]?.barcode;
      if (!res.ok || !minted) throw new Error(data?.error || 'mint failed');
      setEditForm((f) => (f ? { ...f, forcedId: minted, unidentified: false, barcodeInput: '' } : f));
      unprinted.refresh();
      showToast(tr('terminal.barcodeMinted', { code: minted }), 'label');
    } catch {
      // Never strand the worker on a failed network call — offer the
      // book-without-a-barcode route instead, as a second, explicit tap.
      setMintFailed(true);
      setError(t(session?.language || 'English', 'terminal.barcodeMintFailed'));
    } finally {
      setMintingBarcode(false);
    }
  }

  // "There is no readable barcode on this carton." The last resort: without
  // it a destroyed label would strand the pallet, which is the failure this
  // whole manual path exists to prevent. It books the carton under a marker
  // that is deliberately not barcode-shaped, so the row is real stock, is
  // greppable, and can never be confused with a scannable code. Such a carton
  // can still be issued via its pallet LPN — only the box-sticker route needs
  // a barcode, and that route is impossible for it anyway.
  function handleNoBarcode() {
    if (!editForm) return;
    trace('ui', 'no_barcode', { barcode: editForm.barcode, isLoose: editForm.isLoose });
    const list = editForm.isLoose ? looseBoxes : scannedBoxes;
    const n = list.findIndex((b) => b.barcode === editForm.barcode) + 1;
    setEditForm({
      ...editForm,
      forcedId: noBarcodeId(session?.document_number || '', currentPallet, n || list.length + 1),
      unidentified: false,
      barcodeInput: '',
    });
  }

  function handleSaveEdit() {
    if (!editForm) return;
    const { barcode, name_he, name_en, isLoose } = editForm;
    // Stored as ISO: a DD/MM/YYYY here reached the bot as box_expiry NULL.
    const expiry = normalizeExpiry(editForm.expiry);
    const batch = editForm.batch.trim();
    const w = parseFloat(editForm.weight);
    trace('ui', 'edit_save', { barcode, isLoose, name_he, name_en, weight: w, expiry, batch, barcodeInput: editForm.barcodeInput, forcedId: editForm.forcedId, unidentified: editForm.unidentified });
    clearScanNotice();

    // ── Identity for a manual capture ──
    // `resolvedId` is what this row's barcode BECOMES. For an already-identified
    // carton that is its existing barcode; for one the worker just typed digits
    // for it is those digits; for one they declared unreadable it is the
    // NOBC- marker set by handleNoBarcode (which leaves `unidentified` false).
    let resolvedId = barcode;
    if (editForm.forcedId) {
      resolvedId = editForm.forcedId;
    } else if (editForm.unidentified) {
      const typed = digitsOnly(editForm.barcodeInput);
      if (typed.length >= MIN_BARCODE_DIGITS) {
        // Same rule the scanned path uses: the FULL printed number identifies a
        // carton, not the 13-digit SKU, which repeats across every box of one
        // product. A clash here is the worker typing the sticker they already
        // captured, so refuse rather than silently create a second row.
        const others = (isLoose ? looseBoxes : scannedBoxes).filter((b) => b.barcode !== barcode);
        if (others.some((b) => digitsOnly(b.barcode) === typed)) {
          setError(t(session?.language || 'English', 'terminal.barcodeDuplicate'));
          return;
        }
        resolvedId = typed;
      } else if (editForm.barcodeInput.trim()) {
        // Started typing but stopped short — that is a slip, not a decision.
        setError(
          t(session?.language || 'English', 'terminal.barcodeDigitsCount', {
            n: typed.length,
          }),
        );
        return;
      }
      // Nothing typed at all: leave the placeholder for now. The box keeps its
      // warning, and the footer will bring the worker straight back here.
    }
    const stillUnidentified = isProvisional(resolvedId);

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
        barcode: resolvedId,
        // The SKU is the item prefix. Only re-derive it from a real typed
        // barcode — a NOBC- marker carries no item information, and
        // overwriting a scanned box's sku here would be a regression.
        sku: resolvedId !== barcode && /^\d{13,}$/.test(resolvedId)
          ? resolvedId.slice(0, 13)
          : b.sku,
        ocr_status: 'done' as OcrStatus,
        item_name: name_en,
        item_name_hebrew: name_he,
        weight: newWeight,
        expiry,
        supplier_batch: batch,
        // An identity is part of "resolved". A carton still carrying its
        // placeholder stays flagged however good its name and weight are —
        // otherwise Save quietly books an unmatchable row, which is exactly
        // what it used to do.
        needs_review: hasName && hasWeight && !stillUnidentified ? undefined : true,
        // The worker has now looked at both readings and chosen. Whatever they
        // chose is the answer — don't keep flagging it.
        barcode_conflict: undefined,
      };
    }

    // Keep the dedup sets in step: the old placeholder can never come back,
    // and a freshly typed barcode must now be caught if the same sticker is
    // scanned later.
    if (resolvedId !== barcode) {
      const set = isLoose ? looseProcessedRef.current : processedRef.current;
      set.delete(barcode);
      set.add(resolvedId);
      setSelectedBarcode((cur) => (cur === barcode ? resolvedId : cur));
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
  // ── "All boxes identical" → N minted rows ──
  //
  // The batch already exists in carton_labels (the overlay POSTed it). Here
  // the sample row becomes one row per minted barcode in the SAME list the
  // sample sat in, so the completion routes and the bot see N ordinary
  // scanned boxes. The minted codes join the dedup set: scanning a printed
  // sticker back in during this job is a duplicate (that box is on the list),
  // and the supplier code stays in the set too — the worker said every carton
  // carries it, so a further read of it adds nothing.
  function handleIdenticalCreated(
    target: { box: BoxScan; loose: boolean; anotherOf?: number },
    labels: CartonLabel[],
    form: IdenticalForm,
  ) {
    trace('ui', 'identical_created', { barcode: target.box.barcode, loose: target.loose, labels: labels.length, form, another_of: target.anotherOf });
    const rows: BoxScan[] = expandIdenticalBoxes(
      target.box,
      labels.map((l) => ({ barcode: l.barcode, batch_id: l.batch_id })),
      form,
    );
    const replaceSample = (prev: BoxScan[]): BoxScan[] => {
      // "Different carton?": the carton it was copied from is a counted
      // carton of its own and stays; the new one joins the end of the list.
      if (target.anotherOf) return [...prev, ...rows];
      const idx = prev.findIndex((b) => b.barcode === target.box.barcode);
      return idx === -1 ? [...prev, ...rows] : [...prev.slice(0, idx), ...rows, ...prev.slice(idx + 1)];
    };
    if (target.loose) {
      for (const r of rows) looseProcessedRef.current.add(r.barcode);
      setLooseBoxes(replaceSample);
    } else {
      for (const r of rows) processedRef.current.add(r.barcode);
      const next = replaceSample(scannedBoxes);
      setScannedBoxes(next);
      setDetectedType(detectType(next, acceptedMerges));
      // A single-vs-mix question raised by the sample is moot now (retracts).
      maybeTriggerUniformPrompt(next, '');
      // The pallet total is usually just what is on the list now — offer it,
      // still editable, instead of making the worker retype the count.
      if (confirmedBoxCount === 0 && !boxCountInput) {
        setBoxCountInput(String(listTotal(next)));
      }
    }
    setSelectedBarcode(null);
    // Saved, not printed: straight back to the scanner. The labels wait in
    // Labels (amber badge) until the worker prints them — any time before
    // this pallet is closed.
    setIdenticalFor(null);
    unprinted.refresh();
    trace('ui', 'labels_saved', {
      origin: 'identical', count: rows.length, batch_id: labels[0]?.batch_id, pallet: target.loose ? 0 : currentPallet,
      another_of: target.anotherOf,
    });
    showToast(rows.length === 1 ? tr('identical.savedOne') : tr('identical.saved', { count: rows.length }), 'save');
  }

  /**
   * "Different carton?" on an already-counted notice. The worker says the
   * carton in hand is NOT the counted one, only labelled identically: open
   * the identical form on the counted carton's data with a count of 1. It
   * saves a warehouse label of its own (unprinted, so the print gate holds
   * the LPN until it is stuck on). An explicit tap — never automatic.
   */
  function openDifferentCarton(d: NonNullable<ScanNotice['different']>) {
    trace('ui', 'different_carton_open', { barcode: d.box.barcode, of: d.n, loose: d.loose });
    clearScanNotice();
    setSelectedBarcode(null);
    setIdenticalFor({ box: d.box, loose: d.loose, anotherOf: d.n });
  }

  /** What the pallet-total input offers for this list: one per listed box,
   *  except locked single-item groups, which count their declared total. */
  function listTotal(boxes: BoxScan[]): number {
    let total = 0;
    for (const b of boxes) {
      const k = acceptedMerges.get(groupKeyForBox(b)) ?? groupKeyForBox(b);
      if (!uniformGroups.has(k)) total += 1;
    }
    for (const g of uniformGroups.values()) total += g.total_count;
    return total;
  }

  // Labels → Delete removed a whole batch. Rows it stood for that are still
  // on an OPEN list go too (the confirm said so): they would otherwise be
  // booked under barcodes the ledger no longer knows. A list already booked
  // (the last pallet's rows after its LPN, the loose rows after they were
  // sent) is left alone — those rows are on an LPN, not on a list. The
  // supplier code an identical batch replaced is released, so the sample
  // carton can be scanned again; and a pallet total that was just our own
  // offer follows the list down.
  function handleLabelBatchDeleted(batchId: string, barcodes: string[], sourceBarcode: string | null) {
    const gone = new Set(barcodes);
    if (gone.size === 0) return;
    const open = openListsForPhase(phase);
    const pallet = scannedBoxesRef.current;
    const loose = looseBoxesRef.current;
    const palletHit = open.pallet && pallet.some((b) => gone.has(b.barcode));
    const looseHit = open.loose && loose.some((b) => gone.has(b.barcode));
    if (!palletHit && !looseHit) return;
    trace('ui', 'labels_batch_rows_dropped', { batch_id: batchId, count: gone.size, pallet: palletHit ? currentPallet : undefined, loose: looseHit });
    if (palletHit) {
      const next = pallet.filter((b) => !gone.has(b.barcode));
      const before = String(listTotal(pallet));
      const after = listTotal(next);
      dropPalletRows(gone);
      // Rows cached before they carried source_barcode: the server's word.
      if (sourceBarcode && !sourceStillListed(next, sourceBarcode)) {
        processedRef.current.delete(sourceBarcode);
      }
      if (confirmedBoxCount === 0) {
        setBoxCountInput((cur) => (cur === before ? (after > 0 ? String(after) : '') : cur));
      }
    }
    if (looseHit) {
      const next = loose.filter((b) => !gone.has(b.barcode));
      const released = releasedSources(loose, gone);
      setLooseBoxes((prev) => prev.filter((b) => !gone.has(b.barcode)));
      for (const code of gone) looseProcessedRef.current.delete(code);
      for (const code of released) looseProcessedRef.current.delete(code);
      clearDuplicateSounds(dupSoundsRef.current);
      clearScanNotice();
      if (sourceBarcode && !sourceStillListed(next, sourceBarcode)) {
        looseProcessedRef.current.delete(sourceBarcode);
      }
    }
    setSelectedBarcode(null);
  }

  /** The action is offered on a captured row with a real supplier barcode
   *  that is not itself minted and not still in OCR. */
  function canDeclareIdentical(box: BoxScan): boolean {
    return box.ocr_status !== 'processing' && !box.minted
      && !isProvisional(box.barcode) && !box.barcode.startsWith(NO_BARCODE_PREFIX);
  }

  function buildDockChips(opts: { gap: () => void }): ToolChip[] {
    return [
      {
        id: 'create', icon: 'add', label: tr('terminal.toolCreateCarton'), tint: 'blue', iconColor: '#33b1f0',
        onPress: () => setShowCartonCreator(true),
      },
      {
        // Amber + count while saved labels wait for the printer.
        id: 'labels', icon: 'label', label: tr('terminal.toolLabels'),
        tint: unprinted.labels.length > 0 ? 'amber' : 'neutral',
        iconColor: unprinted.labels.length > 0 ? '#fbbf5c' : undefined,
        badge: unprinted.labels.length,
        onPress: () => setShowLabels(true),
      },
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

  // צור קרטון + מדבקות overlays. Rendered next to `palletsBrowser` at every
  // phase return so they stay reachable from the dock in each phase.
  const looseCartonPhase = phase === 'loose_scanning' || phase === 'loose_confirming';
  // Where each row on the OPEN lists sits — Labels uses it to warn that
  // deleting a batch also takes its boxes off the list. Rows already booked
  // (they linger in state into pallet_done, the loose phase and all_done)
  // are not on a list any more, so they never appear in that warning.
  const liveLabelRows = () =>
    liveRowPlaces({ phase, currentPallet, pallet: scannedBoxes, loose: looseBoxes });
  const cartonOverlays = (
    <>
      {showCartonCreator && (
        <CartonCreator
          token={token}
          items={session?.ocr_data ?? []}
          palletNumber={looseCartonPhase ? 0 : currentPallet}
          onBack={() => setShowCartonCreator(false)}
          onCreated={(count, batchId) => {
            // Saved only — back to the scanner, no Labels screen. The worker
            // prints from Labels (amber badge), then scans each carton.
            setShowCartonCreator(false);
            unprinted.refresh();
            trace('ui', 'labels_saved', {
              origin: 'new_carton', count, batch_id: batchId, pallet: looseCartonPhase ? 0 : currentPallet,
            });
            showToast(tr('carton.saved', { count }), 'save');
          }}
        />
      )}
      {showLabels && (
        <LabelsBrowser
          token={token}
          onBack={() => { setShowLabels(false); unprinted.refresh(); }}
          initialStatus={unprinted.labels.length > 0 ? 'created' : 'all'}
          onChanged={unprinted.refresh}
          liveRows={liveLabelRows()}
          onBatchDeleted={handleLabelBatchDeleted}
        />
      )}
      {identicalFor && (
        <IdenticalBoxesForm
          token={token}
          palletNumber={identicalFor.loose ? 0 : currentPallet}
          sample={{
            barcode: identicalFor.box.barcode,
            item_code: matchInvoiceItem(
              identicalFor.box.item_name_hebrew, identicalFor.box.item_name, session?.ocr_data,
            )?.item_code ?? null,
            item_name: identicalFor.box.item_name || '',
            item_name_hebrew: identicalFor.box.item_name_hebrew || '',
            weight: identicalFor.box.weight,
            expiry: identicalFor.box.expiry || '',
            production_date: identicalFor.box.production_date || '',
          }}
          anotherOf={identicalFor.anotherOf}
          onBack={() => setIdenticalFor(null)}
          onCreated={(labels, form) => handleIdenticalCreated(identicalFor, labels, form)}
        />
      )}
    </>
  );

  // The print gate's footer, in place of the confirm slide (or the "Create
  // LPN anyway" button) while saved labels block the list (`labelGate`).
  // Amber = needs attention, never red: nothing failed. One tap opens the
  // print sheet for exactly the blocking batches; the link opens Labels on
  // "Not printed" to print some, mark them printed or delete unneeded ones.
  const labelGateFooter = (loose: boolean) => (
    <div className="space-y-2">
      <p className="flex items-start gap-1.5 text-[11px] font-bold leading-snug text-warn-weak-ink">
        <MI name="print_disabled" size={15} className="shrink-0 mt-px" />
        <span className="min-w-0">{tr(loose ? 'labels.gateHintLoose' : 'labels.gateHint')}</span>
      </p>
      <button
        onClick={handlePrintBlockingLabels}
        disabled={phase === 'confirming' || phase === 'loose_confirming'}
        className="flex items-center justify-center gap-[6px] w-full py-3 rounded-[13px] font-black text-[14px] bg-warn text-canvas disabled:bg-sunken disabled:text-ink-muted"
      >
        <MI name="print" size={18} />
        {labelGate.count === 1 ? tr('labels.gateButtonOne') : tr('labels.gateButton', { count: labelGate.count })}
      </button>
      <button
        onClick={() => {
          trace('ui', 'labels_gate_open_list', { count: labelGate.count });
          setShowLabels(true);
        }}
        className="flex items-center justify-center gap-1 w-full py-1 text-xs font-extrabold text-warn-weak-ink underline"
      >
        <MI name="label" size={14} /> {tr('labels.gateOpenList')}
      </button>
    </div>
  );

  // The footer's error line, shared by both scan phases. Red = something
  // failed and the worker must act: persistent, `error`, role=alert.
  const footerError = error ? (
    <p role="alert" className="flex items-start justify-center gap-1 text-danger-weak-ink text-sm text-center mb-2">
      <MI name="error" size={16} className="shrink-0 mt-[2px]" />
      <span className="min-w-0">{error}</span>
    </p>
  ) : null;

  // The current scan notice — blue "already counted" (nothing to do) or
  // amber "misread, scan again" — floating at the top of the camera, next to
  // the hold that just lit up, and gone after SCAN_NOTICE_MS. Deliberately
  // NOT in the sheet footer: the footer sets the sheet's mid height, and on a
  // 360x641 phone the count input plus one more line no longer fits the room
  // BottomSheet leaves above the camera — it hides the whole footer (the
  // input with it) and, measuring a hidden footer as 0, never brings it back.
  // Up here a notice moves nothing. `--sheet-w` keeps it off a tablet's side
  // panel. It swallows taps (no capture under it); the link is the action.
  const scanNoticeBanner = scanNotice ? (
    <div
      className="absolute top-2 z-[35] flex justify-center pointer-events-none"
      style={{ insetInlineStart: 12, insetInlineEnd: 'calc(var(--sheet-w, 0px) + 12px)' }}
    >
      <p
        role="status"
        className={`pointer-events-auto max-w-[420px] rounded-[12px] border-2 px-3 py-[7px] text-xs font-bold leading-[1.45] text-center shadow-[0_10px_28px_rgba(0,0,0,.6)] animate-fadeIn ${
          scanNotice.tone === 'info'
            ? 'bg-overlay-card border-brand text-brand-weak-ink'
            : 'bg-amber-card border-warn/70 text-warn-weak-ink'
        }`}
      >
        <MI
          name={scanNotice.tone === 'info' ? 'done_all' : 'report_problem'}
          size={15}
          className="align-[-3px] me-1"
        />
        {scanNotice.text}
        {scanNotice.different && (
          <button
            type="button"
            onClick={() => openDifferentCarton(scanNotice.different!)}
            className="inline-flex items-center gap-[3px] ms-1.5 -my-1 px-1 py-1 font-black whitespace-nowrap"
          >
            <MI name="new_label" size={15} />
            <span className="underline underline-offset-2">{tr('terminal.differentCarton')}</span>
          </button>
        )}
      </p>
    </div>
  ) : null;

  // Full-screen captured-image viewer (used for OCR-failed Diagnostics).
  // fixed/inset-0 means it overlays whatever phase is currently rendering.
  const imageModal = viewingImage ? (
    <div
      onClick={() => setViewingImage(null)}
      className="fixed inset-0 z-[90] bg-black/90 flex items-center justify-center p-4"
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

  // Edit-a-scan. Rendered as a FULL-SCREEN overlay (not inside the bottom
  // sheet, where it used to live): the worker opens this because the OCR
  // misread the sticker, so they have to read the sticker and type at the same
  // time, and inside the sheet — under a live camera — the photo could only
  // ever be a thumbnail. Taking the screen also lets the camera pause, so
  // nothing gets scanned into the pallet while they are typing.
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
      barcode={editForm.forcedId || editForm.barcode}
      barcodeEditable={editForm.unidentified}
      barcodeInput={editForm.barcodeInput}
      onBarcodeChange={(v) => { setEditForm({ ...editForm, barcodeInput: v }); setError(null); }}
      onCreateBarcode={handleCreateBarcode}
      minting={mintingBarcode}
      onNoBarcode={handleNoBarcode}
      showNoBarcode={mintFailed}
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
      batch={editForm.batch}
      onBatchChange={(v) => setEditForm({ ...editForm, batch: v })}
      barcodeWeight={editForm.conflict?.weight?.barcode.toFixed(2)}
      barcodeExpiry={
        editForm.conflict?.expiry
          ? isoToDdmmyyyyShort(editForm.conflict.expiry.barcode)
          : undefined
      }
      onUseBarcodeWeight={
        editForm.conflict?.weight
          ? () => setEditForm({
              ...editForm,
              weight: String(editForm.conflict!.weight!.barcode),
            })
          : undefined
      }
      onUseBarcodeExpiry={
        editForm.conflict?.expiry
          // Apply the ISO form the OCR would have produced, so the stored value
          // keeps one shape however it was arrived at.
          ? () => setEditForm({
              ...editForm,
              expiry: editForm.conflict!.expiry!.barcode,
            })
          : undefined
      }
      onSave={handleSaveEdit}
      onCancel={() => {
        // A barcode minted in this edit but never saved onto the row would
        // be an orphan label; drop it while it is still unprinted.
        if (editForm.forcedId) discardSavedLabel(editForm.forcedId);
        setEditForm(null);
      }}
    />
  ) : null;

  function runLooseOcr(lookupKey: string, imageData: string, manual = false) {
    fetch('/api/multi-pallet-ocr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: imageData, barcode: manual ? '' : lookupKey, token }),
    })
      .then((r) => r.json())
      .then((data) => {
        // A capture of a carton already on the loose list — see runOcr.
        if (manual && data?.success && data.ocr_data) {
          const digits = digitsOnly(data.ocr_data.barcode_digits);
          const hit = digits.length >= 13
            ? findCountedCartonByDigits(looseBoxesRef.current, digits, lookupKey)
            : null;
          if (hit) {
            trace('ui', 'manual_capture_duplicate', { provisional: lookupKey, digits, of: hit.n, loose: true });
            looseDupFlashRef.current?.('duplicate');
            scanAlreadyCountedFeedback();
            showScanNotice({
              text: t(sessionRef.current?.language || 'English', 'terminal.photoAlreadyCounted', { n: hit.n }),
              tone: 'info',
              different: canOfferDifferentCarton(digits, hit.row)
                ? { box: { ...hit.row, barcode: digits }, loose: true, n: hit.n }
                : undefined,
            });
            highlightRow(hit.row.barcode);
            setLooseBoxes((prev) => prev.filter((b) => b.barcode !== lookupKey));
            return;
          }
        }

        // See the pallet-phase note — hoisted out of the updater for the same reason.
        const conflict = data?.ocr_data
          ? findBarcodeConflict(
              manual ? digitsOnly(data.ocr_data.barcode_digits) : lookupKey,
              data.ocr_data.weight_kg,
              data.ocr_data.expiry_date,
            )
          : null;

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
              // The notice was raised above; this only catches a row the ref
              // had not caught up with yet.
              const dup = prev.some((b, i) => i !== idx && digitsOnly(b.barcode) === digits);
              if (dup) {
                looseDupFlashRef.current?.('duplicate');
                return prev.filter((_, i) => i !== idx);
              }
              resolvedBarcode = digits;
              resolvedSku = digits.slice(0, 13);
              looseProcessedRef.current.add(digits);
              clearScanNotice();
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

          // See the pallet-phase note: a manual capture's real identity only
          // exists once OCR has read the printed digits.
          if (manual) archiveStickerPhoto(resolvedBarcode, imageData, 'loose');

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
              production_date: data.ocr_data.production_date || '',
              supplier_batch: data.ocr_data.supplier_batch || '',
              needs_review: needsReview || undefined,
              barcode_conflict: conflict || undefined,
            };
          });
        });

        if (conflict) {
          const label = (data.ocr_data.product_name_hebrew
            || data.ocr_data.product_name_english || '').trim();
          showToast(
            conflict.weight
              ? tr('palletVerify.barcodeConflictWeight', {
                  item: label, bc: conflict.weight.barcode.toFixed(2),
                  ocr: conflict.weight.ocr.toFixed(2),
                })
              : tr('palletVerify.barcodeConflictExpiry', {
                  item: label, bc: isoToDdmmyyyyShort(conflict.expiry!.barcode),
                  ocr: isoToDdmmyyyyShort(conflict.expiry!.ocr),
                }),
            'report_problem', '#fbbf5c',
          );
        }
      })
      .catch(() => {
        setLooseBoxes((prev) => {
          const idx = prev.findIndex((b) => b.barcode === lookupKey);
          if (idx === -1) return prev;
          return prev.map((b, i) => (i === idx ? { ...b, ocr_status: 'failed' } : b));
        });
      });
  }

  // ── Print gate ──

  /**
   * A confirm reached while saved labels block it (the uniform auto-confirm,
   * the shortfall modal's slide, or the server's 409): book nothing and say
   * why. The footer already shows the amber "Print N labels first" by then.
   */
  function refuseForLabels(count: number, batchIds: string[], by: 'page' | 'server') {
    trace('ui', 'labels_gate_blocked', { count, batch_ids: batchIds, by });
    showToast(
      count === 1 ? tr('labels.gateButtonOne') : tr('labels.gateButton', { count }),
      'print_disabled',
      '#fbbf5c',
    );
  }

  /**
   * "Print N labels first": the print sheet for exactly the blocking batches.
   * Opened synchronously inside the click — a window.open after an await is
   * what pop-up blockers kill. The sheet marks what it prints, and the gate
   * lifts when this tab is visible again (useUnprintedLabels refetches).
   */
  function handlePrintBlockingLabels() {
    if (!labelGate.batchIds.length) return;
    const win = window.open(
      labelSheetUrl({ token, batchIds: labelGate.batchIds, size: loadLabelSize(), language }),
      '_blank',
    );
    if (!win) {
      showToast(tr('labels.printBlocked'), 'error', '#ef8a8a');
      return;
    }
    trace('ui', 'labels_print_opened', { batch_ids: labelGate.batchIds, count: labelGate.count, from: 'gate' });
  }

  // ── Confirm loose boxes ──

  async function handleConfirmLooseBoxes() {
    trace('ui', 'confirm_loose', { boxes: looseBoxes.length, declared: session?.loose_box_count });
    if (labelGate.count > 0) {
      refuseForLabels(labelGate.count, labelGate.batchIds, 'page');
      return;
    }
    setPhase('loose_confirming');
    setError(null);
    try {
      const res = await fetch('/api/multi-pallet-loose-complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          // image_data (base64) is stripped like the pallet payload does —
          // it was shipping the full frame of every loose box to the server
          // and on to the bot, which never had a use for it. image_url does.
          scanned_boxes: stripProvisionalIds(
            looseBoxes.map(({ ocr_status: _, image_data: _img, ...box }) => box),
            session?.document_number || '',
            0,
          ),
          // Split jobs only: which worker is closing the loose-box task.
          // Ignored server-side on a single-scanner session. Task 7's
          // ownership guard 403s a split submit without this (not_your_loose_task).
          worker_chat_id: workerChatId,
        }),
      });
      const data = await res.json();
      if (res.status === 409 && data.error === LABELS_NOT_PRINTED) {
        // The server's print gate: nothing was booked and nothing was sent.
        // Re-read the labels so the footer shows the gate, not an error.
        refuseForLabels(Number(data.unprinted) || 0, Array.isArray(data.batch_ids) ? data.batch_ids : [], 'server');
        unprinted.refresh();
        setPhase('loose_scanning');
        return;
      }
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
    trace('ui', 'count_submit', { pallet: currentPallet, input: boxCountInput, scanned: scannedBoxes.length });
    // Typing the total answers whatever the footer was saying.
    clearScanNotice();
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
    if (totalEdit !== null) {
      // A changed total is the one figure a worker could lower to dodge the
      // shortfall modal, so every change is on the trace.
      trace('ui', 'count_changed', { pallet: currentPallet, from: totalEdit, to: count });
      setTotalEdit(null);
    }

    if (pendingSingleGroup) {
      // Single-item path: lock the group at total_count = count, then
      // auto-confirm.
      const group: UniformGroup = {
        name_key: pendingSingleGroup.name_key,
        item_name: pendingSingleGroup.item_name,
        item_name_hebrew: pendingSingleGroup.item_name_hebrew,
        avg_weight: pendingSingleGroup.avg_weight,
        total_count: count,
        sample_barcodes: pendingSingleGroup.sample_barcodes,
      };
      const nextGroups = new Map(uniformGroups);
      nextGroups.set(group.name_key, group);
      setUniformGroups(nextGroups);
      setPendingSingleGroup(null);
      // Hand the count and the locked group to the confirm explicitly. The
      // deferred call captures THIS render's closure, where confirmedBoxCount
      // is still 0 and uniformGroups still lacks the group we just built —
      // React re-renders with the new values but a scheduled callback keeps
      // the old ones. Reading them from state here posted box_count: 0 with an
      // empty uniform_groups, and the server's `box_count || itemBoxes.length`
      // fallback then booked the pallet at the SAMPLE count: declare 40, get 4.
      setTimeout(() => handleConfirmPallet({ boxCount: count, groups: nextGroups }), 0);
    } else {
      // Mix / non-uniform path: persist the count for resume safety.
      fetch('/api/multi-pallet-session', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, current_box_count: count }),
      }).catch(() => {});
    }
  }

  // ── Change the pallet total (pencil on the progress line / CARTONS counter) ──
  //
  // The total is a number the worker typed (often the invoice line, which can
  // be wrong for this pallet — IN264172698 counted a tilapia carton against
  // the chicken line's 15), and it used to be fixed once set. This reopens the
  // same input, prefilled; the minimum is unchanged (max(2, scanned)). Not on
  // a single-item pallet: there the total IS the locked group's count.
  const canEditTotal =
    phase === 'scanning' && confirmedBoxCount > 0 && uniformGroups.size === 0 && !pendingSingleGroup;

  function startTotalEdit() {
    if (!canEditTotal) return;
    trace('ui', 'count_edit_open', { pallet: currentPallet, from: confirmedBoxCount });
    clearScanNotice();
    setTotalEdit(confirmedBoxCount);
    setBoxCountInput(String(confirmedBoxCount));
    setPalletCountError(null);
    setConfirmedBoxCount(0);
  }

  /** Back out of a change: the old total stands. */
  function cancelTotalEdit() {
    if (totalEdit === null) return;
    setConfirmedBoxCount(totalEdit);
    setBoxCountInput(String(totalEdit));
    setPalletCountError(null);
    setTotalEdit(null);
  }

  // ── Confirm pallet ──

  // Shared post-success advance: mirror what the API persisted, then either
  // finish (all_done / loose phase) or show the pallet_done card, where the
  // worker taps "Scan pallet N" to roll to the next pallet. Used by BOTH the
  // normal confirm and the damaged-sticker manual-count flow so the two paths
  // stay in lockstep.
  function applyCompletion(
    data: PalletCompleteResult,
    palletTypeLabel: 'single' | 'mix',
    boxCount: number,
  ) {
    trace('ui', 'pallet_completed', { pallet: currentPallet, lpn: data.lpn, type: palletTypeLabel, boxCount, next_pallet: data.next_pallet, all_done: data.all_done });
    setLpn(data.lpn || '');
    setLpnUrl(data.lpn_url || '');

    if (session && isSplitSession(session)) {
      // Split jobs: this worker just finished the ONE slot they claimed —
      // there is no cursor to advance and no "next pallet" number to move
      // on to (next_pallet/all_done are cursor-derived and meaningless per
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
      // The worker taps "Scan pallet N" on the done card to advance. Not an
      // auto-advance: the camera would come back on still pointed at the
      // pallet just booked, and single mode has no cross-pallet duplicate
      // guard (lib/duplicate-guard.ts) — the tap lets them turn to the next
      // pallet (and print this one's sticker) first.
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
    setSupplierPalletRef('');
    setActiveExpanded(false);
    setTotalEdit(null);
    clearScanNotice();
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = null;
    setFlashBarcode(null);
    clearDuplicateSounds(dupSoundsRef.current);
  }

  // Reset all per-pallet state and start scanning the next pallet. Fired by
  // the worker tapping "Scan pallet N" on the pallet_done card. The phase
  // guard makes a double-tap advance exactly one pallet.
  function advanceToNextPallet() {
    if (phase !== 'pallet_done') return;
    trace('ui', 'next_pallet', { from: currentPallet, to: pendingNextPallet ?? currentPallet + 1, via: 'tap' });
    setCurrentPallet(pendingNextPallet ?? currentPallet + 1);
    setPendingNextPallet(null);
    resetPalletUiState();
    setAdvanceShield(true);
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
    trace('ui', 'pallet_released', { pallet: currentPallet });
    clearPalletScans(token, currentPallet);
    resetPalletUiState();
    showToast(tr('split.palletReleased'), 'report_problem', '#f8a3a3');
    setPhase('job');
    reloadSession();
  }

  // `override` lets a caller that has just computed the declared count and the
  // locked groups pass them in directly instead of going through state — see
  // handlePalletCountSubmit, where reading them back off state would read the
  // pre-update values.
  async function handleConfirmPallet(override?: {
    boxCount: number;
    groups: Map<string, UniformGroup>;
  }) {
    trace('ui', 'confirm_pallet', { pallet: currentPallet, scanned: scannedBoxes.length, confirmedBoxCount, override: override ? { boxCount: override.boxCount, groups: override.groups } : undefined, forcedMix, detectedType });
    if (scannedBoxes.length < 2) return;
    // Every way into the LPN passes here — the slide, the shortfall modal,
    // the gap chip and the single-item auto-confirm — so the gate sits here.
    if (labelGate.count > 0) {
      refuseForLabels(labelGate.count, labelGate.batchIds, 'page');
      return;
    }
    setPhase('confirming');
    setError(null);

    const declaredCount = override?.boxCount ?? confirmedBoxCount;
    const lockedGroups = override?.groups ?? uniformGroups;

    // Build uniform_groups overrides from locked groups (and image_data is
    // intentionally stripped from scanned_boxes — the server doesn't need it).
    // `name_key` is the normalized-name grouping key, NOT the barcode digits.
    const uniformGroupsPayload = Array.from(lockedGroups.values()).map((g) => ({
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
          scanned_boxes: stripProvisionalIds(
            scannedBoxes.map(({ ocr_status: _, image_data: _img, ...box }) => box),
            session?.document_number || '',
            currentPallet,
          ),
          box_count: declaredCount,
          uniform_groups: uniformGroupsPayload,
          merge_map: mergeMapPayload,
          // The supplier's shipping-pallet number, when its label was scanned
          // (MEV-10) — stored on pallets.supplier_pallet_ref by the bot.
          supplier_pallet_ref: supplierPalletRef || undefined,
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

      if (res.status === 409 && data.error === LABELS_NOT_PRINTED) {
        // The server's print gate: no LPN, nothing written, no webhook.
        // Re-read the labels so the footer shows the gate, not an error.
        refuseForLabels(Number(data.unprinted) || 0, Array.isArray(data.batch_ids) ? data.batch_ids : [], 'server');
        unprinted.refresh();
        setPhase('scanning');
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
      applyCompletion(data, palletTypeLabel, declaredCount);
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
  // Cartons still to scan against the worker's total (0 when none is set).
  const shortCount = Math.max(0, confirmedBoxCount - committed);

  // Group scanned boxes by normalized OCR'd Hebrew name (with worker-accepted
  // AI merges applied). Barcode digits are intentionally NOT used — they're
  // per-box dedup keys, never product identifiers. See lib/group-key.ts.
  const groupedByName = groupBoxesByName(scannedBoxes, acceptedMerges);
  // Object<key, boxes[]> shape for the existing render paths (Object.entries
  // is what the JSX below expects).
  const groupedItems: Record<string, BoxScan[]> = {};
  for (const [k, v] of groupedByName.entries()) groupedItems[k] = v;

  // ── Type badge ──

  /**
   * A header corner counter: a small caption over a mono "x / n".
   *
   * The two of them replace three separate readouts that all said the same
   * thing (header title, the scan-type hint, and the progress row's own
   * label + count). Workers read the header as noise and stopped looking at
   * it; one number per corner is what they actually need — which pallet
   * they're on, and how many cartons are on it.
   *
   * `total <= 0` means "not declared yet", so the denominator is held back
   * rather than shown as a misleading /0.
   */
  function HeaderCount({
    caption, current, total, align, tone = 'brand', editable = false,
  }: {
    caption: string;
    current: number;
    total: number;
    align: 'start' | 'end';
    tone?: 'brand' | 'warn' | 'done';
    /** A small pencil by the caption: tapping the counter changes the total. */
    editable?: boolean;
  }) {
    const color = tone === 'done' ? '#4ade80' : tone === 'warn' ? '#fbbf5c' : '#13a4ec';
    return (
      <span className={`flex flex-col ${align === 'start' ? 'items-start' : 'items-end'} leading-none gap-[3px]`}>
        <span className="inline-flex items-center gap-[2px] text-[8.5px] font-bold text-ink-muted tracking-[.6px] uppercase whitespace-nowrap">
          {editable && <MI name="edit" size={10} className="text-brand-weak-ink" />}
          {caption}
        </span>
        <span className="font-mono font-black text-[15px] text-ink-inverse" dir="ltr">
          <span style={{ color }}>{current}</span>
          {total > 0 && <span className="text-ink-muted">/{total}</span>}
        </span>
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
    // Terminal design "כל המשטחים נקלטו" card: stats, where the automatic
    // Priority push stands, real per-pallet sticker links (the design's primary
    // "ניפוק מדבקות" action) and a way back to the carton Labels screen.
    // Priority needs no step here: the bot closes the delivery at the last LPN
    // and the DB outbox sends it, so the old "סגירה ושליחה לפריוריטי" button is
    // gone — PriorityPushStatus is a status row that updates by itself.
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

            {/* Right under the stats so it is in view without scrolling on a
                long pallet list. */}
            <PriorityPushStatus token={token} />

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

            {/* The carton stickers minted with New carton / identical boxes,
                for a reprint after the job (opens the Labels screen). */}
            <button
              type="button"
              onClick={() => setShowLabels(true)}
              className="flex items-center justify-center gap-[7px] w-full mt-4 border border-[#35516a] text-[#e8eef2] text-[12px] font-extrabold rounded-[11px] py-[11px]"
            >
              <MI name="label" size={17} className="text-brand-weak-ink" />
              {tr('terminal.reprintLabels')}
            </button>

            {looseCount > 0 && (
              <div className="mt-3 bg-warn-weak border border-warn/30 rounded-[11px] p-3 text-[11px] font-semibold text-warn-weak-ink">
                {tr('palletVerify.looseBoxesNote', { count: looseCount })}
              </div>
            )}

            <p className="text-[10px] text-ink-muted text-center mt-3">
              {tr('palletVerify.expiryNote')}
            </p>
          </div>
        </div>
        <Toast toast={toast} />
        {cartonOverlays}
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

    // Two-step row actions (tap row → tap action). The shared ScanActions bar
    // renders on its own line under the row, so the buttons get real tap
    // targets instead of competing with the barcode and weight, and it wraps
    // rather than overflowing a narrow phone. Each tap stops propagation, so
    // it does not also collapse the row.
    const looseRowActions = (box: BoxScan) => {
      if (selectedBarcode !== box.barcode) return undefined;
      const onDelete = () => { rescanLooseBox(box.barcode); setSelectedBarcode(null); };
      if (box.ocr_status === 'failed') {
        return (
          <ScanActions
            onViewImage={box.image_data ? () => setViewingImage(box.image_data!) : undefined}
            onRetry={() => retryLooseOcr(box.barcode)}
            onDelete={onDelete}
          />
        );
      }
      return (
        <ScanActions
          onEdit={() => openEdit(box, true)}
          onIdentical={canDeclareIdentical(box) ? () => setIdenticalFor({ box, loose: true }) : undefined}
          onDelete={onDelete}
        />
      );
    };

    const looseFooter = (
      <>
        {footerError}
        {canConfirmLoose && labelGate.count > 0 ? (
          // Ready to finish, but saved labels are unprinted: print first.
          labelGateFooter(true)
        ) : canConfirmLoose && phase !== 'loose_confirming' ? (
          // Brand (blue) slide: this books the loose cartons like any normal
          // confirm. Amber slides are kept for booking WITH a shortfall.
          <SwipeConfirm
            onConfirm={handleConfirmLooseBoxes}
            label={tr('palletVerify.swipeConfirmLoose', { count: scanned })}
          />
        ) : (
          hasUnresolvedLooseWarnings ? (
          <button
            onClick={() => {
              const bad = looseBoxes.find((b) => b.needs_review);
              if (bad) openEdit(bad, true);
            }}
            className="flex items-center justify-center gap-[6px] w-full py-3 rounded-[13px] font-black text-[14px] bg-warn text-canvas"
          >
            <MI name="report_problem" size={18} />
            {tr('palletVerify.warningsBlockConfirm', { count: unresolvedLooseWarnings })}
          </button>
          ) : (
          <button
            disabled
            className="w-full py-3 rounded-[13px] font-extrabold text-base bg-sunken text-ink-muted cursor-not-allowed"
          >
            {canConfirmLoose
              ? tr('palletVerify.confirmLooseBtn', { count: scanned })
              : declared > 0
              ? tr('palletVerify.scanMoreLoose', { count: Math.max(0, declared - scanned) })
              : tr('palletVerify.scanAtLeast2')}
          </button>
          )
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
          title={tr('palletVerify.docPrefix', { doc: session?.document_number || '—' })}
          onMenu={drawer.open}
          leading={
            <span className="ps-1 text-[9px] font-bold text-warn-weak-ink tracking-[.6px] uppercase whitespace-nowrap">
              {tr('loose.title')}
            </span>
          }
          right={
            <span className="pe-2">
              <HeaderCount
                caption={tr('terminal.statCartons')}
                current={scanned}
                total={declared}
                align="end"
                tone={declared > 0 && scanned >= declared ? 'done' : 'warn'}
              />
            </span>
          }
        />
        <ProgressHeader
          count={scanned}
          total={declared}
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
              paused={!!editForm}
              frame="corner"
              className="h-full"
              onBarcodeDetected={handleLooseBarcodeDetected}
              onManualCapture={handleLooseManualCapture}
              onDuplicateFlash={(fn) => { looseDupFlashRef.current = fn; }}
              isDuplicateBarcode={(b) => looseProcessedRef.current.has(b.trim())}
              scannedBarcodes={new Map()}
              ocrResults={new Map()}
            />
          </div>
          {scanNoticeBanner}
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
            footer={looseFooter}
          >
            {(
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
                    onDelete={() => { rescanLooseBox(looseActive.barcode); setSelectedBarcode(null); }}
                    onIdentical={canDeclareIdentical(looseActive) ? () => setIdenticalFor({ box: looseActive, loose: true }) : undefined}
                    onRetry={looseActive.ocr_status === 'failed' ? () => retryLooseOcr(looseActive.barcode) : undefined}
                    onViewImage={looseActive.image_data ? () => setViewingImage(looseActive.image_data!) : undefined}
                    unprinted={unprintedBarcodes.has(looseActive.barcode)}
                    highlight={looseActive.barcode === flashBarcode}
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
                    actions={looseRowActions(box)}
                    unprinted={unprintedBarcodes.has(box.barcode)}
                    unprintedLabel={tr('terminal.labelNotPrinted')}
                    highlight={box.barcode === flashBarcode}
                  />
                ))}
              </>
            )}
          </BottomSheet>
        </div>

        <Toast toast={toast} />
        {drawer.node}
        {palletsBrowser}
        {cartonOverlays}
        {imageModal}
        {debugPanel}
      </div>
    );
  }

  if (phase === 'pallet_done') {
    // Terminal design done overlay: stats + real sticker deep-link for THIS
    // pallet + a one-tap "Scan pallet N of M". The pallet is already booked
    // (the confirm slide did that), so moving on is a tap, not a second slide;
    // it sits last, in the thumb zone, and arms 500 ms after the card appears.
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
          {lpnUrl && (
            <a
              href={`${lpnUrl}?token=${encodeURIComponent(token)}${language === 'Hebrew' ? '&lang=Hebrew' : ''}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-[7px] w-full mt-4 border border-[#35516a] text-[#e8eef2] text-[12px] font-extrabold rounded-[11px] py-[11px]"
            >
              <MI name="print" size={17} className="text-brand-weak-ink" /> {tr('terminal.issuePalletLabels')}
            </a>
          )}
          <button
            type="button"
            onClick={advanceToNextPallet}
            disabled={!nextArmed}
            className="flex items-center justify-center gap-[7px] w-full h-[54px] mt-4 rounded-[13px] bg-brand text-[#04222f] font-black text-[15px] disabled:opacity-60"
          >
            <MI name="qr_code_scanner" size={20} />
            {tr('terminal.nextPalletBtn', { n: pendingNextPallet ?? currentPallet + 1, total: pallet_count })}
          </button>
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

  // Two-step row actions (tap row → tap action). The shared ScanActions bar
  // renders on its own line under the row, so the buttons get real tap
  // targets instead of competing with the barcode and weight, and it wraps
  // rather than overflowing a narrow phone. Each tap stops propagation, so
  // it does not also collapse the row.
  const palletRowActions = (box: BoxScan) => {
    if (selectedBarcode !== box.barcode) return undefined;
    const onDelete = () => { rescanPalletBox(box.barcode); setSelectedBarcode(null); };
    if (box.ocr_status === 'failed') {
      return (
        <ScanActions
          onViewImage={box.image_data ? () => setViewingImage(box.image_data!) : undefined}
          onRetry={() => retryPalletOcr(box.barcode)}
          onDelete={onDelete}
        />
      );
    }
    return (
      <ScanActions
        onEdit={() => openEdit(box)}
        onIdentical={canDeclareIdentical(box) ? () => setIdenticalFor({ box, loose: false }) : undefined}
        onDelete={onDelete}
      />
    );
  };

  // Guidance line from the old header — where does the worker stand now.
  const statusText = canConfirm
    ? tr('palletVerify.readyToConfirm')
    : pendingUniformPrompt
    ? tr('palletVerify.waitingInput')
    : confirmedBoxCount === 0
    ? (committed < 2 ? tr('palletVerify.scanToStart') : tr('palletVerify.setTotalBelow'))
    : tr('palletVerify.leftToScan', { left: shortCount, total: confirmedBoxCount });

  // The deferred pallet-total input: after enough OCR'd boxes (or the worker
  // said mix / single-item, or a minted batch put the count on the list), or
  // reopened by the pencil to change the total.
  const showCountInput = confirmedBoxCount === 0 && (
    totalEdit !== null
    || (!anyProcessing && (doneCount >= 4 || forcedMix || !!pendingSingleGroup || scannedBoxes.some((b) => b.minted)))
  );

  // Footer — priority-ordered modes:
  // (1) single_or_mix uniform prompt (Complete / Continue),
  // (2) deferred pallet box-count input,
  // (3) standard confirm (swipe) / force-confirm / disabled reason.
  const mainFooter = (
    <>
      {footerError}
      {!canConfirm && (
        <div className="flex items-center justify-center gap-1 text-[10px] font-bold text-ink-muted text-center mb-2">
          <span className="min-w-0">{statusText}</span>
          {canEditTotal && (
            // Brand = a normal action. The total is the worker's own number
            // (often the invoice line) and may simply be wrong for this pallet.
            <button
              type="button"
              onClick={startTotalEdit}
              aria-label={tr('palletVerify.changeTotal')}
              title={tr('palletVerify.changeTotal')}
              className="shrink-0 -my-2 w-8 h-8 inline-flex items-center justify-center rounded-full text-brand-weak-ink active:bg-brand-weak"
            >
              <MI name="edit" size={15} />
            </button>
          )}
        </div>
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
      ) : showCountInput ? (
        <div className="space-y-2">
          {/* Cancel sits on the title line, not under the input: on a 641px
              phone one more footer line is what tips the sheet into hiding
              the whole footer. */}
          <div className="flex items-baseline justify-between gap-2">
            <label className="block min-w-0 text-xs text-ink-body font-medium">
              {tr('palletVerify.deferredCountTitle')}
            </label>
            {totalEdit !== null && (
              <button
                type="button"
                onClick={cancelTotalEdit}
                className="shrink-0 text-xs text-ink-muted underline"
              >
                {tr('common.cancel')}
              </button>
            )}
          </div>
          <p className="text-[11px] text-ink-muted">
            {pendingSingleGroup
              ? tr('palletVerify.singleMultiplyNote', {
                  weight: pendingSingleGroup.avg_weight.toFixed(3),
                })
              : tr('palletVerify.deferredCountHint', { scanned: scannedBoxes.length })}
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
          {(canConfirm || canForceConfirm) && labelGate.count > 0 ? (
            // Ready for the LPN, but saved labels are unprinted: print first.
            labelGateFooter(false)
          ) : !canConfirm && canForceConfirm ? (
            // Secondary, outlined: while cartons are still to scan this is
            // the exception, not the next step — it used to be the loudest
            // thing on screen ("Create LPN anyway", filled orange) from the
            // moment a total was typed. Amber = a decision (booking short).
            <button
              onClick={() => setPendingForceConfirm(true)}
              disabled={phase === 'confirming'}
              className="flex items-center justify-center gap-[6px] w-full py-3 px-3 rounded-[13px] font-extrabold text-[13px] leading-tight text-center bg-tile border-2 border-warn/60 text-warn-weak-ink disabled:opacity-50"
            >
              <MI name="inventory_2" size={18} className="shrink-0" />
              <span className="min-w-0">
                {shortCount > 0
                  ? tr('palletVerify.closeShortBtn', { committed })
                  : tr('palletVerify.closeUnreadBtn', { committed })}
              </span>
            </button>
          ) : canConfirm && phase !== 'confirming' ? (
            <SwipeConfirm
              onConfirm={() => handleConfirmPallet()}
              label={tr('palletVerify.swipeConfirmPallet', { current: currentPallet })}
            />
          ) : (
            hasUnresolvedWarnings ? (
            // Live, not disabled. This used to be a dead grey bar reading "Fix
            // 1 warning(s) to continue" with nothing to tap and no indication
            // of WHICH carton or WHAT was wrong — a worker tapping it got
            // nothing back. It now opens the offending carton's editor
            // directly, which is the only thing they could have done anyway.
            <button
              onClick={() => {
                const bad = scannedBoxes.find((b) => b.needs_review);
                if (bad) openEdit(bad);
              }}
              className="flex items-center justify-center gap-[6px] w-full py-3 rounded-[13px] font-black text-[14px] bg-warn text-canvas"
            >
              <MI name="report_problem" size={18} />
              {tr('palletVerify.warningsBlockConfirm', { count: unresolvedWarnings })}
            </button>
            ) : (
            <button
              disabled
              className="w-full py-3 rounded-[13px] font-extrabold text-base bg-sunken text-ink-muted cursor-not-allowed"
            >
              {canConfirm
                ? tr('palletVerify.confirmPalletBtn', { current: currentPallet })
                : committed < 2
                ? tr('palletVerify.scanMoreToContinue', { count: 2 - committed })
                : confirmedBoxCount === 0
                ? // No total declared yet, so nothing is outstanding — the old
                  // fallback rendered a flat "0 more boxes needed" here.
                  tr('palletVerify.setTotalBelow')
                : tr('palletVerify.boxesNeeded', { count: Math.max(0, confirmedBoxCount - committed) })}
            </button>
            )
          )}
          {confirmedBoxCount === 0 && !forcedMix && !pendingSingleGroup && doneCount < 4 && doneCount >= 1 && !anyProcessing && (
            // The way off a pallet the scanner can't classify on its own —
            // a handful of boxes that aren't all one uniform item. It used to
            // be a thin grey underline that workers missed, so it now carries
            // the same weight as the other footer actions.
            <button
              onClick={() => setForcedMix(true)}
              className="flex items-center justify-center gap-[6px] w-full mt-2 py-3 rounded-[13px] font-extrabold text-[14px] bg-tile border-2 border-brand text-brand-weak-ink"
            >
              <MI name="done_all" size={18} /> {tr('palletVerify.doneScanning')}
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
        title={tr('palletVerify.docPrefix', { doc: session?.document_number || '—' })}
        onMenu={drawer.open}
        leading={
          <span className="ps-1">
            <HeaderCount
              caption={tr('terminal.statPallet')}
              current={currentPallet}
              total={pallet_count}
              align="start"
            />
          </span>
        }
        right={
          <span className="pe-2">
            {canEditTotal ? (
              // Tapping the counter is the other way to change the total.
              <button
                type="button"
                onClick={startTotalEdit}
                aria-label={tr('palletVerify.changeTotal')}
                className="block -m-1 p-1 rounded-[8px] active:bg-brand-weak"
              >
                <HeaderCount
                  caption={tr('terminal.statCartons')}
                  current={committed}
                  total={confirmedBoxCount}
                  align="end"
                  tone={canConfirm ? 'done' : 'brand'}
                  editable
                />
              </button>
            ) : (
              <HeaderCount
                caption={tr('terminal.statCartons')}
                current={committed}
                total={confirmedBoxCount}
                align="end"
                tone={canConfirm ? 'done' : 'brand'}
              />
            )}
          </span>
        }
      />
      <ProgressHeader count={committed} total={confirmedBoxCount} tone={canConfirm ? 'done' : 'brand'} />

      {/* Camera area with the floating bottom sheet over it */}
      <div className="flex-1 min-h-0 relative bg-black">
        <div className="absolute inset-0">
          {/* Scanner — keyed per pallet so each new pallet gets a fresh
              scanner instance (clears the internal cooldown/dedup refs). */}
          <SmartScanner
            key={`pallet-scanner-${currentPallet}`}
            frame="corner"
            className="h-full"
            paused={!!editForm}
            onBarcodeDetected={handleBarcodeDetected}
            onManualCapture={handleManualCapture}
            onDuplicateFlash={(fn) => { dupFlashRef.current = fn; }}
            // Answers "already got this one?" the instant the barcode is
            // confirmed, so the scanner paints its blue "already counted"
            // rather than green for the ~400ms before handleBarcodeDetected
            // below reaches the same verdict.
            isDuplicateBarcode={(b) => processedRef.current.has(b.trim())}
            // The worker is typing the total or answering the single-item
            // question: a pause, not a stuck barcode — no orange pulse.
            nudgeSuppressed={showCountInput || !!pendingUniformPrompt}
            scannedBarcodes={new Map()}
            ocrResults={new Map()}
          />
        </div>
        {scanNoticeBanner}
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
                  canForceConfirm && labelGate.count > 0
                    ? refuseForLabels(labelGate.count, labelGate.batchIds, 'page')
                    : canForceConfirm
                    ? setPendingForceConfirm(true)
                    : showToast(tr('terminal.gapNotApplicable'), 'report_problem', '#fbbf5c'),
              })}
              onLockedPress={showLockToast}
            />
          }
          footer={mainFooter}
        >
          {(
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
                  onDelete={() => { rescanPalletBox(activeBox.barcode); setSelectedBarcode(null); }}
                  onIdentical={canDeclareIdentical(activeBox) ? () => setIdenticalFor({ box: activeBox, loose: false }) : undefined}
                  onRetry={activeBox.ocr_status === 'failed' ? () => retryPalletOcr(activeBox.barcode) : undefined}
                  onViewImage={activeBox.image_data ? () => setViewingImage(activeBox.image_data!) : undefined}
                  unprinted={unprintedBarcodes.has(activeBox.barcode)}
                  highlight={activeBox.barcode === flashBarcode}
                />
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
                  actions={palletRowActions(box)}
                  unprinted={unprintedBarcodes.has(box.barcode)}
                  unprintedLabel={tr('terminal.labelNotPrinted')}
                  highlight={box.barcode === flashBarcode}
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
      {cartonOverlays}
      {editPanelNode}
      {imageModal}
      {pendingForceConfirm && (
        // Closing the pallet SHORT of the worker's own total — the last human
        // checkpoint before the bot books it (and, once the delivery closes,
        // the automatic Priority draft). Amber = a decision. It used to be
        // "Discrepancy vs. delivery note" with an "Expected" tile, but the
        // figure is the total the worker typed, not the delivery note; the
        // copy now says what it is and what happens. The slide stays — this
        // books stock (one slide per booking); "Keep scanning" changes nothing.
        <div className="fixed inset-0 z-[72] bg-[rgba(5,8,10,0.74)] backdrop-blur-[3px] flex items-center justify-center p-[22px]">
          <div className="w-full max-w-[330px] bg-amber-card border border-[rgba(245,158,11,0.5)] rounded-[20px] px-5 py-[22px] shadow-[0_26px_64px_rgba(0,0,0,0.72)] animate-doneRise">
            <div className="flex justify-center mb-[13px]">
              <div className="w-16 h-16 rounded-full bg-[rgba(245,158,11,0.16)] flex items-center justify-center">
                <MI name="inventory_2" size={34} style={{ color: '#fbbf5c' }} />
              </div>
            </div>
            <h2 className="text-center text-[19px] font-black text-ink-inverse">
              {shortCount > 0 ? tr('palletVerify.closeShortTitle') : tr('palletVerify.closeUnreadTitle')}
            </h2>
            <p className="text-center text-xs font-semibold text-[#d8c9a0] mt-1 leading-snug">
              {shortCount > 0
                ? tr('palletVerify.closeShortBody', { declared: confirmedBoxCount, committed, short: shortCount })
                : tr('palletVerify.unreadableSoftNote', { count: unresolvedWarnings })}
            </p>
            <div className="flex gap-2 mt-4">
              <div className="flex-1 min-w-0 bg-amber-well border border-[rgba(245,158,11,0.28)] rounded-[11px] px-1.5 py-2.5 text-center">
                <div className="font-mono font-black text-base text-ink-inverse" dir="ltr">{committed}</div>
                <div className="text-[8.5px] font-bold text-[#d8c9a0] mt-0.5">{tr('palletVerify.closeShortCounted')}</div>
              </div>
              <div className="flex-1 min-w-0 bg-amber-well border border-[rgba(245,158,11,0.28)] rounded-[11px] px-1.5 py-2.5 text-center">
                <div className="font-mono font-black text-base text-ink-inverse" dir="ltr">{confirmedBoxCount}</div>
                <div className="text-[8.5px] font-bold text-[#d8c9a0] mt-0.5">{tr('palletVerify.closeShortYourTotal')}</div>
              </div>
              <div className="flex-1 min-w-0 bg-amber-well border border-[rgba(245,158,11,0.28)] rounded-[11px] px-1.5 py-2.5 text-center">
                <div className="font-mono font-black text-base text-[#fbbf5c]" dir="ltr">{shortCount}</div>
                <div className="text-[8.5px] font-bold text-[#d8c9a0] mt-0.5">{tr('palletVerify.closeShortMissing')}</div>
              </div>
            </div>
            <div className="mt-4">
              <SwipeConfirm
                variant="warn"
                label={tr('palletVerify.closeShortConfirm', { committed })}
                onConfirm={() => { setPendingForceConfirm(false); handleConfirmPallet(); }}
              />
            </div>
            <button
              onClick={() => setPendingForceConfirm(false)}
              className="w-full mt-2 py-2 text-ink-muted text-xs font-extrabold transition"
            >
              {tr('palletVerify.keepScanning')}
            </button>
          </div>
        </div>
      )}
      {/* Swallows the second tap of a double-tap on "Scan pallet N" (see
          advanceShield) — above the dock, the sheet and the camera's
          tap-to-capture layer. */}
      {advanceShield && <div className="fixed inset-0 z-[130]" aria-hidden />}
      {debugPanel}
    </div>
  );
}
