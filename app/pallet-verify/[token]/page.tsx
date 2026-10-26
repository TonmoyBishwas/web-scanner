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
import { ByItemBar, useItemFilter } from '@/components/terminal/ByItemFilter';
import { EditPanel } from '@/components/terminal/EditPanel';
import {
  applyBarcodeReadings, keepBarcodeFilled, reconcileWithBarcode, typicalWeightFor,
  type BarcodeEvent, type BarcodeFilled,
} from '@/lib/barcode-reconcile';
import { blocksConfirm, failedReadPrefill, heldAfterReads, isOpenRatioDoubt, takesLateRead, waitForReads } from '@/lib/failed-read';
import { DoneOverlay } from '@/components/terminal/DoneOverlay';
import { Toast, useLockToast } from '@/components/terminal/Toast';
import { PriorityPushStatus } from '@/components/terminal/PriorityPushStatus';
import { useDrawerHost } from '@/components/terminal/DrawerHost';
import { PalletsBrowser } from '@/components/terminal/PalletsBrowser';
import { CartonCreator, type CartonCreatorPreset, type CartonItemOption, type CartonOnList, type UnitsSave } from '@/components/terminal/CartonCreator';
import { groupUnitsRows, isUnitsCarton, shortExpiry, unitsAddedKey, unitsBatchSummary, unitsCartonRows, unitsCartonsPrefill, unitsRowKey } from '@/lib/units-cartons';
import { UnitsBatchRow } from '@/components/terminal/UnitsBatchRow';
import { LabelsBrowser } from '@/components/terminal/LabelsBrowser';
import { IdenticalBoxesForm } from '@/components/terminal/IdenticalBoxesForm';
import { DeleteAllSheet, type DeleteAllAction } from '@/components/terminal/DeleteAllSheet';
import { canSelect, selectedForDelete, sheetSnapAfterSelect, toggleSelected } from '@/lib/carton-select';
import { GroupCountSheet } from '@/components/terminal/GroupCountSheet';
import { PendingLabelsLink } from '@/components/terminal/PendingLabelsLink';
import { countGroupOf, groupRows, growGroupRows, rowsToShrink } from '@/lib/pallet-clear';
import {
  dedupCodes,
  expandIdenticalBoxes,
  releasedSources,
  sourceStillListed,
  identicalLabelPayload,
  postIdenticalLabels,
  newCartonBatch,
  asNewCartonRows,
  groupSkuMismatch,
  sourceSku,
  type IdenticalForm,
} from '@/lib/identical-boxes';
import { isMintedLabelBarcode, newBatchId, labelSheetUrl, liveRowPlaces, loadLabelSize, openListsForPhase, sessionBookedBarcodes } from '@/lib/label-batches';
import { printGate, LABELS_NOT_PRINTED } from '@/lib/label-gate';
import {
  labelPrintingEnabled, labelsChipLook, labelsInitialStatus, newCartonUncountedToast, unprintedMarkers,
} from '@/lib/label-printing';
import { useUnprintedLabels } from '@/lib/use-unprinted-labels';
import { toIsoDate, normalizeExpiry } from '@/lib/expiry';
import { itemOptions, localIsoDate } from '@/lib/edit-panel-state';
import { validateCartonDates } from '@/lib/date-validation';
import type { CartonLabel } from '@/types';
import SplitJobScreen, { SPLIT_CLAIM_ERROR_KEYS } from '@/components/terminal/SplitJobScreen';
import { installDebugLogCapture } from '@/lib/debug-log';
import { startScannerTrace, trace } from '@/lib/scanner-trace';
import { LanguageContext, useLangDir, t } from '@/lib/i18n';
import type { Language, MultiPalletSession, MultiPalletBoxScan, ParsedBarcode } from '@/types';
import { groupKeyForBox, groupBoxesByName } from '@/lib/group-key';
import { cartonOwnCodes, invoiceNameConflict, matchInvoiceItem } from '@/lib/invoice-match';
import { labelPrintsWeight, uniformCandidate } from '@/lib/uniform-candidate';
import { isSplitSession } from '@/lib/session-mode';
import { findDuplicateOwner } from '@/lib/duplicate-guard';
import { classifyRead, matchInvoiceShortCode, noteRepeatedRead, printedDigitsIdentifyCarton, shortCodeDefaults } from '@/lib/carton-barcode';
import { countPrefill, type CountPrefill } from '@/lib/count-prefill';
import { cartonsOnListFor, listAboveTotal, newCartonQuantity, type ListAboveTotal } from '@/lib/count-check';
import { freeNoBarcodeId, isNoBarcodeId, unreadDigitsOutcome } from '@/lib/no-barcode';
import { useBackClose } from '@/lib/use-back-close';
import { findWeightSuspects } from '@/lib/weight-sanity';
import { acceptDoubts, releaseDoubtHold, sharedDoubt, weightDoubts } from '@/lib/weight-review';
import { useSettingsStore } from '@/stores/settings-store';
import { scanSuccessFeedback, scanDuplicateFeedback, scanAlreadyCountedFeedback } from '@/lib/scan-feedback';
import { photoBelongsTo, photoUploadKey } from '@/lib/photo-rows';
import { compressPhoto, dataUrlBytes } from '@/lib/photo-compress';
import {
  SCAN_NOTICE_ACTION_MS,
  HIGHLIGHT_ROW_MS,
  scanNoticeMs,
  noticeAwaitsAnswer,
  shouldSoundDuplicate,
  clearDuplicateSounds,
  findCountedCarton,
  findCountedCartonByDigits,
  differentCartonOffer,
  canOfferDifferentCarton,
  isBatchStandIn,
  standInCount,
  twinCount,
  noteTwinHoldRead,
  sameLabelOnList,
  shouldExplainShortRead,
  listedNoticeKey,
  type TwinHold,
  type CountedCarton,
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
import { browserStore, claimSession, lostSession, newTabId, ownerKey } from '@/lib/session-owner';
import { mergeServer, ScanLedger, type LedgerStatus, type ServerCarton } from '@/lib/scan-ledger';

// One id per page load: the tab that opened the scan last owns it
// (lib/session-owner.ts — two tabs must not overwrite each other's cartons).
const TAB_ID = newTabId();

// Label printing (LABEL_PRINTING_ENABLED, lib/label-printing.ts — client
// 20/10, default off): off, labels are still minted and booked, but nothing
// on this page offers, asks for or reminds about printing them.
const PRINTING = labelPrintingEnabled();

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
  // A 31-digit carton barcode encodes the weight and expiry, and the barcode
  // wins (client rule, 19/10 — lib/barcode-reconcile.ts): the keys present
  // here are the fields now holding the barcode's value, each with what the
  // OCR had read (null = nothing). Shown as a neutral "from barcode" marker;
  // never a warning, never a question, never a hold.
  barcode_filled?: BarcodeFilled;
  // The worker saved this carton's dates in the edit panel: the last pass
  // before booking leaves his expiry alone (weight_checked does the same for
  // the weight).
  expiry_checked?: boolean;
  // Minted by "all boxes identical" (lib/identical-boxes.ts): the worker
  // declared every carton of this product the same, and this row's barcode
  // is a warehouse-printed label, not a supplier sticker. Such rows are
  // never offered the single-item shortcut — their count is already exact.
  minted?: boolean;
  label_batch_id?: string;
  // "Change count" grew this row's identical group: the batch the group was
  // first saved as (its own label is a newer batch). lib/pallet-clear.ts.
  count_group?: string;
  // The supplier barcode a minted row stands in for. It stays in the dedup
  // set while any row of that batch is on the list (lib/identical-boxes.ts).
  source_barcode?: string;
  // Minted for ONE more carton whose label is byte-identical to a counted
  // one ("Another carton, same label" / "Different carton?"): a carton of its
  // own, never a batch that declares every carton with source_barcode
  // counted (lib/scan-notice.ts isBatchStandIn).
  twin?: boolean;
  // Q5: saved with "New carton" and counted at the weight typed there, before
  // its label was printed. Booked as is; the row says "label not printed"
  // while the label is unprinted.
  new_carton?: boolean;
  // lib/weight-sanity.ts: the OCR weight looks wrong (a number from the
  // product name — `name` says which — or 3x off the item's median on this
  // list). NOT folded into needs_review (lib/weight-review.ts). A name number
  // is a question: it never holds the pallet, and any left at Confirm are
  // booked as read (and traced). A ratio doubt holds it until settled
  // (lib/failed-read.ts isOpenRatioDoubt — client, 25/10). The row turns
  // amber with a reason; the review bar, the edit panel's "the weight is
  // correct" or an edit settles it.
  weight_suspect?: { typical?: number; reason: 'name_number' | 'ratio'; name?: string };
  // The worker saved this carton in the edit panel: its weight is theirs.
  weight_checked?: boolean;
  // The carton's own code is one invoice line and its OCR'd name another
  // (lib/invoice-match.ts invoiceNameConflict — IN264191356, 19/10: a meatball
  // carton's code beside a kebab sticker's name). It is booked as the code's
  // line; this keeps what the sticker read and the line that name matched,
  // so the identical form can ask "which product?". An edit settles it.
  name_conflict?: { ocr: string; line: { item_code: string; item_name_hebrew: string; item_name_english: string } };
  // The worker settled which product this is: picked it in the identical
  // form's "which product?", or saved a name of his own in the edit panel.
  // Its invoice line then follows the name he chose, never the carton's code
  // (ownCodes) — the server books by name, and a label must say the same.
  named_by_worker?: boolean;
  // Its sticker photo is still uploading (archiveStickerPhoto). Never cached.
  photo_pending?: boolean;
}

// Digits-only normaliser for comparing the full printed barcode number across
// bar-scanned and OCR-captured boxes (NOT the 13-digit SKU, which repeats
// across every box of one product).
/**
 * Flag every carton on the list whose weight looks wrong (lib/weight-sanity.ts)
 * — a new read can also expose an earlier one, e.g. a first carton read as
 * 120 kg once three real 12 kg ones are in. Only ever ADDS a doubt, and never
 * touches needs_review (lib/weight-review.ts); a ratio doubt holds through
 * blocksConfirm instead (lib/failed-read.ts).
 */
function flagSuspectWeights(
  list: BoxScan[],
  extraNames: Record<string, Array<string | null | undefined>> = {},
): BoxScan[] {
  // A weight read from the carton's barcode is not a guess from the sticker:
  // it still counts towards the item's median, it is never itself doubted.
  const suspects = findWeightSuspects(
    list.map((b) => (b.barcode_filled && 'weight' in b.barcode_filled ? { ...b, weight_checked: true } : b)),
    extraNames,
  );
  if (!suspects.length) return list;
  const by = new Map(suspects.map((x) => [x.barcode, x]));
  return list.map((b) => {
    const x = by.get(b.barcode);
    if (!x || b.weight_suspect) return b;
    return { ...b, weight_suspect: { typical: x.typical, reason: x.reason, name: x.name } };
  });
}

type Tr = (k: Parameters<typeof t>[1], v?: Parameters<typeof t>[2]) => string;

/**
 * What the worker is told about a flagged weight (toast, edit panel, the
 * identical form): which number looked odd and where it came from, and that
 * a sticker saying the same weight means it is right.
 */
function weightWarningText(
  b: Pick<BoxScan, 'weight' | 'weight_suspect' | 'item_name_hebrew' | 'item_name'>,
  tr: Tr,
): string {
  const item = (b.item_name_hebrew || b.item_name || '').trim();
  return b.weight_suspect?.typical
    ? tr('palletVerify.weightSuspectRatio', { item, w: b.weight, typical: b.weight_suspect.typical.toFixed(2) })
    : tr('palletVerify.weightSuspectName', { name: b.weight_suspect?.name || item, w: b.weight });
}

/** Which of a carton's fields hold its barcode's reading (lib/barcode-reconcile.ts). */
function barcodeMarks(b: Pick<BoxScan, 'barcode_filled'>): { weight?: boolean; expiry?: boolean } | undefined {
  const f = b.barcode_filled;
  return f ? { weight: 'weight' in f, expiry: 'expiry' in f } : undefined;
}

/**
 * Is anything but a weight doubt holding this carton (`needs_review`)? The
 * same reasons the OCR hand-off and the edit panel hold one for: still
 * being read or not read, no weight, no name, no real barcode, a refused
 * expiry. A doubt alone never holds (lib/weight-review.ts).
 */
function heldForDetails(b: BoxScan): boolean {
  if (b.ocr_status === 'processing' || b.ocr_status === 'failed') return true;
  // A carton counted in units has no weight by design (lib/units-cartons.ts).
  if (!(b.weight > 0) && !isUnitsCarton(b)) return true;
  if (!(b.item_name_hebrew || b.item_name || '').trim()) return true;
  if (isProvisional(b.barcode)) return true;
  return !!validateCartonDates({ production: b.production_date, expiry: b.expiry, receiptDate: localIsoDate() }).expiryError;
}

/**
 * The short reason line under an amber carton card — why it is amber, in a
 * few words. Undefined for a carton with nothing to look at.
 */
function cardNote(b: BoxScan, tr: Tr): string | undefined {
  if (b.ocr_status === 'processing' || b.ocr_status === 'failed') return undefined;
  if (b.needs_review) {
    if (!(b.weight > 0) && !isUnitsCarton(b)) return tr('palletVerify.reviewNoWeight');
    if (!(b.item_name_hebrew || b.item_name || '').trim()) return tr('palletVerify.reviewNoName');
    if (isProvisional(b.barcode)) return tr('palletVerify.reviewNoBarcode');
    if (validateCartonDates({ production: b.production_date, expiry: b.expiry, receiptDate: localIsoDate() }).expiryError) {
      return tr('palletVerify.reviewExpiry');
    }
    return tr('palletVerify.reviewGeneric');
  }
  if (b.weight_suspect && !b.weight_checked) {
    return b.weight_suspect.typical
      ? tr('palletVerify.weightDoubtShortRatio', { typical: b.weight_suspect.typical.toFixed(2) })
      : tr('palletVerify.weightDoubtShortName', { w: b.weight });
  }
  return undefined;
}

function digitsOnly(s: string | null | undefined): string {
  return (s || '').replace(/\D/g, '');
}

// A manual capture is pushed with a placeholder id and only gets a real one
// when OCR reads the printed digits — or, failing that, when the worker types
// them. `MANUAL-…` must NEVER reach the database: it is not a barcode, so an
// outbound box-sticker scan could never match the row it created.
const PROVISIONAL_PREFIX = 'MANUAL-';
const isProvisional = (barcode: string) => barcode.startsWith(PROVISIONAL_PREFIX);

// What a carton with no readable barcode at all is booked as: the NOBC-
// marker from lib/no-barcode.ts (non-empty, visibly not a barcode).

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
  // Never a marker another row already carries (lib/no-barcode.ts).
  const taken = boxes.map((b) => b.barcode);
  return boxes.map((b, i) => {
    if (!isProvisional(b.barcode)) return b;
    const id = freeNoBarcodeId(doc, pallet, i + 1, taken);
    taken.push(id);
    return { ...b, barcode: id, sku: b.sku && !isProvisional(b.sku) ? b.sku : '' };
  });
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
 * A routine scan outcome shown over the camera for scanNoticeMs() (see
 * lib/scan-notice.ts): blue "already counted" or amber "misread". Never a
 * failure — those stay in the page's red, persistent `error`.
 */
interface ScanNotice {
  text: string;
  tone: 'info' | 'warn';
  /**
   * A short read (lib/carton-barcode.ts): offer New carton — prefilled with
   * the invoice line when the read is that line's item code, empty when it is
   * a fragment the page refused (the way out David never had, 2026-10-15).
   */
  newCarton?: { preset?: CartonCreatorPreset; label: string };
  /**
   * A short read asks "is there a long barcode?" (19/10, document 48429):
   * the notice shows "There is a long barcode" beside `newCarton` and stays
   * until answered (lib/scan-notice.ts scanNoticeMs).
   */
  short?: boolean;
  /**
   * "Different carton?": the counted carton a re-read matched, to copy into
   * a label of its own when the worker says the carton in hand is another
   * one with a byte-identical label. `box.barcode` is the code just read.
   */
  different?: {
    box: BoxScan;
    loose: boolean;
    n: number;
    /**
     * The net weight the code itself prints (a 31-digit catch-weight label,
     * lib/scan-notice.ts differentCartonOffer): the notice then offers the
     * one-tap "Another carton, same label · {kg} kg" button instead of the
     * "Different carton?" link and form.
     */
    quickWeight?: number;
    /**
     * He already answered "Same carton" for this code and the camera is
     * still on it: no sound and no "Same carton" again, but "Another carton
     * — add it" stays — a real twin read in that window must still get a way
     * in. Times out like an action notice (lib/scan-notice.ts scanNoticeMs).
     */
    sameAnswered?: boolean;
  };
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
  const { image_data: _img, photo_pending: _pending, ...rest } = b;
  return rest;
};

// A restored carton whose OCR was still running when the list was stored can
// never finish: its photo is not stored and its request belonged to the old
// page. Left 'processing' it blocks the pallet total and the single-item
// prompt for good; 'failed' opens the edit / retype path instead.
//
// And a carton held only by a weight doubt under the pre-19/10 rule loses
// that hold (lib/weight-review.ts releaseDoubtHold): the doubt stays a
// question, as it is for every carton read now.
const settleRestoredRow = (b: BoxScan): BoxScan =>
  releaseDoubtHold(b.ocr_status === 'processing' ? { ...b, ocr_status: 'failed' as OcrStatus } : b, heldForDetails);
const settleRestored = (rows: BoxScan[]): BoxScan[] => rows.map(settleRestoredRow);

/**
 * A carton's own codes for the invoice match's code step (lib/invoice-match.ts
 * — the label says which product it is, whatever name was read beside it):
 * its barcode, and the supplier code a minted label stands in for. Every
 * item_code lookup for a carton passes them (19/10: "All boxes identical"
 * took the kebab line from a meatball carton's name).
 */
// None once the worker settled the product himself (named_by_worker).
const ownCodes = cartonOwnCodes;

/** What the identical / "Different carton?" form was opened on. */
interface IdenticalTarget {
  box: BoxScan;
  loose: boolean;
  anotherOf?: number;
  listed?: number;
  replaces?: string;
}

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
  // For callbacks that finish after an await (the identical form's save).
  const confirmedBoxCountRef = useRef(0);
  useEffect(() => { confirmedBoxCountRef.current = confirmedBoxCount; }, [confirmedBoxCount]);
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
  // A finger is on the notice (touching "Different carton?"): no timeout.
  const noticeHeldRef = useRef(false);
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

  /** (Re)start the timer that takes the notice down. */
  function armNoticeTimer(ms: number) {
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = setTimeout(() => {
      noticeTimerRef.current = null;
      scanNoticeRef.current = null;
      setScanNotice(null);
    }, ms);
  }

  // The notice on screen, for the release handler below (a question has no
  // timer to re-arm).
  const scanNoticeRef = useRef<ScanNotice | null>(null);

  /** Show a notice; it replaces any current one and clears itself — unless
   *  the worker's finger is on it (see holdScanNotice), or it asks a
   *  question: then it stays until answered or replaced (scanNoticeMs). */
  function showScanNotice(notice: ScanNotice) {
    setScanNotice(notice);
    scanNoticeRef.current = notice;
    const ms = scanNoticeMs(notice);
    if (noticeHeldRef.current || ms === null) {
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
      noticeTimerRef.current = null;
    } else {
      armNoticeTimer(ms);
    }
  }

  /** A finger is on the notice: it stays up until the finger lifts. */
  function holdScanNotice() {
    noticeHeldRef.current = true;
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = null;
  }

  /** The finger lifted without tapping the action: full time again. */
  function releaseScanNotice() {
    if (!noticeHeldRef.current) return;
    noticeHeldRef.current = false;
    const current = scanNoticeRef.current;
    if (current && scanNoticeMs(current) === null) return; // a question: no timer
    armNoticeTimer(SCAN_NOTICE_ACTION_MS);
  }

  /** Take the notice down now: the worker did something that answers it. */
  function clearScanNotice() {
    if (noticeTimerRef.current) {
      clearTimeout(noticeTimerRef.current);
      noticeTimerRef.current = null;
    }
    noticeHeldRef.current = false;
    scanNoticeRef.current = null;
    setScanNotice(null);
  }

  /**
   * The blue notice for a code (or a photo's printed digits) that is already
   * on `rows`. Names the carton and asks whether the carton in hand IS that
   * carton or another one whose label is identical — two plain buttons,
   * "Same carton" and "Another carton — add it" (19/10: it used to say
   * "already counted — scan the next carton", which told a worker holding a
   * real twin to skip it). Unless an "All boxes identical" batch stands in
   * for the code: then every carton that carries it is already declared, so
   * the notice says the saved labels include it and asks nothing.
   */
  function countedNotice(
    rows: BoxScan[],
    code: string,
    hit: CountedCarton<BoxScan> | null,
    /** `twinHeld`: a one-tap twin of this code was just added and the camera
     *  is still on it (lib/scan-notice.ts noteTwinHoldRead) — no one-tap
     *  button, only the form. */
    opts: { loose: boolean; photo: boolean; twinHeld?: boolean; sameHeld?: boolean },
  ): ScanNotice {
    const lang = sessionRef.current?.language || 'English';
    if (hit && isBatchStandIn(code, hit.row)) {
      const count = standInCount(rows, code);
      return {
        text: count === 1 ? t(lang, 'terminal.coveredByLabelOne') : t(lang, 'terminal.coveredByLabels', { count }),
        tone: 'info',
      };
    }
    const n = hit?.n ?? '?';
    const offer = hit ? differentCartonOffer(code, hit.row) : null;
    // Twins already added for this code are named, so a worker unsure whether
    // his tap registered sees that it did.
    // When no row carries the code any more (the original was deleted), the
    // lookup falls back to a twin — which must not count itself as "more".
    const twins = twinCount(rows, code) - (hit?.row.twin ? 1 : 0);
    const text = t(lang, listedNoticeKey(code, hit?.row ?? null, { photo: opts.photo, twins }), { n, more: twins });
    // Nothing to ask: our own printed label, or a sticker still being read.
    if (!hit || !offer) return { text, tone: 'info' };
    if (opts.sameHeld) {
      // "Same carton" was his answer a moment ago: say so, and keep only the
      // way in for a twin (the form — never the one-tap, which a parked
      // camera would keep offering).
      return {
        text: t(lang, 'terminal.sameCartonHeld', { n }),
        tone: 'info',
        different: { box: { ...hit.row, barcode: code }, loose: opts.loose, n: hit.n, sameAnswered: true },
      };
    }
    return {
      text,
      tone: 'info',
      different: {
        box: { ...hit.row, barcode: code },
        loose: opts.loose,
        n: hit.n,
        quickWeight: offer.quick && !opts.twinHeld ? offer.weight : undefined,
      },
    };
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

  // The one-tap twin (addTwinCarton) awaits a POST: it checks after the
  // await that the worker is still on the list it tapped from.
  const phaseRef = useRef<Phase>(phase);
  useEffect(() => { phaseRef.current = phase; }, [phase]);
  // A one-tap twin's label POST is in flight: further taps do nothing (a
  // double tap must never save two cartons).
  const twinBusyRef = useRef(false);
  const [twinBusy, setTwinBusy] = useState(false);
  // The code a one-tap twin was just added for, while the camera keeps
  // re-reading it: its button is held back (lib/scan-notice.ts
  // noteTwinHoldRead) so a parked camera cannot re-offer the same tap.
  const twinHoldRef = useRef<TwinHold | null>(null);
  // "Same carton" was the answer for this code and the camera is still on
  // it: until it has been away (the twin hold's gap rule) its re-reads make
  // no sound and do not ask again — the question would be back 3 s after the
  // tap — but still show a quiet notice with "Another carton — add it", so a
  // real twin with the same label read in that window is never dropped
  // without a word (countedNotice sameHeld).
  const sameHoldRef = useRef<TwinHold | null>(null);
  // When each short code was last explained (lib/scan-notice.ts
  // shouldExplainShortRead): once a minute, not every 3 s.
  const shortReadsRef = useRef<Map<string, number>>(new Map());
  // Every short code the decoder read on this page (pallet or loose), noted
  // before any throttle: a label photo whose printed number is one of them
  // books the carton under it (lib/carton-barcode.ts labelConfirmsShortCode,
  // Wall Dan 25/10). Not the notice throttle above — booking must not hang
  // on when a notice was last shown.
  const decodedShortRef = useRef<Set<string>>(new Set());

  // A notice belongs to the screen it was raised on: a phase change (confirm,
  // next pallet, loose phase) takes it down, and starts the re-read ticks
  // afresh.
  useEffect(() => {
    if (noticeTimerRef.current) {
      clearTimeout(noticeTimerRef.current);
      noticeTimerRef.current = null;
    }
    noticeHeldRef.current = false;
    scanNoticeRef.current = null;
    setScanNotice(null);
    clearDuplicateSounds(dupSoundsRef.current);
    twinHoldRef.current = null;
    sameHoldRef.current = null;
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
  // The worker confirmed the pallet is mix ("other products too"), or tapped
  // "Done scanning?". Suppresses the single-vs-mix prompt. Per pallet. It no
  // longer opens the pallet-total input by itself — see countAsked.
  const [forcedMix, setForcedMix] = useState(false);
  const forcedMixRef = useRef(false);
  useEffect(() => { forcedMixRef.current = forcedMix; }, [forcedMix]);
  // The pallet-total input is open because the worker asked for it ("Done
  // scanning?"). Until then scanning is quiet: the input used to open by
  // itself after the 4th read carton or the first label, and came back with
  // autofocus after every scan's OCR (it hid while a sticker was read), so
  // the keyboard rose over the camera carton after carton (19/10). Per pallet.
  const [countAsked, setCountAsked] = useState(false);
  // Focus the input only on the worker's own tap (Done scanning?, Yes — only
  // this product, the pencil, Fix the number) — never on a remount.
  const [countFocusTick, setCountFocusTick] = useState(0);
  const countInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (countFocusTick > 0) countInputRef.current?.focus(); }, [countFocusTick]);
  // The list holds more cartons than the total he entered or confirmed
  // (document 48429): the question that says so and offers remove / keep /
  // fix. `via` = where it was asked: the Set button or the confirm slide.
  const [overTotal, setOverTotal] = useState<(ListAboveTotal & { via: 'submit' | 'confirm' }) | null>(null);
  // Loose pile: finishing with fewer cartons than declared asks first.
  const [looseShortAsk, setLooseShortAsk] = useState(false);
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
  // The edit panel's own red strip (typed barcode too short / duplicate, no
  // name to mint with, mint failed). Kept apart from the page-level `error`,
  // which is the scan footer's: a panel error belongs to one carton and goes
  // when the panel closes, instead of turning up under the camera afterwards
  // with nothing to say which carton it meant.
  const [editError, setEditError] = useState<string | null>(null);
  // The digits typed in the edit panel are a carton already on the list: the
  // panel offers "another carton, identical label — add it" (addTwinFromEdit).
  const [editDup, setEditDup] = useState<{ n: number; row: BoxScan; typed: string; twinOk: boolean } | null>(null);
  // Edit-a-scan: the box (by barcode) currently being edited + its in-flight
  // name/weight values. Null when no edit modal is open. Reset between pallets.
  const [editForm, setEditForm] = useState<
    {
      barcode: string;
      name_he: string;
      name_en: string;
      weight: string;
      expiry: string;
      /** ISO; shown and editable next to the expiry (lib/date-validation.ts). */
      production_date: string;
      /** Supplier batch/lot. Free text — OCR leaves it blank far more often
          than it fills it, so this is usually the only way it gets entered. */
      batch: string;
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
  // SCN-14: the figure the pallet-total input was pre-filled with, and for
  // which pallet/path ("3:m" mixed, "3:s:<name_key>" single-item). Only a
  // suggestion — the worker still taps Set; see lib/count-prefill.ts.
  const [countPrefillShown, setCountPrefillShown] = useState<CountPrefill | null>(null);
  const countPrefillKeyRef = useRef('');
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
  // Confirm slid while some weights are still doubted (lib/weight-review.ts):
  // asked once, then "Continue" books the list as read — through the confirm
  // of the render it is tapped in, never a closure kept from the slide (a
  // scan may land while the question is open). `swipeKey` remounts the slide
  // when the worker chooses to check first (it stays "confirmed").
  const [swipeKey, setSwipeKey] = useState(0);
  // Terminal chrome: bottom-sheet handle, side drawer host, lock/info toast,
  // active-card expand state, and the next-pallet number the pallet_done
  // card's "Scan pallet N" button advances to.
  const sheetRef = useRef<BottomSheetHandle>(null);
  const looseSheetRef = useRef<BottomSheetHandle>(null);
  const drawer = useDrawerHost(token);
  const { toast, showToast, showLockToast } = useLockToast(tr('terminal.lockedToast'));

  // A carton just flagged by the weight check (flagSuspectWeights) is said
  // once, out loud — the row only turns amber, and the worker is still
  // holding the box. Here, not in the state updaters, which may run twice.
  const weightToldRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const b of [...scannedBoxes, ...looseBoxes]) {
      if (!b.weight_suspect || weightToldRef.current.has(b.barcode)) continue;
      weightToldRef.current.add(b.barcode);
      trace('ui', 'weight_suspect', { barcode: b.barcode, weight: b.weight, ...b.weight_suspect });
      showToast(weightWarningText(b, tr), 'report_problem', '#fbbf5c');
    }
  }, [scannedBoxes, looseBoxes, showToast, tr]);
  const [showPallets, setShowPallets] = useState(false);
  // צור קרטון / מדבקות — mint and print a sticker for a carton that arrived
  // with none. Both are label-only: no stock is written here, the printed
  // sticker is scanned onto the pallet through the normal flow.
  const [showCartonCreator, setShowCartonCreator] = useState(false);
  // New carton opened from a short item-code read: the line it is prefilled with.
  const [cartonPreset, setCartonPreset] = useState<CartonCreatorPreset | null>(null);
  // The units save (lib/units-cartons.ts) whose cartons are open on the loose list.
  const [openUnitsBatch, setOpenUnitsBatch] = useState<string | null>(null);
  // "All boxes identical" — the captured row the worker tapped it on, and
  // which phase's list it belongs to. See IdenticalBoxesForm. `anotherOf` is
  // the "Different carton?" link on an already-counted notice: the form then
  // saves a label for ONE more carton copied from carton #anotherOf, and the
  // counted carton stays on the list (the new row is added, not swapped in).
  // The form asks for the TOTAL (19/10): `listed` = cartons of this kind
  // already on the list that stay there (the twin's same-label rows, or the
  // product's other rows for "All boxes identical"), so it saves only the
  // difference. `replaces` = a provisional photo row the twin takes the place
  // of (the edit panel's "these digits are already on the list" path).
  const [identicalFor, setIdenticalFor] = useState<IdenticalTarget | null>(null);
  const [showLabels, setShowLabels] = useState(false);
  // The Delete chip's sheet (DeleteAllSheet) and "change count" on an
  // identical-label group (GroupCountSheet) — client request (c), 2026-10-15.
  const [showDeleteAll, setShowDeleteAll] = useState(false);
  // Selection mode — the Delete chip (client 19/10, his design "WMS Receiving
  // Terminal"): a checkbox on every carton card of the open list, "Delete
  // selected (N)" / "Cancel" in the sheet's footer. Picks are barcodes
  // (lib/carton-select.ts), so a scan landing meanwhile never moves a pick.
  const [selectMode, setSelectMode] = useState(false);
  const [selectPicked, setSelectPicked] = useState<ReadonlySet<string>>(() => new Set());
  // Selection mode opened from the more-than-your-total question: how many
  // are extra, for the hint over the list. Cleared whenever the mode ends.
  const [selectExtra, setSelectExtra] = useState<number | null>(null);
  useEffect(() => { if (!selectMode) setSelectExtra(null); }, [selectMode]);
  // Where the list sheet was when selection mode raised it (restored on exit).
  const selectSheetBeforeRef = useRef<number | null>(null);
  const [countGroupFor, setCountGroupFor] = useState<{ group: string; loose: boolean } | null>(null);
  // Labels SAVED this session but not printed yet (identical / New carton /
  // edit-panel barcode). Server truth, refreshed after every save, print or
  // delete and whenever the tab comes back from the print sheet. Drives the
  // amber badge on the Labels chip and the marker on each unprinted row.
  const unprinted = useUnprintedLabels(token);
  const unprintedBarcodes = new Set(unprinted.labels.map((l) => l.barcode));
  // The rows' "Label not printed" marker — none while printing is off. The
  // real set above still drives deletes and group counts.
  const unprintedShown = unprintedMarkers(unprintedBarcodes, PRINTING);
  // The print gate (lib/label-gate.ts): the unprinted labels that stop the
  // list in front of the worker from being booked — its own cartons' labels,
  // plus every New carton label. While it is non-empty the confirm slide
  // becomes an amber "Print N labels first", and the confirm handlers refuse.
  // The completion routes enforce the same rule with a 409; this is the UX.
  // LABEL_PRINT_GATE off (the default since 2026-10-15): never blocks.
  const labelGate = printGate(
    unprinted.labels,
    (openListsForPhase(phase).loose ? looseBoxes : scannedBoxes).map((b) => b.barcode),
    // Q5: a New carton counted on a pallet already booked is not "outside
    // the job" — its unprinted label must not hold the next list.
    sessionBookedBarcodes(session),
  );
  // Barcodes already booked in this session: never picked in selection mode.
  const bookedInSession = sessionBookedBarcodes(session);
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
  // The edit panel closes on Back like its X (Wall Dan 25/10 13:26: Back with
  // the panel open closed the tab). A question notice ("short barcode — is
  // there a long one?") goes on Back like "There is a long barcode" (13:32:
  // Back there went to the morning's Baladi page). Back on the plain scanning
  // screen still leaves the page.
  useBackClose(Boolean(editForm), () => cancelEdit('back'));
  useBackClose(noticeAwaitsAnswer(scanNotice), () => {
    trace('ui', 'scan_notice_back', { short: !!scanNotice?.short });
    clearScanNotice();
  });

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

  // lib/session-owner.ts: this tab owns the scan session once it reaches a
  // scanning phase (after the loader restored the stored list). Another tab
  // opened later takes it; this one then writes nothing (`passive`) and
  // reloads when the worker comes back to it. Declared before the persist
  // effect so the claim lands before the first write.
  const sessionClaimedRef = useRef(false);
  const [passive, setPassive] = useState(false);
  const reloadingRef = useRef(false);
  useEffect(() => {
    if (sessionClaimedRef.current) return;
    if (phase !== 'scanning' && phase !== 'loose_scanning') return;
    sessionClaimedRef.current = claimSession(browserStore(), token, TAB_ID);
    trace('lifecycle', 'session_claim', { ok: sessionClaimedRef.current });
  }, [phase, token]);

  useEffect(() => {
    if (phase !== 'scanning' && phase !== 'loose_scanning') return;
    const lost = () => lostSession(browserStore(), token, TAB_ID, sessionClaimedRef.current);
    const onStorage = (e: StorageEvent) => {
      if ((e.key === ownerKey(token) || e.key === null) && lost()) {
        trace('lifecycle', 'session_taken', { by: e.newValue ? 'tab' : 'cleared' });
        setPassive(true);
      }
    };
    const onFront = () => {
      if (reloadingRef.current || document.visibilityState !== 'visible' || !lost()) return;
      // visibilitychange and focus both fire on the way back (Wall Dan 25/10
      // traced session_reload twice): reload once.
      reloadingRef.current = true;
      trace('lifecycle', 'session_reload', { phase });
      window.location.reload();
    };
    window.addEventListener('storage', onStorage);
    document.addEventListener('visibilitychange', onFront);
    window.addEventListener('pageshow', onFront);
    window.addEventListener('focus', onFront);
    return () => {
      window.removeEventListener('storage', onStorage);
      document.removeEventListener('visibilitychange', onFront);
      window.removeEventListener('pageshow', onFront);
      window.removeEventListener('focus', onFront);
    };
  }, [phase, token]);

  // This tab cleared the whole session itself (all done): the owner key went
  // with it, which is not another tab taking over.
  function releaseSession() {
    sessionClaimedRef.current = false;
  }

  // Every action that books, deletes or adds cartons asks first: a stale tab
  // that slept through the storage / visibility / focus events must not
  // confirm a pallet from its old list (browser test 18/10: it booked 3 of 5
  // and its cleanup deleted the owner's list), nor start OCR for a carton the
  // owner will never see. Uses only refs, the token and a state setter, so a
  // stale closure is fine.
  // A tab that lost the session sends nothing more to the server copy (the
  // owning tab adopts its stored outbox).
  useEffect(() => {
    if (passive) ledgerRef.current?.stop();
  }, [passive]);

  function refuseIfSessionLost(where: string): boolean {
    if (!lostSession(browserStore(), token, TAB_ID, sessionClaimedRef.current)) return false;
    trace('lifecycle', 'session_lost_refused', { where });
    setPassive(true);
    return true;
  }

  // ── Server copy of every carton (lib/scan-ledger.ts) ──
  //
  // Client 18/10: every scan saved on the server as it happens, restored from
  // the server after a reload, two open instances merged. The persist effect
  // below hands every new state of the list to the ledger, which queues what
  // changed (localStorage first, then the server, retried until taken). Each
  // time the worker is on a list, and every few seconds after, the server's
  // copy is merged in: per carton the newest change wins, so cartons scanned
  // on another tab or phone appear here and nothing is overwritten.
  const ledgerRef = useRef<ScanLedger | null>(null);
  const [ledgerStatus, setLedgerStatus] = useState<LedgerStatus>({ pending: 0, failing: false, everSynced: false });
  function ledger(): ScanLedger | null {
    if (typeof window === 'undefined') return null;
    if (!ledgerRef.current) {
      let store: Storage | null = null;
      try { store = window.localStorage; } catch { store = null; }
      let wasFailing = false;
      let wasUnavailable = false;
      ledgerRef.current = new ScanLedger(token, TAB_ID, store, undefined, (st) => {
        setLedgerStatus(st);
        if (st.failing !== wasFailing) {
          wasFailing = st.failing;
          trace('lifecycle', st.failing ? 'ledger_send_failing' : 'ledger_send_ok', { pending: st.pending });
          // The network is back (also when the browser never said "offline"):
          // read the labels of cartons scanned without it.
          if (!st.failing) window.setTimeout(() => rereadFailedLabels('send_ok'), 300);
        }
        if (!!st.unavailable !== wasUnavailable) {
          wasUnavailable = !!st.unavailable;
          trace('lifecycle', 'ledger_unavailable', { on: wasUnavailable, pending: st.pending });
        }
      }, undefined, (e) => {
        trace('lifecycle', e.kind === 'dropped' ? 'ledger_op_dropped' : 'ledger_op_requeued', e);
      });
      ledgerRef.current.setCanSend(() => !lostSession(browserStore(), token, TAB_ID, sessionClaimedRef.current));
    }
    return ledgerRef.current;
  }
  const listPallet = phase === 'loose_scanning' ? 0 : currentPallet;
  const listPhaseRef = useRef<{ phase: Phase; pallet: number }>({ phase, pallet: listPallet });
  listPhaseRef.current = { phase, pallet: listPallet };
  // Lists whose restored rows were settled on this page load (once: a row
  // whose OCR is running HERE must never be marked failed by a later merge).
  const settledListsRef = useRef<Set<number>>(new Set());

  /** Merge a server pull into a list. On the first merge of a list after the
   *  page loaded, rows whose OCR was running on a page that is gone become
   *  'failed' (retry / edit) — and that corrected state is sent. */
  function applyServerCartons(pallet: number, rows: ServerCarton[]): void {
    const L = ledger();
    if (!L) return;
    const loose = pallet === 0;
    const settle = !settledListsRef.current.has(pallet);
    settledListsRef.current.add(pallet);
    const setRows = loose ? setLooseBoxes : setScannedBoxes;
    let grewFromServer = false;
    setRows((prev) => {
      const removals = L.pendingRemovals(pallet);
      const base = removals.size ? prev.filter((r) => !removals.has(r.barcode)) : prev;
      const m = mergeServer(base, L.versionsOf(pallet), rows);
      // Only rows taken from the server copy are settled: a row scanned on
      // this page may be mid-OCR right now.
      const takenSet = new Set(m.taken);
      const list = settle
        ? m.list.map((r) => (takenSet.has(r.barcode) ? settleRestoredRow(r) : r))
        : m.list;
      // A row settle just changed is not the server's state: leave it out of
      // `taken`, so observe() sends the corrected status.
      const settledKeys = new Set<string>();
      if (settle) list.forEach((r, i) => { if (r !== m.list[i]) settledKeys.add(r.barcode); });
      L.adopt(pallet, list, m.vers, m.push, m.taken.filter((k) => !settledKeys.has(k)));
      if (!m.changed && base === prev && settledKeys.size === 0) return prev;
      trace('lifecycle', 'ledger_merge', { pallet, server: rows.filter((r) => !r.deleted).length, before: prev.length, after: list.length, push: m.push.length });
      // The dedup set follows the list: a carton the merge removed (deleted
      // on another screen) must be scannable again here.
      const dedup = loose ? looseProcessedRef.current : processedRef.current;
      const kept = new Set(dedupCodes(list));
      for (const code of dedupCodes(prev)) if (!kept.has(code)) dedup.delete(code);
      for (const code of kept) dedup.add(code);
      grewFromServer = list.length > prev.length;
      return list;
    });
    // Pallet-level state derived from the cartons (single item / mix, the
    // single-item question) follows a list that grew from the server copy —
    // e.g. a fresh phone that restored everything from the server.
    if (!loose) {
      window.setTimeout(() => {
        if (!grewFromServer) return;
        setDetectedType(detectType(scannedBoxesRef.current, acceptedMerges));
        maybeTriggerUniformPrompt(scannedBoxesRef.current, '');
      }, 60);
    }
  }

  async function syncList(pallet: number): Promise<void> {
    const L = ledger();
    if (!L || passive) return;
    L.poke();
    let rows: ServerCarton[];
    try {
      rows = await L.pull(pallet);
    } catch {
      return; // offline / not deployed yet: the local list stays, sends retry
    }
    const now = listPhaseRef.current;
    if (now.pallet !== pallet || (now.phase !== 'scanning' && now.phase !== 'loose_scanning')) return;
    if (lostSession(browserStore(), token, TAB_ID, sessionClaimedRef.current)) return;
    applyServerCartons(pallet, rows);
  }

  useEffect(() => {
    if (phase !== 'scanning' && phase !== 'loose_scanning') return;
    if (passive) return;
    const pallet = listPallet;
    ledger()?.reopen(pallet);
    void syncList(pallet);
    const tick = window.setInterval(() => {
      if (document.visibilityState === 'visible') void syncList(pallet);
    }, 5000);
    const onOnline = () => {
      trace('lifecycle', 'online', {});
      void syncList(pallet);
      rereadFailedLabels('online');
    };
    const onVisible = () => { if (document.visibilityState === 'visible') void syncList(pallet); };
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(tick);
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisible);
    };
    // syncList reads everything else through refs / the ledger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, listPallet, passive, token]);

  // Selection mode belongs to one open list: leaving it (booking, the next
  // pallet, the loose pile) ends it and deletes nothing.
  useEffect(() => {
    setSelectMode(false);
    setSelectPicked((p) => (p.size ? new Set() : p));
    selectSheetBeforeRef.current = null;
  }, [phase, listPallet]);

  // Cartons scanned without network got no label reading: read them when it
  // is back (their photo is still on this page). Each is checked again at
  // the moment it is retried, and a carton is retried once per outage.
  const rereadDoneRef = useRef<Set<string>>(new Set());
  function rereadFailedLabels(why: string): void {
    const { phase: ph, pallet } = listPhaseRef.current;
    if (ph !== 'scanning' && ph !== 'loose_scanning') return;
    const loose = pallet === 0;
    const rows = loose ? looseBoxesRef.current : scannedBoxesRef.current;
    const retry = rows
      .filter((b) => b.ocr_status === 'failed' && b.image_data && !rereadDoneRef.current.has(b.barcode))
      .slice(0, 20);
    if (!retry.length) return;
    trace('ui', 'auto_retry_ocr', { n: retry.length, why });
    retry.forEach((b, i) => {
      rereadDoneRef.current.add(b.barcode);
      window.setTimeout(() => {
        const now = (loose ? looseBoxesRef.current : scannedBoxesRef.current).find((r) => r.barcode === b.barcode);
        if (!now || now.ocr_status !== 'failed' || !now.image_data) return;
        if (loose) retryLooseOcr(b.barcode); else retryPalletOcr(b.barcode);
      }, 400 * i);
    });
  }

  /**
   * Before a list is booked: send what is queued, then take in anything the
   * server has that this screen does not (another tab / phone). True when the
   * list changed — the worker then sees the added cartons and confirms again.
   * Bounded: at most ~6 s + 4 s, then the list on the screen is booked.
   */
  async function reconcileBeforeConfirm(pallet: number): Promise<boolean> {
    const L = ledger();
    if (!L) return false;
    await Promise.race([L.flush(), new Promise((r) => setTimeout(r, 6000))]);
    let rows: ServerCarton[];
    try {
      rows = await Promise.race([
        L.pull(pallet),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('pull_timeout')), 4000)),
      ]);
    } catch (e) {
      trace('lifecycle', 'ledger_confirm_skip', { pallet, why: e instanceof Error ? e.message : String(e) });
      return false; // server copy unavailable: book what is on the screen
    }
    const loose = pallet === 0;
    const cur = loose ? looseBoxesRef.current : scannedBoxesRef.current;
    const removals = L.pendingRemovals(pallet);
    const m = mergeServer(cur.filter((r) => !removals.has(r.barcode)), L.versionsOf(pallet), rows);
    const grew = m.list.length !== cur.length || m.list.some((r, i) => r.barcode !== cur[i]?.barcode);
    if (!grew) return false;
    trace('lifecycle', 'ledger_confirm_merge', { pallet, before: cur.length, after: m.list.length });
    applyServerCartons(pallet, rows);
    return true;
  }

  // Persist in-progress scans to localStorage so a reload never loses them.
  // The phase guard makes this naturally safe vs the restore-on-mount below:
  // while phase is 'loading' nothing is written, so the loader restores first
  // and only then (phase → 'scanning') do we start mirroring to storage.
  // A tab that lost the session to a newer tab writes nothing: its list is
  // stale, and writing it is exactly what wiped 31 cartons on 18/10.
  useEffect(() => {
    if ((phase === 'scanning' || phase === 'loose_scanning')
      && lostSession(browserStore(), token, TAB_ID, sessionClaimedRef.current)) {
      setPassive(true);
      return;
    }
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
      ledger()?.observe(currentPallet, scannedBoxes);
    } else if (phase === 'loose_scanning') {
      const snap: LooseScanSnapshot = { v: 1, looseBoxes: looseBoxes.map(stripImage) };
      saveLooseScans(token, snap);
      ledger()?.observe(0, looseBoxes);
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
          clearAllScans(token); releaseSession();
          setSession(data);
          setPhase('all_done');
          return;
        }
        setSession(data);
        // Take the session BEFORE reading the stored list: an older tab that
        // still writes after this point is already refused (lib/session-owner.ts),
        // so the list read below is the last one it could write.
        if (!sessionClaimedRef.current) {
          sessionClaimedRef.current = claimSession(browserStore(), token, TAB_ID);
          trace('lifecycle', 'session_claim', { ok: sessionClaimedRef.current, at: 'load' });
        }

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
              setScannedBoxes(settleRestored(cached.scannedBoxes));
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
              setLooseBoxes(settleRestored(cachedLoose.looseBoxes));
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
            setLooseBoxes(settleRestored(cachedLoose.looseBoxes));
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
          setScannedBoxes(settleRestored(cached.scannedBoxes));
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
        setLooseBoxes(settleRestored(cachedLoose.looseBoxes));
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
      if (refuseIfSessionLost('scan')) return;
      // The pallet is being booked: a carton read now would be on no list —
      // say so (the camera already flashed) and keep the carton for later.
      if (phaseRef.current === 'confirming' || phaseRef.current === 'loose_confirming') {
        trace('ui', 'scan_refused_while_booking', { barcode: read });
        showToast(tr('palletVerify.scanWhileSaving'), 'hourglass_top', '#fbbf5c');
        return;
      }
      // Every camera read moves the twin and same-carton holds on (a
      // different code releases them).
      const now = Date.now();
      const twinHeld = noteTwinHoldRead(twinHoldRef, read, now);
      const sameHeld = noteTwinHoldRead(sameHoldRef, read, now);
      // A read that cannot be a carton barcode (a fragment, a failed check
      // digit) is a misread: show the digits, store nothing (SCN-13).
      const verdict = classifyRead(read);
      trace('ui', 'scan_detected', { barcode: read, pallet: currentPalletRef.current, ok: verdict.ok, reason: verdict.ok ? undefined : verdict.reason, duplicate: processedRef.current.has(read), has_image: !!imageData, twin_held: twinHeld || undefined, same_held: sameHeld || undefined });
      // A short serial a label photo already booked (Wall Dan 408274, 25/10)
      // is on the list: the blue "already on the list" notice below, not the
      // amber short-code one. Every short read is noted first, before any
      // throttle — a later photo of the sticker is checked against it.
      const tooShort = !verdict.ok && verdict.reason === 'too_short';
      if (tooShort) decodedShortRef.current.add(read);
      const bookedSerial = tooShort && processedRef.current.has(read);
      if (!verdict.ok && !bookedSerial) {
        if (verdict.reason === 'pallet_label') {
          // The supplier's shipping-pallet label: keep it as the pallet's
          // identity, never as a carton (MEV-10 — IN264172698 booked it as
          // a sixth carton). Neutral cue, no red hold.
          setSupplierPalletRef(read);
          showToast(t(sessionRef.current?.language || 'English', 'terminal.palletLabelRead', { digits: read }), 'local_shipping');
          return;
        }
        if (verdict.reason === 'too_short') {
          if (handleShortItemCode(read, false, now)) return;
          // Explained once a minute per code, then quiet (no buzz, no flash).
          if (!shouldExplainShortRead(shortReadsRef.current, read, now)) return;
        }
        const acceptAnyway = verdict.reason === 'checksum' && noteRepeatedRead(refusedReadsRef.current, read);
        if (!acceptAnyway) {
          dupFlashRef.current?.('rejected');
          scanDuplicateFeedback();
          // Amber: one small action (scan it again), nothing failed for good.
          showScanNotice(refusedReadNotice(read, verdict.reason));
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
        // red. It asks "same carton, or another carton with an identical
        // label?" — "Another carton — add it" is the explicit way in for a
        // physically different carton whose label is byte-identical.
        const hit = findCountedCarton(scannedBoxesRef.current, read);
        // He just said "Same carton" and the camera is still on it: no sound,
        // no question again — but never silent (a real twin with the same
        // label must still find "Another carton — add it").
        if (!sameHeld && shouldSoundDuplicate(dupSoundsRef.current, read, now)) scanAlreadyCountedFeedback();
        showScanNotice(countedNotice(scannedBoxesRef.current, read, hit, { loose: false, photo: false, twinHeld, sameHeld }));
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
        const ocr = runOcr(barcode, imageData, capturedIndex);
        // Archive the same frame — after the OCR call settles, success or
        // not, so a box whose OCR fails (the one the worker will retype, and
        // the one most worth a picture) still keeps its photo. Not alongside
        // it: the two ~450 KB uploads used to share the phone's uplink, and
        // the OCR request reached the bot ~5 s after the scan (2026-10-03).
        archiveStickerPhoto(barcode, imageData, 'pallet', ocr);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  // ── Short reads (2026-10-15, IN26013461) ──
  // SmartScanner: a too-short read never arms its 3 s cooldown (that dropped
  // the carton's real code read a moment later — 192 drops on 10-15). The
  // page still hears it (throttled) for its notice; nothing is counted from
  // a short read either way, so it never gets the "saved" hold.
  const acceptScannerValue = useCallback((v: string) => {
    const verdict = classifyRead(v.trim());
    return verdict.ok || verdict.reason !== 'too_short';
  }, []);

  // Plain functions over refs and setters: the frozen-closure detect handlers
  // call the first render's copies.

  /** The amber "misread / only a short barcode" notice. A short read says
   *  plainly that it does not identify a carton and asks: "There is a long
   *  barcode" (aim at it) or "None — add cartons" (New carton); the text
   *  also names the photo. A carton whose only code is short has no other
   *  way onto the list (document 48429, 406243). */
  function refusedReadNotice(read: string, reason: string): ScanNotice {
    const lang = sessionRef.current?.language || 'English';
    const tooShort = reason === 'too_short';
    return {
      text: t(lang, tooShort ? 'terminal.barcodeTooShort' : 'terminal.barcodeMisread', { digits: read }),
      tone: 'warn',
      newCarton: tooShort ? { label: t(lang, 'terminal.tooShortNewCarton') } : undefined,
      short: tooShort || undefined,
    };
  }

  /**
   * A short read that is an invoice line's item code (`501004`): the carton
   * has no unique barcode, so nothing is counted from the read. New carton
   * opens prefilled with that line — once per code per list; after that a
   * calm notice asks "is there a long barcode?" with the button that reopens
   * it, once a minute per code (the camera re-reads the code the moment the
   * form closes). The worker states the count and expiry and saves. Returns
   * false when the read matches no line.
   */
  const shortCodeOpenedRef = useRef<Set<string>>(new Set());
  /** Item codes a New carton was saved for from a short-code preset this
   *  session — their labels outlive Delete all, so a re-open must not prefill
   *  the line's remaining count again. */
  const shortCodeSavedItemsRef = useRef<Set<string>>(new Set());
  function handleShortItemCode(read: string, loose: boolean, now: number): boolean {
    const lines = sessionRef.current?.ocr_data ?? [];
    const line = matchInvoiceShortCode(read, lines);
    if (!line) return false;
    const lang = sessionRef.current?.language || 'English';
    const list = loose ? looseBoxesRef.current : scannedBoxesRef.current;
    const counted = list.filter(
      (b) => matchInvoiceItem(b.item_name_hebrew, b.item_name, lines, ownCodes(b))?.item_code === line.item_code,
    ).length;
    // The open list is all `counted` sees: when the line can also sit on
    // another pallet, the loose pile, or New-carton labels already saved for
    // it this session, don't prefill "the rest of the line" (accepting it
    // would book the line twice) — default 1, line total as a hint.
    const s = sessionRef.current;
    const lineMaySpread = (s?.pallet_count || 1) > 1 || (s?.loose_box_count || 0) > 0
      || shortCodeSavedItemsRef.current.has(String(line.item_code ?? ''));
    const { weight, quantity, lineTotal } = shortCodeDefaults(line, counted, { lineMaySpread });
    const preset: CartonCreatorPreset = {
      item: line, weight, quantity, lineTotal: lineMaySpread ? lineTotal : null,
      notice: t(lang, 'carton.shortCodeNotice', { code: read }),
    };
    const key = `${loose ? 0 : currentPalletRef.current}:${read}`;
    const open = !shortCodeOpenedRef.current.has(key);
    trace('ui', 'scan_short_item_code', {
      barcode: read, item_code: line.item_code, pallet: loose ? 0 : currentPalletRef.current,
      counted, weight, quantity, line_may_spread: lineMaySpread, opened: open,
    });
    if (open) {
      // The form says it itself (carton.shortCodeNotice): no notice behind it.
      shortCodeOpenedRef.current.add(key);
      openCartonCreator(preset);
    } else if (shouldExplainShortRead(shortReadsRef.current, read, now)) {
      // Once a minute per code — not every ~3 s while the camera sees it.
      showScanNotice({
        text: t(lang, 'terminal.shortItemCode', { code: read }),
        tone: 'info',
        newCarton: { preset, label: t(lang, 'terminal.shortItemCodeAction') },
        short: true,
      });
    }
    return true;
  }

  function openCartonCreator(preset?: CartonCreatorPreset) {
    trace('ui', 'carton_creator_open', preset
      ? { item_code: preset.item.item_code, weight: preset.weight, quantity: preset.quantity }
      : undefined);
    setCartonPreset(preset ?? null);
    setShowCartonCreator(true);
  }

  // ── Manual capture — barcode wouldn't decode (glare/fold/tear) ──
  // No decoded barcode here, so we register a provisional box and let OCR
  // resolve its real identity (the printed digit string) + dedupe afterwards.

  const handleManualCapture = useCallback((imageData: string) => {
    if (refuseIfSessionLost('manual_capture')) return;
    if (phaseRef.current === 'confirming' || phaseRef.current === 'loose_confirming') {
      trace('ui', 'scan_refused_while_booking', { manual: true });
      showToast(tr('palletVerify.scanWhileSaving'), 'hourglass_top', '#fbbf5c');
      return;
    }
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
    for (const code of gone) {
      processedRef.current.delete(code);
      uploadedStickersRef.current.delete(photoUploadKey('pallet', currentPalletRef.current, code));
    }
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
  function discardSavedLabel(barcode: string | undefined, includeNewCarton = false) {
    if (!barcode || !isMintedLabelBarcode(barcode)) return;
    fetch(
      `/api/carton-labels?token=${encodeURIComponent(token)}&barcode=${encodeURIComponent(barcode)}${includeNewCarton ? '&include_new=1' : ''}`,
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
  //
  // One upload per list row (lib/photo-rows.ts), not per barcode for the
  // page's life: pallet 2's sample of a product photographed on pallet 1 has
  // to upload too (IN26013461). The URL lands on the row and on every row
  // minted from it, even when "all boxes identical" replaced the sample
  // before the upload finished; until then those rows say "uploading".
  const uploadedStickersRef = useRef<Set<string>>(new Set());

  function archiveStickerPhoto(
    barcode: string,
    imageData: string,
    target: 'pallet' | 'loose',
    after?: Promise<unknown>,
  ) {
    if (!barcode || !imageData) return;
    // Guards a retried OCR, a re-render, and StrictMode's double-invoked
    // updater — all three would otherwise upload the same frame twice.
    const key = photoUploadKey(target, currentPalletRef.current, barcode);
    if (uploadedStickersRef.current.has(key)) return;
    uploadedStickersRef.current.add(key);

    const setRows = target === 'loose' ? setLooseBoxes : setScannedBoxes;
    const mark = (fields: Partial<BoxScan>) =>
      setRows((prev) => prev.map((b) => (photoBelongsTo(b, barcode) ? { ...b, ...fields } : b)));
    mark({ photo_pending: true });

    const started = Date.now();
    let bytes = 0;
    (after ?? Promise.resolve())
      .catch(() => {})
      .then(() => compressPhoto(imageData))
      .then((image) => {
        bytes = dataUrlBytes(image);
        return fetch('/api/cloudinary/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            image,
            barcode,
            document_number: sessionRef.current?.document_number,
            image_type: 'box',
          }),
        });
      })
      .then((r) => r.json())
      .then((data) => {
        if (!data?.success || !data.secure_url) throw new Error(data?.error || 'no url');
        mark({ image_url: data.secure_url, photo_pending: undefined });
        trace('ui', 'photo_upload_ok', { barcode, target, ms: Date.now() - started, bytes });
      })
      .catch((e) => {
        mark({ photo_pending: undefined });
        trace('ui', 'photo_upload_failed', {
          barcode, target, ms: Date.now() - started, bytes,
          error: e instanceof Error ? e.message : String(e),
        });
        // Let a later retry try again rather than marking this frame done.
        uploadedStickersRef.current.delete(key);
      });
  }

  // ── OCR helper ──

  /**
   * The weight and expiry to book for a carton the OCR just read: its own
   * reading, unless the carton's 31-digit barcode says otherwise
   * (lib/barcode-reconcile.ts). Fills, real disagreements and the barcode
   * values a guard refused go to scanner_events; the worker is told nothing.
   */
  function barcodeReading(
    ocr: { weight_kg?: number | null; expiry_date?: string | null; barcode_digits?: string | null },
    manual: boolean,
    lookupKey: string,
    list: BoxScan[],
    where: 'pallet' | 'loose',
  ) {
    const code = manual ? digitsOnly(ocr.barcode_digits) : lookupKey;
    const r = reconcileWithBarcode(
      code,
      { weight: ocr.weight_kg, expiry: ocr.expiry_date },
      { receivedIso: localIsoDate(), typicalKg: typicalWeightFor(code, list), trusted: !manual },
    );
    traceBarcodeEvents(code, r.events, where, 'ocr');
    return r;
  }

  /** The confirm payload's last pass: rows the OCR hand-off did not settle. */
  function bookWithBarcode(rows: BoxScan[], where: 'pallet' | 'loose'): BoxScan[] {
    const { rows: out, events } = applyBarcodeReadings(rows, localIsoDate());
    for (const { barcode_digits, ...e } of events) traceBarcodeEvents(barcode_digits, [e], where, 'confirm');
    return out;
  }

  function traceBarcodeEvents(code: string, events: BarcodeEvent[], where: 'pallet' | 'loose', at: 'ocr' | 'confirm') {
    for (const e of events) trace('ui', 'barcode_reading', { carton: code, where, at, ...e });
  }

  /**
   * A scanned carton whose label read failed keeps what the scanner already
   * knows (lib/failed-read.ts): its 31-digit barcode's weight and expiry, and
   * the name of the invoice line its own code is. It stays 'failed', so the
   * gate still has the worker look; one Save settles it. Computed out of the
   * state updater, like barcodeReading, so the trace is not doubled.
   */
  function failedReadPatch(lookupKey: string, list: BoxScan[], where: 'pallet' | 'loose'): Partial<BoxScan> {
    const row = list.find((b) => b.barcode === lookupKey);
    if (!row) return {};
    const { patch, events } = failedReadPrefill(row, invoiceItemsRef.current, {
      receivedIso: localIsoDate(),
      typicalKg: typicalWeightFor(row.barcode, list),
    });
    traceBarcodeEvents(row.barcode, events, where, 'ocr');
    if (Object.keys(patch).length) {
      trace('ui', 'failed_read_prefill', {
        carton: row.barcode, where, weight: patch.weight, expiry: patch.expiry, item: patch.item_name_hebrew ?? patch.item_name,
      });
    }
    return patch;
  }

  /**
   * A read answering after the worker already saved its row (lib/failed-read.ts
   * takesLateRead): the confirm failed it at 30 s, he opened it and saved, and
   * the fetch only now comes back. Dropped — his Save stands. Read off the ref
   * so the side effects (toast, trace) are skipped too; the updaters repeat
   * the check on `prev`, which the ref may trail.
   */
  function lateReadDropped(lookupKey: string, where: 'pallet' | 'loose', ok: boolean): boolean {
    const list = where === 'loose' ? looseBoxesRef.current : scannedBoxesRef.current;
    const row = list.find((b) => b.barcode === lookupKey);
    if (!row || takesLateRead(row)) return false;
    trace('ui', 'late_read_dropped', { carton: lookupKey, where, ok, status: row.ocr_status });
    return true;
  }

  /**
   * Before a list is booked: label reads still in flight are waited for,
   * bounded (S03, 23/10 — a 40 s stall; a swipe in that window booked a
   * carton with no name and 0 kg). A read still out after the wait is failed
   * here. False sends the worker back to the list — a read that came back
   * failed or flagged, or (where warnings block) any failed read at all:
   * the gate there holds it and the amber footer opens it.
   */
  async function settleReadsBeforeBook(where: 'pallet' | 'loose'): Promise<boolean> {
    const ref = where === 'loose' ? looseBoxesRef : scannedBoxesRef;
    const waitedFor = new Set(ref.current.filter((b) => b.ocr_status === 'processing').map((b) => b.barcode));
    if (waitedFor.size) {
      const started = Date.now();
      const inFlight = () => ref.current.filter((b) => waitedFor.has(b.barcode) && b.ocr_status === 'processing');
      const settled = await waitForReads(() => inFlight().length > 0);
      trace('ui', 'confirm_waited_reads', { where, n: waitedFor.size, ms: Date.now() - started, settled });
      if (!settled) {
        const patches = new Map(inFlight().map((b) => [b.barcode, failedReadPatch(b.barcode, ref.current, where)]));
        const fail = (prev: BoxScan[]) => prev.map((b) => (
          patches.has(b.barcode) && b.ocr_status === 'processing'
            ? { ...b, ...patches.get(b.barcode), ocr_status: 'failed' as OcrStatus }
            : b
        ));
        if (where === 'loose') setLooseBoxes(fail); else setScannedBoxes(fail);
        trace('ui', 'confirm_read_timeout', { where, cartons: Array.from(patches.keys()) });
        return false;
      }
    }
    const held = heldAfterReads(ref.current, waitedFor, {
      soft: where === 'pallet' && !!sessionRef.current?.meat_discrepancy,
    });
    if (held.length) {
      trace('ui', 'confirm_held_reads', { where, cartons: held });
      return false;
    }
    return true;
  }

  function runOcr(lookupKey: string, imageData: string, capturedIndex: number, manual = false): Promise<void> {
    // Pass the invoice catalog so the bot's OCR prompt picks a known canonical
    // Hebrew name (closed set) instead of free-form reading.
    const candidates = invoiceItemsRef.current.map((it) => ({
      name_hebrew: it.item_name_hebrew,
      name_english: it.item_name_english,
      code: it.item_code,
    }));
    return fetch('/api/multi-pallet-ocr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: imageData, barcode: manual ? '' : lookupKey, candidates, token }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (lateReadDropped(lookupKey, 'pallet', !!(data?.success && data.ocr_data))) return;
        // Do the printed digits identify the carton? 13+, or a short serial
        // the decoder read too (Wall Dan 408274, 25/10 — it used to become
        // NOBC-…, and a second photo of it a second carton). Decided once,
        // out here, so the notice and the updater below agree.
        const ownDigits = manual && data?.success && data.ocr_data
          ? printedDigitsIdentifyCarton(
              digitsOnly(data.ocr_data.barcode_digits), decodedShortRef.current,
              sessionRef.current?.ocr_data, scannedBoxesRef.current.map((b) => b.barcode),
            )
          : false;
        // A manual capture whose printed digits are a carton already on the
        // list: drop the provisional row and SAY so, naming the carton the
        // photo actually shows. Decided out here, not in the updater below (a
        // state updater may run twice under StrictMode — a doubled notice
        // and trace). It used to be dropped silently, while the footer kept
        // naming whatever carton an earlier re-read had (IN264172698: three
        // captures of #9 under a line blaming #8).
        if (manual && data?.success && data.ocr_data) {
          const digits = digitsOnly(data.ocr_data.barcode_digits);
          const hit = ownDigits
            ? findCountedCartonByDigits(scannedBoxesRef.current, digits, lookupKey)
            : null;
          if (hit) {
            trace('ui', 'manual_capture_duplicate', { provisional: lookupKey, digits, of: hit.n });
            dupFlashRef.current?.('duplicate');
            scanAlreadyCountedFeedback();
            showScanNotice(countedNotice(scannedBoxesRef.current, digits, hit, { loose: false, photo: true }));
            highlightRow(hit.row.barcode);
            setScannedBoxes((prev) => prev.filter((b) => b.barcode !== lookupKey));
            return;
          }
        }

        // Barcode wins (client rule, 19/10 — lib/barcode-reconcile.ts): a
        // 31-digit carton barcode's weight and expiry are what gets booked,
        // with no toast and no question. Computed out here, not in the
        // updater: it depends only on the OCR result, the box's own barcode
        // and the rest of the list, and a state updater may run twice
        // (StrictMode) — which would double-trace. For a manual capture the
        // code is the OCR'd digit string (what `resolvedBarcode` becomes
        // below), which may only fill a blank.
        const reading = data?.success && data.ocr_data ? barcodeReading(data.ocr_data, manual, lookupKey, scannedBoxesRef.current, 'pallet') : null;
        // The carton's own code (the scanned barcode, or a photo's printed
        // digits) comes first when the name is snapped to an invoice line,
        // and a name that points at another line is kept as a question, not
        // obeyed (IN264191356: meatball digits, kebab name). Out here for the
        // same reason as `conflict`: the toast must not double.
        const codesRead = data?.ocr_data
          ? [manual ? digitsOnly(data.ocr_data.barcode_digits) : lookupKey]
          : [];
        const nameConflict = data?.ocr_data
          ? invoiceNameConflict(
              data.ocr_data.product_name_hebrew || '', data.ocr_data.product_name_english || '',
              invoiceItemsRef.current, codesRead,
            )
          : null;
        // A failed read keeps what the barcode and the invoice already say
        // (lib/failed-read.ts) — out here for the same reason as `reading`.
        const failPatch = data?.success && data.ocr_data ? null : failedReadPatch(lookupKey, scannedBoxesRef.current, 'pallet');

        setScannedBoxes((prev) => {
          // find the box by its (provisional, for manual) barcode key
          const idx = prev.findIndex((b) => b.barcode === lookupKey);
          if (idx === -1) return prev;
          if (!takesLateRead(prev[idx])) return prev; // saved by the worker meanwhile

          if (!(data.success && data.ocr_data)) {
            return prev.map((b, i) => (i === idx ? { ...b, ...failPatch, ocr_status: 'failed' as OcrStatus } : b));
          }

          const rawHe = data.ocr_data.product_name_hebrew || '';
          const rawEn = data.ocr_data.product_name_english || '';
          // Snap the OCR'd name to the closest invoice item so drift
          // ("כדורי עוף" vs "כדורי עוף-ת. הזנה") groups as one canonical
          // item. No confident match (e.g. loose/unlisted box) → keep raw.
          const match = matchInvoiceItem(rawHe, rawEn, invoiceItemsRef.current, codesRead);

          // Manual capture: there was no decoded barcode, so resolve this box's
          // dedupe identity from the OCR'd printed digit string.
          let resolvedBarcode = prev[idx].barcode;
          let resolvedSku = prev[idx].sku;
          let needsReview = false;
          if (manual) {
            const digits = digitsOnly(data.ocr_data.barcode_digits);
            if (ownDigits) {
              // Dedupe against every OTHER box (bar-scanned or manual) by the
              // FULL printed number — not the SKU, which repeats per product.
              // The notice was raised above; this only catches a row the ref
              // had not caught up with yet, so a carton is never counted twice.
              // Same lookup as the notice: a label an identical batch stands
              // in for counts as on the list.
              const dup = findCountedCartonByDigits(prev, digits, lookupKey) !== null;
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
            } else if (unreadDigitsOutcome({
              nameHebrew: data.ocr_data.product_name_hebrew,
              nameEnglish: data.ocr_data.product_name_english,
              weightKg: data.ocr_data.weight_kg,
            }) === 'book_without_barcode') {
              // BOT-32: the digits were not read, but the name and the weight
              // were — the carton is captured. Book it under a no-barcode
              // marker, no warning, no gate. "Type digits" / "Create label"
              // stay one tap away in the edit panel.
              resolvedBarcode = freeNoBarcodeId(
                sessionRef.current?.document_number || '', currentPalletRef.current, idx + 1,
                prev.filter((_, i) => i !== idx).map((b) => b.barcode),
              );
              resolvedSku = '';
              trace('ui', 'manual_capture_no_digits', { provisional: lookupKey, booked_as: resolvedBarcode });
            } else {
              needsReview = true; // nothing usable read → the worker has to look
            }
          }
          // Even when OCR "succeeded", flag the box if the model didn't return
          // a usable name OR a positive weight. These rows would otherwise ship
          // to Airtable as blanks; the worker must open the edit modal, see
          // the captured sticker, and fix them before advancing.
          const heName = (data.ocr_data.product_name_hebrew || '').trim();
          const enName = (data.ocr_data.product_name_english || '').trim();
          // The barcode's weight counts: a carton it weighs is not a blank.
          const weight = reading?.weight ?? 0;
          const expiry = reading?.expiry ?? '';
          if ((!heName && !enName) || !(weight > 0)) {
            needsReview = true;
          }
          // A read expiry on/before today or on/before the read production
          // date is refused, not booked: the worker must fix or clear it in
          // the edit panel before the pallet closes (lib/date-validation.ts).
          if (validateCartonDates({
            production: data.ocr_data.production_date,
            expiry,
            receiptDate: localIsoDate(),
          }).expiryError) {
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
              weight,
              expiry,
              // Same sticker, same OCR call — these were read and thrown away
              // until 2026-09. Priority needs the production date to open its
              // batch, and the supplier's lot code for traceability/recall.
              production_date: data.ocr_data.production_date || '',
              supplier_batch: data.ocr_data.supplier_batch || '',
              needs_review: needsReview || undefined,
              barcode_filled: reading && Object.keys(reading.filled).length ? reading.filled : undefined,
              name_conflict: nameConflict
                ? {
                    ocr: rawHe || rawEn,
                    line: {
                      item_code: String(nameConflict.byName.item_code ?? ''),
                      item_name_hebrew: nameConflict.byName.item_name_hebrew || '',
                      item_name_english: nameConflict.byName.item_name_english || '',
                    },
                  }
                : undefined,
            };
          });
          const checked = flagSuspectWeights(updated, { [resolvedBarcode]: [rawHe, rawEn] });
          setDetectedType(detectType(checked, acceptedMerges));
          // Check if the box that just finished OCR triggers a uniform-pair prompt.
          maybeTriggerUniformPrompt(checked, resolvedBarcode);
          // Manual capture had no decoded barcode at scan time, so this is the
          // first moment the photo can be filed under the box's real identity.
          // (Bar-scanned boxes already uploaded at detection; the ref guard
          // makes a second call here a no-op either way.)
          if (manual) archiveStickerPhoto(resolvedBarcode, imageData, 'pallet');
          return checked;
        });

        // Code and name name two products: booked as the code says, and the
        // worker hears it while he still holds the carton (soft — Edit or
        // the identical form's "which product?" changes it).
        if (nameConflict) {
          trace('ui', 'name_code_conflict', {
            barcode: lookupKey, code_item: nameConflict.byCode.item_code, name_item: nameConflict.byName.item_code,
            ocr_name: data.ocr_data.product_name_hebrew || data.ocr_data.product_name_english || '',
          });
          showToast(
            tr('palletVerify.nameCodeConflict', {
              code: nameConflict.byCode.item_name_hebrew || nameConflict.byCode.item_name_english,
              ocr: (data.ocr_data.product_name_hebrew || data.ocr_data.product_name_english || '').trim(),
            }),
            'report_problem', '#fbbf5c',
          );
        }
      })
      .catch(() => {
        if (lateReadDropped(lookupKey, 'pallet', false)) return;
        const failPatch = failedReadPatch(lookupKey, scannedBoxesRef.current, 'pallet');
        setScannedBoxes((prev) => {
          const idx = prev.findIndex((b) => b.barcode === lookupKey);
          if (idx === -1) return prev;
          if (!takesLateRead(prev[idx])) return prev;
          return prev.map((b, i) => (i === idx ? { ...b, ...failPatch, ocr_status: 'failed' } : b));
        });
      });
  }

  // Does the current scan set look like ONE product whose boxes all weigh the
  // same? That is the only configuration where the worker may scan a couple of
  // samples and declare the total instead of scanning every box — the domain
  // rule being that a single item on a pallet is either all-same-weight or
  // all-different-weights. Returns the group description, or null. The rule
  // itself — exact weights, no minted rows, never a label that prints its own
  // weight — is lib/uniform-candidate.ts.
  function uniformCandidateFrom(
    done: BoxScan[],
    merges: Map<string, string> = acceptedMerges,
  ): Omit<UniformPrompt, 'mode'> | null {
    return uniformCandidate(
      done,
      (b) => merges.get(groupKeyForBox(b)) ?? groupKeyForBox(b),
      { minSamples: UNIFORM_MIN_SAMPLES, tolerance: UNIFORM_WEIGHT_TOLERANCE },
    );
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
    if (candidate) {
      trace('ui', 'uniform_prompt_shown', { pallet: currentPalletRef.current, weight: candidate.avg_weight, samples: candidate.sample_barcodes, restored: true });
      setPendingUniformPrompt({ mode: 'single_or_mix', ...candidate });
    }
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
      if (!candidate) {
        trace('ui', 'uniform_prompt_retracted', { pallet: currentPalletRef.current });
        setPendingUniformPrompt(null);
      } else if (candidate.sample_barcodes.length !== pendingUniformPromptRef.current.sample_barcodes.length) {
        // He kept scanning the same carton type past the question: the
        // question and the count form say how many are scanned, so keep the
        // sample list in step ("2 identical cartons" with 4 on the list).
        setPendingUniformPrompt({ mode: 'single_or_mix', ...candidate });
      }
      return;
    }
    if (!candidate) return;
    trace('ui', 'uniform_prompt_shown', { pallet: currentPalletRef.current, weight: candidate.avg_weight, samples: candidate.sample_barcodes });
    setPendingUniformPrompt({ mode: 'single_or_mix', ...candidate });
  }

  // ── Loose box barcode detected ──

  const handleLooseBarcodeDetected = useCallback(
    (_barcode: string, _parsed: ParsedBarcode, imageData?: string) => {
      const read = _barcode.trim();
      if (refuseIfSessionLost('scan')) return;
      // The pallet is being booked: a carton read now would be on no list —
      // say so (the camera already flashed) and keep the carton for later.
      if (phaseRef.current === 'confirming' || phaseRef.current === 'loose_confirming') {
        trace('ui', 'scan_refused_while_booking', { barcode: read });
        showToast(tr('palletVerify.scanWhileSaving'), 'hourglass_top', '#fbbf5c');
        return;
      }
      // Every camera read moves the twin and same-carton holds on (a
      // different code releases them).
      const now = Date.now();
      const twinHeld = noteTwinHoldRead(twinHoldRef, read, now);
      const sameHeld = noteTwinHoldRead(sameHoldRef, read, now);
      const verdict = classifyRead(read);
      trace('ui', 'loose_scan_detected', { barcode: read, ok: verdict.ok, reason: verdict.ok ? undefined : verdict.reason, duplicate: looseProcessedRef.current.has(read), has_image: !!imageData, twin_held: twinHeld || undefined, same_held: sameHeld || undefined });
      // A short serial a label photo already booked — see the pallet phase.
      const tooShort = !verdict.ok && verdict.reason === 'too_short';
      if (tooShort) decodedShortRef.current.add(read);
      const bookedSerial = tooShort && looseProcessedRef.current.has(read);
      if (!verdict.ok && !bookedSerial) {
        if (verdict.reason === 'pallet_label') {
          showToast(t(sessionRef.current?.language || 'English', 'terminal.palletLabelRead', { digits: read }), 'local_shipping');
          return;
        }
        if (verdict.reason === 'too_short') {
          if (handleShortItemCode(read, true, now)) return;
          // Explained once a minute per code, then quiet (no buzz, no flash).
          if (!shouldExplainShortRead(shortReadsRef.current, read, now)) return;
        }
        const acceptAnyway = verdict.reason === 'checksum' && noteRepeatedRead(refusedReadsRef.current, read);
        if (!acceptAnyway) {
          looseDupFlashRef.current?.('rejected');
          scanDuplicateFeedback();
          showScanNotice(refusedReadNotice(read, verdict.reason));
          return;
        }
        trace('ui', 'loose_scan_accepted_as_printed', { barcode: read });
        showToast(t(sessionRef.current?.language || 'English', 'terminal.barcodeAcceptedAsPrinted', { digits: read }), 'check');
      }
      const barcode = read;
      if (looseProcessedRef.current.has(read)) {
        // Already on the loose list — same blue notice as the pallet phase.
        const hit = findCountedCarton(looseBoxesRef.current, read);
        if (!sameHeld && shouldSoundDuplicate(dupSoundsRef.current, read, now)) scanAlreadyCountedFeedback();
        showScanNotice(countedNotice(looseBoxesRef.current, read, hit, { loose: true, photo: false, twinHeld, sameHeld }));
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
        const ocr = runLooseOcr(barcode, imageData);
        archiveStickerPhoto(barcode, imageData, 'loose', ocr);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  // Manual capture for the loose phase — same fallback as the pallet phase.
  const handleLooseManualCapture = useCallback((imageData: string) => {
    if (refuseIfSessionLost('loose_manual_capture')) return;
    if (phaseRef.current === 'confirming' || phaseRef.current === 'loose_confirming') {
      trace('ui', 'scan_refused_while_booking', { manual: true });
      showToast(tr('palletVerify.scanWhileSaving'), 'hourglass_top', '#fbbf5c');
      return;
    }
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
    const released = dropLooseRows(new Set([barcode]));
    trace('ui', 'loose_delete_box', { barcode, released: released.length ? released : undefined });
    discardSavedLabel(barcode);
  }

  // Take rows off the loose list (the row's Delete, Delete selected). Same
  // release rule as dropPalletRows: the last row of an identical batch frees
  // its supplier code. Returns the supplier codes it released.
  function dropLooseRows(gone: ReadonlySet<string>): string[] {
    const released = releasedSources(looseBoxesRef.current, gone);
    setLooseBoxes((prev) => prev.filter((b) => !gone.has(b.barcode)));
    for (const code of gone) {
      looseProcessedRef.current.delete(code);
      uploadedStickersRef.current.delete(photoUploadKey('loose', 0, code));
    }
    for (const code of released) looseProcessedRef.current.delete(code);
    clearDuplicateSounds(dupSoundsRef.current);
    clearScanNotice();
    return released;
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
    setCountFocusTick((n) => n + 1);
  }

  // Worker backed out of "Single-item" choice → drop the captured group and
  // go back to scanning (mix path); "Done scanning?" opens the total.
  function handleCancelSingleConfirm() {
    trace('ui', 'cancel_single_confirm', { pallet: currentPallet });
    setPendingSingleGroup(null);
    setBoxCountInput('');
    setPalletCountError(null);
  }

  // "Or print a label for each carton": the All-boxes-identical form on the
  // first sample, the other samples counted in its total (openIdentical).
  // The question stays until the labels are saved — they retract it (minted
  // rows) — so Back from the form returns to it.
  function uniformLabelSample(): BoxScan | undefined {
    const p = pendingUniformPrompt;
    if (!p) return undefined;
    return p.sample_barcodes
      .map((code) => scannedBoxes.find((b) => b.barcode === code))
      .find((b): b is BoxScan => !!b && canDeclareIdentical(b));
  }

  function handleUniformAsLabels() {
    const sample = uniformLabelSample();
    trace('ui', 'uniform_labels', { pallet: currentPallet, sample: sample?.barcode });
    if (sample) openIdentical(sample, false);
  }

  function handleContinueAsMix() {
    trace('ui', 'continue_as_mix', { pallet: currentPallet, scanned: scannedBoxes.length });
    setForcedMix(true);            // pallet is mix → scan all; "Done scanning?" opens the total
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
    setEditError(null);
    setEditDup(null);
    clearScanNotice();
    setEditForm({
      barcode: box.barcode,
      name_he: box.item_name_hebrew || '',
      name_en: box.item_name || '',
      // A units carton edits its units in the weight's place (lib/units-cartons.ts).
      weight: isUnitsCarton(box) ? String(box.units) : box.weight > 0 ? String(box.weight) : '',
      // Always ISO in the editor, whatever an older row carries — see lib/expiry.ts.
      expiry: normalizeExpiry(box.expiry),
      production_date: normalizeExpiry(box.production_date),
      batch: box.supplier_batch || '',
      image_data: box.image_data,
      isLoose,
      unidentified: isProvisional(box.barcode),
      barcodeInput: '',
    });
  }

  // Close the edit panel without saving — its X, or the device Back.
  function cancelEdit(via: 'x' | 'back') {
    if (!editForm) return;
    trace('ui', 'edit_cancel', { barcode: editForm.barcode, via });
    // A barcode minted in this edit but never saved onto the row would
    // be an orphan label; drop it while it is still unprinted.
    if (editForm.forcedId) discardSavedLabel(editForm.forcedId);
    setEditForm(null);
    setEditError(null);
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
      setEditError(t(session?.language || 'English', 'terminal.barcodeNeedName'));
      return;
    }
    setMintingBarcode(true);
    setEditError(null);
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
          production_date: toIsoDate(editForm.production_date) || box?.production_date || null,
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
      // Printing off: no "print it from Labels" — the panel shows the new code.
      if (PRINTING) showToast(tr('terminal.barcodeMinted', { code: minted }), 'label');
    } catch {
      // Never strand the worker on a failed network call — offer the
      // book-without-a-barcode route instead, as a second, explicit tap.
      setMintFailed(true);
      setEditError(t(session?.language || 'English', 'terminal.barcodeMintFailed'));
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
    // The worker took the way out the mint failure offered: its error is answered.
    setEditError(null);
    setEditForm({
      ...editForm,
      forcedId: freeNoBarcodeId(
        session?.document_number || '', editForm.isLoose ? 0 : currentPallet, n || list.length + 1,
        list.map((b) => b.barcode),
      ),
      unidentified: false,
      barcodeInput: '',
    });
  }

  function handleSaveEdit() {
    if (!editForm) return;
    const { barcode, name_he, name_en, isLoose } = editForm;
    // Stored as ISO: a DD/MM/YYYY here reached the bot as box_expiry NULL.
    const expiry = normalizeExpiry(editForm.expiry);
    const production_date = normalizeExpiry(editForm.production_date);
    const batch = editForm.batch.trim();
    const w = parseFloat(editForm.weight);
    // The panel's Save is already disabled for refused dates; this is the
    // same rule again so no other path can book one (lib/date-validation.ts).
    const dateError = validateCartonDates({ production: production_date, expiry, receiptDate: localIsoDate() }).expiryError;
    if (dateError) {
      setEditError(t(session?.language || 'English', dateError));
      return;
    }
    trace('ui', 'edit_save', { barcode, isLoose, name_he, name_en, weight: w, expiry, production_date, batch, barcodeInput: editForm.barcodeInput, forcedId: editForm.forcedId, unidentified: editForm.unidentified });
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
        // Not a dead end (19/10): the message names the carton and says
        // both ways on — delete this row (same carton) or add it as another
        // carton with an identical label (the button, when the code can
        // have twins — lib/scan-notice.ts canOfferDifferentCarton).
        const dupOf = findCountedCartonByDigits(isLoose ? looseBoxes : scannedBoxes, typed, barcode);
        if (dupOf) {
          const twinOk = canOfferDifferentCarton(typed, dupOf.row);
          trace('ui', 'edit_barcode_duplicate', { barcode, typed, of: dupOf.n, twin_ok: twinOk });
          setEditError(t(session?.language || 'English', twinOk ? 'terminal.barcodeDuplicate' : 'terminal.barcodeDuplicateSame', { n: dupOf.n }));
          setEditDup({ n: dupOf.n, row: dupOf.row, typed, twinOk });
          return;
        }
        resolvedId = typed;
      } else if (editForm.barcodeInput.trim()) {
        // Started typing but stopped short — that is a slip, not a decision.
        setEditError(
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
      // A units carton keeps weight 0; the panel's number is its units.
      const units = isUnitsCarton(b);
      const newWeight = units ? b.weight : Number.isFinite(w) && w > 0 ? w : b.weight;
      const hasName = !!(name_he.trim() || name_en.trim());
      const hasWeight = units || newWeight > 0;
      return {
        ...b,
        ...(units && Number.isInteger(w) && w > 0 ? { units: w } : {}),
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
        production_date,
        supplier_batch: batch,
        // An identity is part of "resolved". A carton still carrying its
        // placeholder stays flagged however good its name and weight are —
        // otherwise Save quietly books an unmatchable row, which is exactly
        // what it used to do.
        needs_review: hasName && hasWeight && !stillUnidentified ? undefined : true,
        // "From barcode" stays only on a value he left as the barcode gave it.
        barcode_filled: keepBarcodeFilled(resolvedId, b.barcode_filled, newWeight, expiry),
        // A suspect weight: saved = confirmed (lib/weight-sanity.ts).
        weight_suspect: undefined,
        weight_checked: true,
        // His dates are his answer too: the last pass before booking leaves
        // them (lib/barcode-reconcile.ts applyBarcodeReadings).
        expiry_checked: true,
        // And for a code/name conflict: the name he saved is the product.
        name_conflict: undefined,
        // A name he changed (or a conflict he settled) is his choice of
        // product: later item_code lookups follow it, not the code (ownCodes).
        named_by_worker: b.named_by_worker
          || !!b.name_conflict
          || name_he.trim() !== (b.item_name_hebrew || '').trim()
          || name_en.trim() !== (b.item_name || '').trim()
          || undefined,
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

    // Saved: the panel closes, and a strip from an earlier try goes with it.
    setEditError(null);
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
        `${i + 1}. ${nm}${b.weight > 0 ? ` · ${b.weight.toFixed(3)} ${tr('common.kg')}` : ''}${b.barcode ? ` · ${b.barcode}` : ''}`,
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
    target: IdenticalTarget & { newCarton?: boolean },
    labels: Array<Pick<CartonLabel, 'barcode' | 'batch_id'>>,
    form: IdenticalForm,
    /** The toast to show instead of the form's "Label saved" (the one-tap twin). */
    savedText?: string,
  ) {
    trace('ui', target.newCarton ? 'new_carton_counted' : 'identical_created', { barcode: target.box.barcode, loose: target.loose, labels: labels.length, form, another_of: target.anotherOf, listed: target.listed, replaces: target.replaces });
    // The form's "which product?" answer (a code/name conflict): the new
    // rows carry the product he picked.
    const sample: BoxScan = form.item
      ? { ...target.box, item_name_hebrew: form.item.item_name_hebrew, item_name: form.item.item_name_english, name_conflict: undefined, named_by_worker: true }
      : target.box;
    const expanded: BoxScan[] = expandIdenticalBoxes(
      sample,
      labels.map((l) => ({ barcode: l.barcode, batch_id: l.batch_id })),
      form,
      // One more carton with the same label is a twin, not a batch: a later
      // read of the code must never be answered "covered by labels".
    ).map((r) => ({ ...r, twin: target.anotherOf ? true : undefined }));
    // Q5: a New carton stands in for no supplier code (its sample is empty).
    const rows: BoxScan[] = target.newCarton ? asNewCartonRows(expanded) : expanded;
    const replaceSample = (prevAll: BoxScan[]): BoxScan[] => {
      // The photo row a twin from the edit panel takes the place of.
      const prev = target.replaces ? prevAll.filter((b) => b.barcode !== target.replaces) : prevAll;
      // "Different carton?": the carton it was copied from is a counted
      // carton of its own and stays; the new one joins the end of the list.
      // The form showed that carton's doubted weight and the worker saved it
      // unchanged: the doubt is settled for it too.
      if (target.anotherOf) {
        const settled = form.weight_confirmed
          ? acceptDoubts(prev, new Set(prev.filter((b) => b.barcode === target.box.barcode
              && Math.abs(b.weight - form.weight) < 0.001).map((b) => b.barcode)))
          : prev;
        return flagSuspectWeights([...settled, ...rows]);
      }
      const idx = prev.findIndex((b) => b.barcode === target.box.barcode);
      return flagSuspectWeights(
        idx === -1 ? [...prev, ...rows] : [...prev.slice(0, idx), ...rows, ...prev.slice(idx + 1)],
      );
    };
    if (target.replaces) (target.loose ? looseProcessedRef : processedRef).current.delete(target.replaces);
    if (target.loose) {
      for (const r of rows) looseProcessedRef.current.add(r.barcode);
      setLooseBoxes(replaceSample);
    } else {
      for (const r of rows) processedRef.current.add(r.barcode);
      // Functional: this runs after the label POST, from the render in which
      // Save was tapped. Scans and OCR results that landed meanwhile are in
      // `prev`, not in that render's list — writing the stale list back left
      // a carton in OCR forever and dropped a fresh scan whose code stayed in
      // the dedup set.
      setScannedBoxes((prev) => {
        const next = replaceSample(prev);
        setDetectedType(detectType(next, acceptedMerges));
        // A single-vs-mix question raised by the sample is moot now (retracts).
        maybeTriggerUniformPrompt(next, '');
        // No pallet total is filled in or opened here any more (19/10): the
        // input opens on "Done scanning?" and offers the note's figure or the
        // list's own count then (lib/count-prefill.ts). The list's count
        // filled in at save time was 25 on document 48429, over the note's 22.
        return next;
      });
    }
    setSelectedBarcode(null);
    // Saved, not printed: straight back to the scanner. The labels wait in
    // Labels (amber badge) until the worker prints them — any time before
    // this pallet is closed.
    setIdenticalFor(null);
    unprinted.refresh();
    trace('ui', 'labels_saved', {
      origin: target.newCarton ? 'new_carton' : 'identical', count: rows.length, batch_id: labels[0]?.batch_id, pallet: target.loose ? 0 : currentPallet,
      another_of: target.anotherOf, counted: target.newCarton || undefined,
    });
    // Every saved-toast text tells the worker to print (or that the label is
    // not printed yet): printing off, the new rows on the list say it all.
    if (PRINTING) {
      showToast(
        savedText ?? (rows.length === 1 ? tr('identical.savedOne') : tr('identical.saved', { count: rows.length })),
        'save',
      );
    }
  }

  /**
   * "Different carton?" on an already-counted notice. The worker says the
   * carton in hand is NOT the counted one, only labelled identically: open
   * the identical form on the counted carton's data with a count of 1. It
   * saves a warehouse label of its own (unprinted, so the print gate holds
   * the LPN until it is stuck on). An explicit tap — never automatic.
   */
  function openDifferentCarton(d: NonNullable<ScanNotice['different']>) {
    const listed = sameLabelOnList(d.loose ? looseBoxesRef.current : scannedBoxesRef.current, d.box.barcode);
    trace('ui', 'different_carton_open', { barcode: d.box.barcode, of: d.n, loose: d.loose, listed });
    clearScanNotice();
    setSelectedBarcode(null);
    setIdenticalFor({ box: d.box, loose: d.loose, anotherOf: d.n, listed });
  }

  /** "Same carton" on the already-on-the-list question: nothing to add. The
   *  camera is usually still on that sticker, so its re-reads stay quiet —
   *  no sound, no question, only the twin way in — until it has been away
   *  (sameHoldRef). */
  function answerSameCarton(d: NonNullable<ScanNotice['different']>) {
    trace('ui', 'same_carton', { barcode: d.box.barcode, of: d.n, loose: d.loose });
    sameHoldRef.current = { code: d.box.barcode, lastRead: Date.now() };
    clearScanNotice();
  }

  /**
   * The edit panel's "these digits are already on the list" → "Same carton
   * — remove this row": the photo row being edited is the carton already on
   * the list, photographed again. It goes; the counted one stays.
   */
  function removeEditedDuplicate() {
    if (!editForm || !editDup) return;
    const code = editForm.barcode;
    trace('ui', 'edit_duplicate_removed', { barcode: code, of: editDup.n });
    if (editForm.isLoose) dropLooseRows(new Set([code]));
    else dropPalletRows(new Set([code]));
    setEditError(null);
    setEditDup(null);
    setEditForm(null);
    showToast(tr('terminal.duplicateRowRemoved', { n: editDup.n }), 'check');
  }

  /**
   * The edit panel's "these digits are already on the list" → "Another
   * carton, identical label — add it": the photo row being edited becomes a
   * twin of that carton (a label of its own), through the same form as the
   * notice — what this photo read (weight, dates) is what the form opens on.
   */
  function addTwinFromEdit() {
    if (!editForm || !editDup) return;
    const loose = !!editForm.isLoose;
    const list = loose ? looseBoxes : scannedBoxes;
    const w = parseFloat(editForm.weight);
    // The digits he typed, not the hit's own barcode: when the original row
    // was deleted the hit is one of its twins, whose barcode is a minted
    // `28…` label — the count and the new rows' source_barcode would follow
    // that label instead of the supplier code (as countedNotice does).
    const code = editDup.typed;
    const box: BoxScan = {
      ...editDup.row,
      barcode: code,
      weight: Number.isFinite(w) && w > 0 ? w : editDup.row.weight,
      expiry: normalizeExpiry(editForm.expiry) || editDup.row.expiry,
      production_date: normalizeExpiry(editForm.production_date) || editDup.row.production_date,
    };
    trace('ui', 'edit_duplicate_as_twin', { barcode: editForm.barcode, of: editDup.n, code });
    setEditError(null);
    setEditDup(null);
    setIdenticalFor({
      box, loose, anotherOf: editDup.n, listed: sameLabelOnList(list, code), replaces: editForm.barcode,
    });
    setEditForm(null);
  }

  /**
   * "All boxes identical" on a carton (its row, the Scanning-now card, or
   * the single-item question's "print a label for each carton"): the form
   * asks how many cartons of this product there are in total, and the other
   * cartons of it already on the list count in that total (document 48429:
   * cartons on the list plus labels for every carton = counted twice).
   */
  function openIdentical(box: BoxScan, loose: boolean) {
    const list = loose ? looseBoxes : scannedBoxes;
    const keyOf = (b: BoxScan) => acceptedMerges.get(groupKeyForBox(b)) ?? groupKeyForBox(b);
    const key = keyOf(box);
    const listed = list.filter((b) => b.barcode !== box.barcode && keyOf(b) === key).length;
    trace('ui', 'identical_open', { barcode: box.barcode, loose, listed });
    setIdenticalFor({ box, loose, listed });
  }

  /**
   * "➕ Another carton, same label · {kg} kg" on an already-counted notice
   * (S1, David 2026-10-11). The code is a 31-digit catch-weight label, so a
   * carton printing the same code weighs what the code says: ONE tap saves
   * it — the same `identical` label save "Different carton?" makes through
   * its form (lib/identical-boxes.ts postIdenticalLabels), quantity 1,
   * weight = the barcode's net weight, name and dates copied from the
   * counted carton. The new row is `minted` and its label unprinted, so the
   * print gate holds the LPN until it is printed, as for the form.
   */
  async function addTwinCarton(d: NonNullable<ScanNotice['different']>) {
    if (twinBusyRef.current || d.quickWeight === undefined) return;
    twinBusyRef.current = true;
    setTwinBusy(true);
    const weight = d.quickWeight;
    const startPhase = phaseRef.current;
    const startPallet = currentPalletRef.current;
    trace('ui', 'different_carton_quick', { barcode: d.box.barcode, of: d.n, weight, loose: d.loose });
    try {
      const payload = identicalLabelPayload({
        sourceBarcode: d.box.barcode,
        palletNumber: d.loose ? 0 : startPallet,
        itemCode: matchInvoiceItem(d.box.item_name_hebrew, d.box.item_name, sessionRef.current?.ocr_data, ownCodes(d.box))?.item_code ?? null,
        itemNameHebrew: d.box.item_name_hebrew,
        itemNameEnglish: d.box.item_name,
        weightKg: weight,
        quantity: 1,
        productionDate: toIsoDate(d.box.production_date || ''),
        expiryDate: toIsoDate(d.box.expiry || ''),
      });
      // A fresh batch per tap: every tap is one more physical carton.
      const result = await postIdenticalLabels(token, newBatchId(), payload);
      if (!result.ok) {
        trace('ui', 'different_carton_quick_failed', { barcode: d.box.barcode, reason: result.reason });
        showToast(tr(result.reason === 'session' ? 'carton.sessionExpired' : 'identical.error'), 'error', '#ef8a8a');
        return;
      }
      if (phaseRef.current !== startPhase || currentPalletRef.current !== startPallet) {
        // The list was closed while the label saved: never add a row to a
        // list that is gone. The saved label waits in Labels (unprinted) —
        // delete it there if it is not needed.
        trace('ui', 'different_carton_quick_stale', {
          barcode: d.box.barcode, from: startPhase, to: phaseRef.current, batch_id: result.labels[0]?.batch_id,
        });
        unprinted.refresh();
        showToast(tr('terminal.anotherCartonStale'), 'error', '#ef8a8a');
        return;
      }
      clearScanNotice();
      // The camera is still on this sticker: no second one-tap for it until
      // it has been away (or another code was read).
      twinHoldRef.current = { code: d.box.barcode, lastRead: Date.now() };
      handleIdenticalCreated(
        { box: d.box, loose: d.loose, anotherOf: d.n },
        result.labels,
        { weight, expiry: payload.expiry_date || '', production_date: payload.production_date || '' },
        tr('terminal.anotherCartonAdded', { kg: weight.toFixed(2) }),
      );
    } finally {
      twinBusyRef.current = false;
      setTwinBusy(false);
    }
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

  // ── Delete chip → bulk sheet (client request (c), 2026-10-15) ──
  //
  // 'rows': the open list starts again (the pallet's per-pallet state is
  // reset as for a new pallet) and the unprinted identical / receiving labels
  // of this pallet are deleted with it — the per-row Delete rule, in bulk.
  // 'unprinted' / 'void_printed': the server clears this pallet's labels and
  // answers the barcodes; their rows leave the list through the same path as
  // Labels → Delete. Booked cartons are never touched (server-side). Every
  // run is traced as delete_all with the before-values.
  async function handleDeleteAll(action: DeleteAllAction) {
    if (refuseIfSessionLost('delete_all')) return;
    const loose = phase === 'loose_scanning';
    const pallet = loose ? 0 : currentPallet;
    const rows = loose ? looseBoxesRef.current : scannedBoxesRef.current;
    const before = {
      rows: rows.length,
      barcodes: rows.slice(0, 120).map((b) => b.barcode),
      confirmed_box_count: loose ? undefined : confirmedBoxCount,
      box_count_input: loose ? undefined : boxCountInput,
      uniform_groups: loose ? undefined : Array.from(uniformGroups.values()).map((g) => ({ name_key: g.name_key, total: g.total_count })),
      unprinted_labels: unprinted.labels.filter((l) => l.pallet_number === pallet).length,
    };
    if (action === 'rows') {
      // The list starts again: a re-scanned sample must upload its sticker
      // photo again (per-row guard, lib/photo-rows.ts), and a short item code
      // read again opens New carton again.
      for (const b of rows) {
        uploadedStickersRef.current.delete(photoUploadKey(loose ? 'loose' : 'pallet', pallet, b.barcode));
      }
      const shortPrefix = `${pallet}:`;
      for (const k of Array.from(shortCodeOpenedRef.current)) {
        if (k.startsWith(shortPrefix)) shortCodeOpenedRef.current.delete(k);
      }
      if (loose) {
        setLooseBoxes([]);
        looseProcessedRef.current.clear();
        clearDuplicateSounds(dupSoundsRef.current);
        clearScanNotice();
        setSelectedBarcode(null);
      } else {
        resetPalletUiState();
        fetch('/api/multi-pallet-session', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, current_box_count: 0 }),
        }).catch(() => {});
      }
    }
    let result: { count: number; action: string; barcodes: string[]; before: unknown[] } | null = null;
    try {
      const res = await fetch(
        `/api/carton-labels?token=${encodeURIComponent(token)}&scope=session&pallet=${pallet}&labels=${action}`,
        { method: 'DELETE' },
      );
      const data = await res.json();
      if (!data?.success) throw new Error(data?.error || `HTTP ${res.status}`);
      result = {
        count: Number(data.count) || 0,
        action: String(data.action || ''),
        barcodes: Array.isArray(data.barcodes) ? data.barcodes : [],
        before: Array.isArray(data.before) ? data.before : [],
      };
    } catch (err) {
      trace('ui', 'delete_all_failed', { pallet, action, error: String(err) });
      // The rows are already off the list ('rows'); only the label half failed.
      if (action !== 'rows') {
        showToast(tr('terminal.deleteAllFailed'), 'error', '#ef8a8a');
        return;
      }
    }
    let dropped = action === 'rows' ? rows.length : 0;
    if (action !== 'rows' && result && result.barcodes.length) {
      const gone = new Set(result.barcodes);
      dropped = rows.filter((b) => gone.has(b.barcode)).length;
      handleLabelBatchDeleted('delete_all', result.barcodes, null);
    }
    trace('ui', 'delete_all', {
      pallet, action, rows: dropped, labels: result?.count ?? 0, label_action: result?.action,
      before, labels_before: result?.before.slice(0, 120),
    });
    unprinted.refresh();
    setShowDeleteAll(false);
    if (action === 'void_printed') {
      showToast(tr('terminal.voidDone', { count: result?.count ?? 0 }), 'block', '#fbbf5c');
    } else if (action === 'unprinted') {
      showToast(tr('terminal.deleteAllLabelsDone', { count: result?.count ?? 0 }), 'delete');
    } else {
      showToast(tr('terminal.deleteAllRowsDone', { count: dropped }), 'delete');
    }
  }

  // ── Delete chip → selection mode (client 19/10, his design) ──
  //
  // Delete selected takes the picked rows off the open list through the
  // row's own path (dropPalletRows / dropLooseRows + its unprinted label),
  // so the persist effect hands the shorter list to ledger().observe() and
  // each one reaches the server as a tombstone. Booked cartons are never
  // picked (lib/carton-select.ts). Every step is traced: select_mode_open,
  // delete_selected (with the before-values), select_mode_cancel.
  function openSelectMode(opts?: { preselect?: string[]; extra?: number }) {
    if (refuseIfSessionLost('select_mode')) return;
    const loose = phase === 'loose_scanning';
    const rows = loose ? looseBoxesRef.current : scannedBoxesRef.current;
    // Ticks offered by the more-than-your-total question (the no-barcode
    // photo captures, lib/count-check.ts) — only rows still on the list and
    // pickable. A tick deletes nothing; "Delete selected" does.
    const listed = new Set(rows.map((r) => r.barcode));
    const pre = (opts?.preselect ?? []).filter((b) => listed.has(b) && canSelect(b, bookedInSession));
    trace('ui', 'select_mode_open', { pallet: loose ? 0 : currentPallet, rows: rows.length, extra: opts?.extra, preselected: pre.length || undefined });
    setSelectedBarcode(null);
    setSelectPicked(new Set(pre));
    setSelectMode(true);
    setSelectExtra(opts?.extra ?? null);
    // Room for the checkboxes and the bar (the camera is paused meanwhile).
    const sheet = (loose ? looseSheetRef : sheetRef).current;
    selectSheetBeforeRef.current = sheet ? sheet.snapIndex() : null;
    sheet?.snapTo(2);
  }

  // Selection mode is over and the camera is on again: the sheet goes back to
  // where the worker had it, or the scan frame stays covered by a tall sheet.
  function restoreSheetAfterSelect(loose: boolean) {
    const sheet = (loose ? looseSheetRef : sheetRef).current;
    const back = sheet ? sheetSnapAfterSelect(selectSheetBeforeRef.current, sheet.snapIndex()) : null;
    selectSheetBeforeRef.current = null;
    if (back !== null) sheet?.snapTo(back);
  }

  function cancelSelectMode(why: 'cancel' | 'chip' | 'bulk') {
    const loose = phase === 'loose_scanning';
    trace('ui', 'select_mode_cancel', { pallet: loose ? 0 : currentPallet, picked: selectPicked.size, why });
    setSelectMode(false);
    setSelectPicked(new Set());
    restoreSheetAfterSelect(loose);
  }

  function toggleSelectCarton(barcode: string) {
    if (bookedInSession.has(barcode)) {
      showToast(tr('terminal.deleteAllBookedNote'), 'lock', '#fbbf5c');
      return;
    }
    setSelectPicked((p) => toggleSelected(p, barcode, bookedInSession));
  }

  function deleteSelectedCartons() {
    if (refuseIfSessionLost('delete_selected')) return;
    const loose = phase === 'loose_scanning';
    const pallet = loose ? 0 : currentPallet;
    const rows = loose ? looseBoxesRef.current : scannedBoxesRef.current;
    const filter = loose ? looseItemFilter : palletItemFilter;
    const gone = selectedForDelete(rows, selectPicked, bookedInSession, filter.matches);
    if (!gone.length) return;
    const goneSet = new Set(gone);
    const released = loose ? dropLooseRows(goneSet) : dropPalletRows(goneSet);
    trace('ui', 'delete_selected', {
      pallet,
      count: gone.length,
      barcodes: gone.slice(0, 120),
      released: released.length ? released : undefined,
      before: { rows: rows.length, picked: selectPicked.size },
    });
    discardSavedLabels(gone);
    setSelectMode(false);
    setSelectPicked(new Set());
    restoreSheetAfterSelect(loose);
    showToast(
      gone.length === 1 ? tr('terminal.deleteSelectedDoneOne') : tr('terminal.deleteAllRowsDone', { count: gone.length }),
      'delete',
    );
  }

  // discardSavedLabel for many rows: one request at a time (a pallet of
  // identical labels is dozens), the Labels count refreshed once at the end.
  function discardSavedLabels(barcodes: readonly string[]) {
    const minted = barcodes.filter((b) => isMintedLabelBarcode(b));
    if (!minted.length) return;
    void (async () => {
      for (const code of minted) {
        try {
          await fetch(`/api/carton-labels?token=${encodeURIComponent(token)}&barcode=${encodeURIComponent(code)}`, { method: 'DELETE' });
        } catch { /* the label stays; Labels can still delete it */ }
      }
      unprinted.refresh();
    })();
  }

  // ── "N cartons · change" on an identical-label group ──
  //
  // Fewer: the last rows of the group leave the list (unprinted labels
  // first) and their unprinted labels are deleted. More: k more labels are
  // saved with the group's data (same origin, supplier code, weight, dates)
  // and k rows join it. A pallet total that equalled the list follows it.
  function groupCountAction(box: BoxScan, loose: boolean): { onChangeCount?: () => void; groupCount?: number } {
    if (phase !== (loose ? 'loose_scanning' : 'scanning')) return {};
    const group = countGroupOf(box);
    // A units save is changed carton by carton (lib/units-cartons.ts).
    if (!group || box.twin || isUnitsCarton(box)) return {};
    const n = groupRows(loose ? looseBoxes : scannedBoxes, group).length;
    return {
      groupCount: n,
      onChangeCount: () => {
        trace('ui', 'count_group_open', { group, loose, count: n });
        setSelectedBarcode(null);
        setCountGroupFor({ group, loose });
      },
    };
  }

  async function handleGroupCountSave(next: number) {
    const target = countGroupFor;
    if (!target) return;
    const { group, loose } = target;
    const startPallet = currentPalletRef.current;
    const startPhase = phaseRef.current;
    const list = loose ? looseBoxesRef.current : scannedBoxesRef.current;
    const members = groupRows(list, group);
    const from = members.length;
    const template = members[from - 1];
    if (!template || next === from) {
      setCountGroupFor(null);
      return;
    }
    const totalBefore = loose ? 0 : listTotal(list);
    let changed: { removed?: string[]; added?: string[]; batch_id?: string } = {};

    if (next < from) {
      const gone = rowsToShrink(list, group, from - next, unprintedBarcodes);
      const goneSet = new Set(gone);
      if (loose) {
        const released = releasedSources(list, goneSet);
        setLooseBoxes((prev) => prev.filter((b) => !goneSet.has(b.barcode)));
        for (const code of gone) looseProcessedRef.current.delete(code);
        for (const code of released) looseProcessedRef.current.delete(code);
        clearDuplicateSounds(dupSoundsRef.current);
        clearScanNotice();
      } else {
        dropPalletRows(goneSet);
      }
      // A New carton group's labels go too: the cartons are no longer there.
      for (const code of gone) discardSavedLabel(code, true);
      changed = { removed: gone };
    } else {
      const payload = identicalLabelPayload({
        sourceBarcode: template.source_barcode || '',
        palletNumber: loose ? 0 : startPallet,
        itemCode: matchInvoiceItem(template.item_name_hebrew, template.item_name, sessionRef.current?.ocr_data, ownCodes(template))?.item_code ?? null,
        itemNameHebrew: template.item_name_hebrew,
        itemNameEnglish: template.item_name,
        weightKg: template.weight,
        quantity: next - from,
        productionDate: toIsoDate(template.production_date || ''),
        expiryDate: toIsoDate(template.expiry || ''),
        origin: template.new_carton ? 'new_carton' : 'identical',
      });
      const result = await postIdenticalLabels(token, newBatchId(), payload);
      if (!result.ok) {
        trace('ui', 'count_group_failed', { group, from, to: next, reason: result.reason });
        showToast(tr(result.reason === 'session' ? 'carton.sessionExpired' : 'terminal.groupCountFailed'), 'error', '#ef8a8a');
        return;
      }
      if (phaseRef.current !== startPhase || currentPalletRef.current !== startPallet) {
        // The list closed while the labels saved: never add rows to a list
        // that is gone. The labels wait in Labels (unprinted).
        trace('ui', 'count_group_stale', { group, batch_id: result.labels[0]?.batch_id });
        unprinted.refresh();
        setCountGroupFor(null);
        showToast(tr('terminal.anotherCartonStale'), 'error', '#ef8a8a');
        return;
      }
      const refs = result.labels.map((l) => ({ barcode: l.barcode, batch_id: l.batch_id }));
      if (loose) {
        for (const r of refs) looseProcessedRef.current.add(r.barcode);
        setLooseBoxes((prev) => growGroupRows(prev, group, refs));
      } else {
        for (const r of refs) processedRef.current.add(r.barcode);
        setScannedBoxes((prev) => {
          const nextRows = growGroupRows(prev, group, refs);
          setDetectedType(detectType(nextRows, acceptedMerges));
          return nextRows;
        });
      }
      changed = { added: refs.map((r) => r.barcode), batch_id: refs[0]?.batch_id };
    }

    // The pallet total follows when it was just the list's own count.
    let total: { from: number; to: number } | undefined;
    if (!loose) {
      const totalAfter = totalBefore + (next - from);
      if (confirmedBoxCount > 0 && confirmedBoxCount === totalBefore) {
        setConfirmedBoxCount(totalAfter);
        setBoxCountInput(String(totalAfter));
        fetch('/api/multi-pallet-session', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, current_box_count: totalAfter }),
        }).catch(() => {});
        total = { from: totalBefore, to: totalAfter };
      } else if (confirmedBoxCount === 0 && boxCountInput === String(totalBefore)) {
        setBoxCountInput(totalAfter > 0 ? String(totalAfter) : '');
      }
    }
    trace('ui', 'count_changed', {
      scope: 'identical_group', group, pallet: loose ? 0 : startPallet, from, to: next,
      new_carton: template.new_carton || undefined, total, ...changed,
    });
    unprinted.refresh();
    setCountGroupFor(null);
    showToast(tr('terminal.groupCountSaved', { from, to: next }), 'edit_note');
  }

  /** The action is offered on a captured row with a real supplier barcode
   *  that is not itself minted and not still in OCR. */
  function canDeclareIdentical(box: BoxScan): boolean {
    // A doubted weight no longer hides this (2026-10-19: it pushed David onto
    // 20 one-carton "Different carton?" saves). The form shows the doubt by
    // the weight, and saving it confirms the weight for every label.
    return box.ocr_status !== 'processing' && !box.minted
      && !isProvisional(box.barcode) && !isNoBarcodeId(box.barcode);
  }

  function buildDockChips(opts: { gap: () => void }): ToolChip[] {
    return [
      {
        id: 'create', icon: 'add', label: tr('terminal.toolCreateCarton'), tint: 'blue', iconColor: '#33b1f0',
        onPress: () => openCartonCreator(),
      },
      {
        // Amber + count while saved labels wait for the printer (printing on
        // only — off, a plain chip onto the view-and-delete list).
        id: 'labels', icon: 'label', label: tr('terminal.toolLabels'),
        ...labelsChipLook(unprinted.labels.length, PRINTING),
        onPress: () => setShowLabels(true),
      },
      { id: 'warehouses', icon: 'warehouse', label: tr('terminal.toolWarehouses'), tint: 'neutral', locked: true },
      { id: 'pallets', icon: <PalletIcon />, label: tr('terminal.toolPallets'), tint: 'neutral', onPress: () => setShowPallets(true) },
      {
        id: 'delete', icon: 'delete_sweep', label: tr('terminal.toolDelete'), tint: 'red',
        // Only while a list is open for scanning; the rows of a booked list
        // are on an LPN and cannot be deleted from here. Cartons on the list
        // → selection mode (tap again leaves it); an empty list → the bulk
        // sheet, for the labels it may still hold.
        onPress: () => {
          if (phase !== 'scanning' && phase !== 'loose_scanning') {
            showToast(tr('terminal.deleteHint'), 'delete_sweep', '#ef8a8a');
          } else if (selectMode) {
            cancelSelectMode('chip');
          } else if ((phase === 'loose_scanning' ? looseBoxesRef.current : scannedBoxesRef.current).length > 0) {
            openSelectMode();
          } else {
            trace('ui', 'delete_all_open', { pallet: phase === 'loose_scanning' ? 0 : currentPallet });
            setShowDeleteAll(true);
          }
        },
      },
      { id: 'share', icon: 'ios_share', label: tr('terminal.toolShare'), tint: 'blue', onPress: handleShareSummary },
      { id: 'assign', icon: 'send', flip: true, label: tr('terminal.toolAssign'), tint: 'green', locked: true },
      {
        id: 'gap', icon: 'report_problem', label: tr('terminal.toolGap'), tint: 'amber', iconColor: '#fbbf5c',
        onPress: opts.gap,
      },
    ];
  }

  // Selection mode's bar (the design's sticky bottom bar), in the sheet's
  // footer in place of the confirm: "Delete selected (N)" red, "Cancel".
  // Its start holds the way to the bulk sheet (delete all / labels), which
  // the Delete chip opened before selection mode existed.
  function selectionFooter(loose: boolean) {
    const rows = loose ? looseBoxes : scannedBoxes;
    const filter = loose ? looseItemFilter : palletItemFilter;
    const n = selectedForDelete(rows, selectPicked, bookedInSession, filter.matches).length;
    return (
      <div className="flex items-center gap-[10px] bg-[#0d171d] border border-brand rounded-[13px] px-3 py-[10px] shadow-[0_-8px_20px_rgba(9,13,16,.9)]">
        <button
          type="button"
          onClick={() => {
            cancelSelectMode('bulk');
            trace('ui', 'delete_all_open', { pallet: loose ? 0 : currentPallet });
            setShowDeleteAll(true);
          }}
          className="min-w-0 flex items-center gap-[4px] text-[11px] font-extrabold text-[#ef8a8a] text-start leading-tight"
        >
          <MI name="delete_sweep" size={16} className="flex-none" />
          <span className="min-w-0 wrap-anywhere">{tr('terminal.selectBulk')}</span>
        </button>
        <button
          type="button"
          disabled={n === 0}
          onClick={deleteSelectedCartons}
          className="ms-auto flex-none flex items-center gap-[6px] rounded-full bg-danger text-white text-[12px] font-black px-4 py-[9px] disabled:opacity-45"
        >
          <MI name="delete" size={16} />
          {tr('terminal.deleteSelected', { count: n })}
        </button>
        <button
          type="button"
          onClick={() => cancelSelectMode('cancel')}
          className="flex-none px-2 py-[6px] text-[12px] font-extrabold text-[#e8eef2]"
        >
          {tr('terminal.selectCancel')}
        </button>
      </div>
    );
  }

  const selectHint = selectMode ? (
    <p className="flex items-center justify-center gap-[5px] text-[11.5px] font-bold text-brand-weak-ink text-center">
      <MI name="checklist" size={16} className="flex-none" />
      {selectExtra === null
        ? tr('terminal.selectHint')
        : selectExtra === 1
        ? tr('terminal.selectHintExtraOne')
        : tr('terminal.selectHintExtra', { count: selectExtra })}
    </p>
  ) : null;

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
  // A full-screen form or list is over the camera (New carton, All boxes
  // identical / Different carton?, Labels): the scanner reads nothing under
  // it. A carton the camera happened to face would otherwise be added — with
  // a success beep the worker cannot see — while they fill the form.
  const overlayOpen = showCartonCreator || showLabels || !!identicalFor || showDeleteAll || !!countGroupFor
    // The more-than-your-total and loose close-short questions: a carton
    // read under them would change the very numbers they show.
    || !!overTotal || looseShortAsk;

  /**
   * New carton: the picked item's cartons already on the open list, and what
   * its count opens on (document 48429: 3 photo captures on the list, then 22
   * labels for the same pallet of 22). Same "line may spread" rule as the
   * short-code preset (handleShortItemCode): with another pallet or a loose
   * pile the line's total can't be this list's, so no remainder is offered.
   */
  function cartonOnList(item: CartonItemOption): CartonOnList | null {
    const lines = session?.ocr_data ?? [];
    const list = looseCartonPhase ? looseBoxes : scannedBoxes;
    const code = String(item.item_code ?? '');
    const on = cartonsOnListFor(code, list, lines);
    const line = lines.find((l) => String(l.item_code ?? '') === code);
    const lineMaySpread = (session?.pallet_count || 1) > 1 || (session?.loose_box_count || 0) > 0
      || shortCodeSavedItemsRef.current.has(code);
    const q = newCartonQuantity({ onList: on.total, lineBoxes: line?.box_count, lineMaySpread });
    return {
      ...on,
      quantity: q.quantity,
      left: q.left,
      lineTotal: !lineMaySpread && Number(line?.box_count) > 0 ? Number(line?.box_count) : null,
    };
  }

  /**
   * New carton in units (lib/units-cartons.ts): the loose pile only, and only
   * while the session's chat has `units_mode` on. Off, the creator is the kg
   * one it always was.
   */
  const cartonUnits = session?.features?.units_mode && looseCartonPhase
    ? {
        // What the line still lacks — only when the loose pile is the whole
        // delivery; else the usual New carton count.
        cartonsFor: (item: CartonItemOption) => unitsCartonsPrefill({
          lineBoxes: item.box_count,
          onList: cartonOnList(item)?.total ?? 0,
          looseOnly: (session?.pallet_count || 0) === 0 && !shortCodeSavedItemsRef.current.has(String(item.item_code ?? '')),
          fallback: cartonOnList(item)?.quantity ?? 1,
        }),
        onCreated: handleUnitsCreated,
      }
    : undefined;

  /**
   * A units save: one loose row per saved label, weight 0 with its units, all
   * sharing the save's batch id as `units_batch` (one grouped row on the
   * list). Counted at once, like any New carton (Q5).
   */
  function handleUnitsCreated(labels: CartonLabel[], save: UnitsSave) {
    setShowCartonCreator(false);
    if (cartonPreset) shortCodeSavedItemsRef.current.add(String(cartonPreset.item.item_code ?? ''));
    setCartonPreset(null);
    const rows: BoxScan[] = unitsCartonRows(labels, { perCarton: save.perCarton, unitsBatch: labels[0]?.batch_id ?? newBatchId() })
      .map((r) => ({ ...r, ocr_status: 'done' as OcrStatus }));
    for (const r of rows) looseProcessedRef.current.add(r.barcode);
    setLooseBoxes((prev) => [...prev, ...rows]);
    setSelectedBarcode(null);
    unprinted.refresh();
    const units = rows.reduce((n, r) => n + (r.units ?? 0), 0);
    trace('ui', 'labels_saved', {
      origin: 'new_carton', count: rows.length, batch_id: labels[0]?.batch_id, pallet: 0, counted: true,
      units_per_carton: save.perCarton, units,
    });
    showToast(tr(unitsAddedKey(rows.length), { n: rows.length, m: units }), 'save');
  }

  const cartonOverlays = (
    <>
      {overTotal && phase === 'scanning' && (() => {
        // More cartons on the list than the total (document 48429). Never a
        // refusal: what it sees, in his numbers, and three ways forward. No
        // carton is removed and no total changes until he picks one.
        const o = overTotal;
        const keepList = () => {
          trace('ui', 'count_below_list_keep', { pallet: currentPallet, declared: o.declared, on_list: o.onList, via: o.via });
          setOverTotal(null);
          setBoxCountInput(String(o.onList));
          if (o.via === 'submit') { handlePalletCountSubmit(o.onList); return; }
          // Asked at the slide: the confirmed total follows the list, and he
          // slides again — the slide is still the one booking step.
          setConfirmedBoxCount(o.onList);
          fetch('/api/multi-pallet-session', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, current_box_count: o.onList }),
          }).catch(() => {});
          trace('ui', 'count_changed', { pallet: currentPallet, from: o.declared, to: o.onList, scope: 'pallet_total', via: 'keep_list' });
          showToast(tr('palletVerify.overTotalKept', { count: o.onList }), 'check_circle');
        };
        const fixNumber = () => {
          trace('ui', 'count_below_list_fix', { pallet: currentPallet, declared: o.declared, on_list: o.onList, via: o.via });
          setOverTotal(null);
          if (o.via === 'confirm') startTotalEdit();
          else setCountFocusTick((n) => n + 1);
        };
        const pickToRemove = () => {
          trace('ui', 'count_below_list_remove', { pallet: currentPallet, declared: o.declared, on_list: o.onList, via: o.via, suggested: o.suggested.length || undefined });
          setOverTotal(null);
          openSelectMode({ preselect: o.suggested, extra: o.extra });
        };
        return (
          <div className="fixed inset-0 z-[72] bg-[rgba(5,8,10,0.74)] backdrop-blur-[3px] flex items-center justify-center p-[22px]">
            <div role="alertdialog" aria-modal="true" className="w-full max-w-[330px] bg-amber-card border border-[rgba(245,158,11,0.5)] rounded-[20px] px-5 py-[22px] shadow-[0_26px_64px_rgba(0,0,0,0.72)] animate-doneRise">
              <div className="flex justify-center mb-[13px]">
                <div className="w-16 h-16 rounded-full bg-[rgba(245,158,11,0.16)] flex items-center justify-center">
                  <MI name="inventory_2" size={34} style={{ color: '#fbbf5c' }} />
                </div>
              </div>
              <h2 className="text-center text-[19px] font-black text-ink-inverse">{tr('palletVerify.overTotalTitle')}</h2>
              <p className="text-center text-xs font-semibold text-[#d8c9a0] mt-1 leading-snug">
                {tr('palletVerify.overTotalBody', { onList: o.onList, declared: o.declared })}
              </p>
              <p className="text-center text-xs font-semibold text-[#d8c9a0] mt-2 leading-snug">
                {o.extra === 1 ? tr('palletVerify.overTotalHintOne') : tr('palletVerify.overTotalHint', { extra: o.extra })}
              </p>
              {o.suggested.length > 0 && (
                <p className="text-center text-xs font-bold text-[#fbbf5c] mt-2 leading-snug">
                  {tr('palletVerify.overTotalSuggested', { count: o.suggested.length })}
                </p>
              )}
              <div className="flex flex-col gap-2 mt-4">
                <button
                  onClick={pickToRemove}
                  className="w-full py-3 rounded-[13px] font-black text-[14px] bg-warn text-canvas"
                >
                  {tr('palletVerify.overTotalRemove')}
                </button>
                <button
                  onClick={keepList}
                  className="w-full py-3 rounded-[13px] font-extrabold text-[14px] bg-tile border border-line-strong text-ink-inverse"
                >
                  {tr('palletVerify.overTotalKeep', { onList: o.onList })}
                </button>
                <button
                  onClick={fixNumber}
                  className="w-full py-2 text-ink-muted text-xs font-extrabold"
                >
                  {tr('palletVerify.overTotalFix')}
                </button>
              </div>
            </div>
          </div>
        );
      })()}
      {looseShortAsk && phase === 'loose_scanning' && (() => {
        // Finishing the loose pile with fewer cartons than were declared — it
        // had no way through before (only "scan N more"). Same shape as the
        // pallet's close-short: what is booked, one slide, or keep scanning.
        const declared = session?.loose_box_count || 0;
        const count = looseBoxes.length;
        const doubts = weightDoubts(looseBoxes).length;
        return (
          <div className="fixed inset-0 z-[72] bg-[rgba(5,8,10,0.74)] backdrop-blur-[3px] flex items-center justify-center p-[22px]">
            <div role="alertdialog" aria-modal="true" className="w-full max-w-[330px] bg-amber-card border border-[rgba(245,158,11,0.5)] rounded-[20px] px-5 py-[22px] shadow-[0_26px_64px_rgba(0,0,0,0.72)] animate-doneRise">
              <div className="flex justify-center mb-[13px]">
                <div className="w-16 h-16 rounded-full bg-[rgba(245,158,11,0.16)] flex items-center justify-center">
                  <MI name="inventory_2" size={34} style={{ color: '#fbbf5c' }} />
                </div>
              </div>
              <h2 className="text-center text-[19px] font-black text-ink-inverse">{tr('palletVerify.closeShortLooseTitle')}</h2>
              <p className="text-center text-xs font-semibold text-[#d8c9a0] mt-1 leading-snug">
                {count === 0
                  ? tr('palletVerify.closeShortLooseNoneBody', { declared })
                  : tr('palletVerify.closeShortLooseBody', { declared, count })}
              </p>
              {doubts > 0 && (
                <p className="text-center text-xs font-bold text-[#fbbf5c] mt-2 leading-snug">
                  {doubts === 1 ? tr('palletVerify.weightAskBodyOne') : tr('palletVerify.weightAskBody', { count: doubts })}
                </p>
              )}
              <div className="mt-4">
                <SwipeConfirm
                  variant="warn"
                  label={count === 0 ? tr('palletVerify.closeShortLooseNoneConfirm') : tr('palletVerify.closeShortLooseConfirm', { count })}
                  onConfirm={() => {
                    trace('ui', 'loose_close_short', { declared, count });
                    setLooseShortAsk(false);
                    handleConfirmLooseBoxes();
                  }}
                />
              </div>
              <button
                onClick={() => { trace('ui', 'loose_close_short_cancel', { declared, count }); setLooseShortAsk(false); }}
                className="w-full mt-2 py-2 text-ink-muted text-xs font-extrabold transition"
              >
                {tr('palletVerify.keepScanning')}
              </button>
            </div>
          </div>
        );
      })()}
      {showCartonCreator && (
        <CartonCreator
          key={cartonPreset ? `preset:${cartonPreset.item.item_code}` : 'blank'}
          token={token}
          items={session?.ocr_data ?? []}
          preset={cartonPreset ?? undefined}
          palletNumber={looseCartonPhase ? 0 : currentPallet}
          // Q5 (client 2026-10-13): counted now, at the typed weight.
          countOnSave
          onList={cartonOnList}
          units={cartonUnits}
          onBack={() => {
            trace('ui', 'carton_creator_cancel', { preset_item: cartonPreset?.item.item_code });
            setShowCartonCreator(false);
            setCartonPreset(null);
          }}
          onCreated={(count, batchId, labels) => {
            // Back to the scanner, no Labels screen (SCN-18).
            setShowCartonCreator(false);
            if (cartonPreset) shortCodeSavedItemsRef.current.add(String(cartonPreset.item.item_code ?? ''));
            setCartonPreset(null);
            const batch = newCartonBatch(labels);
            if (batch) {
              // Q5: one row per saved label on the open list, through the
              // same path as an identical batch (dedup set, uniform retract,
              // pallet-total offer). Booked "label not printed" if it never
              // reaches the printer; Labels can still print it any time.
              const sample: BoxScan = { ...batch.sample, ocr_status: 'done' };
              handleIdenticalCreated(
                { box: sample, loose: looseCartonPhase, newCarton: true },
                batch.refs,
                batch.form,
                count === 1 ? tr('carton.addedToListOne') : tr('carton.addedToList', { count }),
              );
              return;
            }
            // Nothing to count (the save returned no labels): the old label-
            // only outcome — the gate holds the list until it is printed and
            // scanned, or deleted in Labels.
            unprinted.refresh();
            trace('ui', 'labels_saved', {
              origin: 'new_carton', count, batch_id: batchId, pallet: looseCartonPhase ? 0 : currentPallet,
            });
            // Not counted until the printed label is scanned (David
            // 2026-10-11 printed labels and never scanned them back). With
            // printing off there is no label to scan: the save failed for
            // him, so he saves again.
            const key = newCartonUncountedToast(count, PRINTING);
            if (key === 'carton.error') showToast(tr(key), 'error', '#ef8a8a');
            else showToast(tr(key, { count }), 'save');
          }}
        />
      )}
      {showLabels && (
        <LabelsBrowser
          token={token}
          onBack={() => { setShowLabels(false); unprinted.refresh(); }}
          initialStatus={labelsInitialStatus(unprinted.labels.length, PRINTING)}
          onChanged={unprinted.refresh}
          liveRows={liveLabelRows()}
          onBatchDeleted={handleLabelBatchDeleted}
        />
      )}
      {identicalFor && (() => {
        const box = identicalFor.box;
        const lines = session?.ocr_data ?? [];
        // The carton's OWN code first (19/10): never a line taken from a
        // name read beside it.
        const line = matchInvoiceItem(box.item_name_hebrew, box.item_name, lines, ownCodes(box));
        const list = identicalFor.loose ? looseBoxes : scannedBoxes;
        const keyOf = (b: BoxScan) => acceptedMerges.get(groupKeyForBox(b)) ?? groupKeyForBox(b);
        // The invoice line's carton count, as a tap-to-use hint — only when
        // the line is this list's alone, and not for a twin of a label that
        // prints its own weight (the line counts every weight, not this label).
        const lineMaySpread = (session?.pallet_count || 1) > 1 || (session?.loose_box_count || 0) > 0;
        const lineBoxes = !lineMaySpread && !(identicalFor.anotherOf && labelPrintsWeight(box.barcode))
          ? Number(lines.find((l) => line && String(l.item_code ?? '') === String(line.item_code ?? ''))?.box_count) || null
          : null;
        const other = groupSkuMismatch(box, list, keyOf);
        return (
          <IdenticalBoxesForm
            token={token}
            palletNumber={identicalFor.loose ? 0 : currentPallet}
            sample={{
              barcode: box.barcode,
              item_code: line?.item_code ?? null,
              item_name: box.item_name || '',
              item_name_hebrew: box.item_name_hebrew || '',
              weight: box.weight,
              expiry: box.expiry || '',
              production_date: box.production_date || '',
            }}
            anotherOf={identicalFor.anotherOf}
            listed={identicalFor.listed}
            lineBoxes={lineBoxes}
            skuMismatch={other ? { own: sourceSku(box.barcode), other } : undefined}
            productChoice={box.name_conflict
              ? {
                  ocr: box.name_conflict.ocr,
                  options: [
                    {
                      item_code: String(line?.item_code ?? ''),
                      item_name_hebrew: box.item_name_hebrew || '',
                      item_name_english: box.item_name || '',
                    },
                    box.name_conflict.line,
                  ],
                }
              : undefined}
            weightDoubt={box.weight_suspect && !box.weight_checked
              ? weightWarningText(box, tr) : undefined}
            onBack={() => setIdenticalFor(null)}
            onCreated={(labels, form) => handleIdenticalCreated(identicalFor, labels, form)}
          />
        );
      })()}
      {showDeleteAll && (phase === 'scanning' || phase === 'loose_scanning') && (() => {
        const loose = phase === 'loose_scanning';
        const pallet = loose ? 0 : currentPallet;
        return (
          <DeleteAllSheet
            token={token}
            pallet={pallet}
            rowCount={(loose ? looseBoxes : scannedBoxes).length}
            unprintedCount={unprinted.labels.filter((l) => l.pallet_number === pallet).length}
            booked={sessionBookedBarcodes(session)}
            onAction={handleDeleteAll}
            onClose={() => setShowDeleteAll(false)}
          />
        );
      })()}
      {countGroupFor && (() => {
        const members = groupRows(countGroupFor.loose ? looseBoxes : scannedBoxes, countGroupFor.group);
        const last = members[members.length - 1];
        if (!last) return null;
        return (
          <GroupCountSheet
            name={last.item_name_hebrew || last.item_name || '—'}
            current={members.length}
            unprinted={members.filter((b) => unprintedBarcodes.has(b.barcode)).length}
            onSave={handleGroupCountSave}
            onClose={() => setCountGroupFor(null)}
          />
        );
      })()}
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

  // ── Doubted weights: a review; only a ratio doubt holds (lib/weight-review.ts) ──

  /** "The weight is correct for all": the doubts shown, confirmed as read. */
  function acceptWeightDoubts(loose: boolean, barcodes: ReadonlySet<string>, weight?: number) {
    trace('ui', 'weight_doubt_accept_all', { loose, count: barcodes.size, weight });
    // heldForDetails: a pre-19/10 doubt that also held the carton is
    // released with it, so the footer agrees with the toast below.
    const settle = (prev: BoxScan[]) => acceptDoubts(prev, barcodes, heldForDetails);
    if (loose) setLooseBoxes(settle); else setScannedBoxes(settle);
    showToast(
      barcodes.size === 1
        ? tr('palletVerify.weightAcceptedOne')
        : tr('palletVerify.weightAccepted', { count: barcodes.size }),
      'check_circle',
    );
  }

  /** Open the first carton whose weight is still doubted. */
  function reviewWeightDoubt(loose: boolean) {
    const first = weightDoubts(loose ? looseBoxes : scannedBoxes)[0];
    trace('ui', 'weight_doubt_review', { loose, barcode: first?.barcode });
    if (first) openEdit(first, loose);
  }

  /**
   * Confirm with doubts still open: booked as read, no question. The review
   * bar above the slide was the prompt; a dialog on top of the slide was
   * one more stop on every pallet with a doubt (client rule, Mevaser 19/10:
   * "don't stop or ask David — anything left over goes to the office"). What
   * was left open is traced, so it can be looked at afterwards. Only name
   * number doubts get here: an open ratio doubt holds the slide (25/10).
   */
  function confirmPastWeightDoubts(loose: boolean) {
    const open = weightDoubts(loose ? looseBoxes : scannedBoxes);
    if (open.length > 0) {
      trace('ui', 'weight_doubt_unresolved', {
        loose, count: open.length, cartons: open.map((b) => ({ barcode: b.barcode, weight: b.weight, reason: b.weight_suspect?.reason })),
      });
    }
    if (loose) handleConfirmLooseBoxes(); else handleConfirmPallet();
  }

  /**
   * The amber review above the footer while any weight on the list is
   * doubted: what looks odd, one tap to say it is right (when the doubts are
   * one item at one weight), and one by one. Confirm below stays available.
   * Not with a ratio doubt open (client, 25/10): it holds Confirm, so there is
   * no "continue as they are", and no one tap either — 25/10's 172.87 kg was
   * printed on the pallet's paper slip, so "the weight is correct (172.87)"
   * would have passed it unseen. The carton is opened instead: the edit panel
   * shows the photo, and Save or Delete settles it.
   */
  function weightReviewBar(loose: boolean) {
    const list = loose ? looseBoxes : scannedBoxes;
    const doubts = weightDoubts(list);
    if (doubts.length === 0) return null;
    const ratioOpen = doubts.some(isOpenRatioDoubt);
    const shared = sharedDoubt(list);
    const ids = new Set(doubts.map((b) => b.barcode));
    const n = doubts.length;
    return (
      <div role="status" className="mb-2 rounded-[13px] border border-warn/60 bg-tile px-3 py-[9px]">
        <div className="flex items-start gap-[6px] text-[12px] font-extrabold text-warn-weak-ink leading-[1.35]">
          <MI name="report_problem" size={16} className="flex-none mt-[1px]" />
          <span className="min-w-0">
            {n === 1 ? tr('palletVerify.weightReviewTitleOne') : tr('palletVerify.weightReviewTitle', { count: n })}
            {' '}
            {(shared || !ratioOpen) && (
              <span className="font-semibold text-ink-muted">
                {shared
                  ? tr('palletVerify.weightReviewShared', { name: shared.name, w: shared.weight })
                  : tr('palletVerify.weightReviewMixed')}
              </span>
            )}
          </span>
        </div>
        <div className="flex gap-2 mt-[8px]">
          {shared && !ratioOpen && (
            <button
              onClick={() => acceptWeightDoubts(loose, ids, shared.weight)}
              className="flex-1 min-w-0 flex items-center justify-center gap-[5px] py-[9px] px-2 rounded-[11px] bg-warn text-canvas text-[12px] font-black leading-tight text-center"
            >
              <MI name="check" size={16} className="flex-none" />
              <span className="min-w-0">
                {n === 1
                  ? tr('palletVerify.weightCorrectOne', { w: shared.weight })
                  : tr('palletVerify.weightCorrectAll', { w: shared.weight })}
              </span>
            </button>
          )}
          <button
            onClick={() => reviewWeightDoubt(loose)}
            className="flex-1 min-w-0 flex items-center justify-center gap-[5px] py-[9px] px-2 rounded-[11px] bg-tile border border-line-strong text-ink-inverse text-[12px] font-extrabold leading-tight text-center"
          >
            <MI name="edit" size={15} className="flex-none" />
            <span className="min-w-0">{n === 1 ? tr('palletVerify.weightReviewOpenOne') : tr('palletVerify.weightReviewOneByOne')}</span>
          </button>
        </div>
      </div>
    );
  }

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
  // the hold that just lit up, and gone after scanNoticeMs(). Deliberately
  // NOT in the sheet footer: the footer sets the sheet's mid height, and on a
  // 360x641 phone the count input plus one more line no longer fits the room
  // BottomSheet leaves above the camera — it hides the whole footer (the
  // input with it) and, measuring a hidden footer as 0, never brings it back.
  // Up here a notice moves nothing. `--sheet-w` keeps it off a tablet's side
  // panel. It swallows taps (no capture under it); the buttons are the action.
  // A notice that asks ("Same carton / Another carton — add it", "There is a
  // long barcode / None — add cartons") has 48 px buttons — a glove has to
  // hit them after lowering the phone — and stays until answered or replaced
  // (lib/scan-notice.ts scanNoticeMs); one with only a link stays up for
  // SCAN_NOTICE_ACTION_MS, with no timeout at all while a finger is on it
  // (holdScanNotice / releaseScanNotice).
  const scanNoticeBanner = scanNotice ? (
    <div
      className="absolute top-2 z-[35] flex justify-center pointer-events-none"
      style={{ insetInlineStart: 12, insetInlineEnd: 'calc(var(--sheet-w, 0px) + 12px)' }}
    >
      <div
        role="status"
        onPointerDown={scanNotice.different || scanNotice.newCarton ? holdScanNotice : undefined}
        onPointerUp={scanNotice.different || scanNotice.newCarton ? releaseScanNotice : undefined}
        onPointerCancel={scanNotice.different || scanNotice.newCarton ? releaseScanNotice : undefined}
        onPointerLeave={scanNotice.different || scanNotice.newCarton ? releaseScanNotice : undefined}
        className={`pointer-events-auto max-w-[420px] min-w-0 rounded-[12px] border-2 text-xs font-bold leading-[1.45] text-center shadow-[0_10px_28px_rgba(0,0,0,.6)] animate-fadeIn overflow-hidden ${
          scanNotice.tone === 'info'
            ? 'bg-overlay-card border-brand text-brand-weak-ink'
            : 'bg-amber-card border-warn/70 text-warn-weak-ink'
        }`}
      >
        <p className="px-3 py-[7px] wrap-anywhere">
          <MI
            name={scanNotice.tone === 'info' ? (scanNotice.newCarton ? 'info' : 'done_all') : 'report_problem'}
            size={15}
            className="align-[-3px] me-1"
          />
          {scanNotice.text}
        </p>
        {scanNotice.different ? (() => {
          // "Same carton, or another carton with an identical label?" — two
          // plain buttons, 48 px for a glove. "Another" is one tap when the
          // code prints its weight (addTwinCarton), else the form.
          const d = scanNotice.different;
          const quick = d.quickWeight !== undefined;
          return (
            <div className="border-t border-brand/40 p-[6px] space-y-[5px]">
              <div className="flex gap-[6px]">
                {!d.sameAnswered && (
                <button
                  type="button"
                  onClick={() => answerSameCarton(d)}
                  className="flex-1 min-w-0 min-h-[48px] rounded-[10px] flex items-center justify-center gap-[5px] bg-tile border border-line-strong text-ink-inverse px-2 py-2 text-[13px] font-extrabold"
                >
                  <MI name="check" size={17} className="flex-none" />
                  <span className="min-w-0">{tr('terminal.sameCarton')}</span>
                </button>
                )}
                <button
                  type="button"
                  disabled={quick && twinBusy}
                  onClick={() => { if (quick) void addTwinCarton(d); else openDifferentCarton(d); }}
                  className="flex-[1.5] min-w-0 min-h-[48px] rounded-[10px] flex items-center justify-center gap-[6px] bg-brand text-white px-2 py-2 text-[13px] font-black disabled:opacity-60"
                >
                  {quick && twinBusy ? <Loader2 className="w-4 h-4 animate-spin flex-none" /> : !quick && <MI name="new_label" size={17} className="flex-none" />}
                  <span className="min-w-0">
                    {quick ? tr('terminal.anotherCartonSameLabel', { kg: d.quickWeight!.toFixed(2) }) : tr('terminal.differentCarton')}
                  </span>
                </button>
              </div>
              {quick && (
                // Several twins at once: the form, which asks for the total.
                <button
                  type="button"
                  onClick={() => openDifferentCarton(d)}
                  className="w-full min-h-[34px] flex items-center justify-center font-extrabold underline underline-offset-2"
                >
                  {tr('terminal.twinHowMany')}
                </button>
              )}
              {/* What "another carton" does, said where it is offered (it
                  says "print it from Labels": printing on only). */}
              {PRINTING && (
                <p className="px-1 text-[10.5px] font-semibold text-ink-muted leading-[1.4]">{tr('terminal.twinExplain')}</p>
              )}
            </div>
          );
        })() : scanNotice.newCarton && scanNotice.short ? (
          // A short read: "There is a long barcode" (aim at it) or add the
          // cartons by hand. The photo is named in the text — the camera
          // itself is the button.
          <div className={`border-t p-[6px] flex gap-[6px] ${scanNotice.tone === 'info' ? 'border-brand/40' : 'border-warn/50'}`}>
            <button
              type="button"
              onClick={() => {
                trace('ui', 'short_read_has_long', {});
                clearScanNotice();
              }}
              className="flex-1 min-w-0 min-h-[48px] rounded-[10px] flex items-center justify-center gap-[5px] bg-tile border border-line-strong text-ink-inverse px-2 py-2 text-[13px] font-extrabold"
            >
              <MI name="qr_code_scanner" size={17} className="flex-none" />
              <span className="min-w-0">{tr('terminal.shortHasLong')}</span>
            </button>
            <button
              type="button"
              onClick={() => {
                const nc = scanNotice.newCarton!;
                trace('ui', 'short_read_add_cartons', { item_code: nc.preset?.item.item_code });
                clearScanNotice();
                openCartonCreator(nc.preset);
              }}
              className={`flex-1 min-w-0 min-h-[48px] rounded-[10px] flex items-center justify-center gap-[5px] px-2 py-2 text-[13px] font-black ${
                scanNotice.tone === 'info' ? 'bg-brand text-white' : 'bg-warn text-canvas'
              }`}
            >
              <MI name="add_box" size={17} className="flex-none" />
              <span className="min-w-0">{scanNotice.newCarton.label}</span>
            </button>
          </div>
        ) : scanNotice.newCarton ? (
          <button
            type="button"
            onClick={() => {
              const nc = scanNotice.newCarton!;
              clearScanNotice();
              openCartonCreator(nc.preset);
            }}
            className={`w-full min-h-[40px] flex items-center justify-center gap-[5px] border-t px-3 py-2 font-black ${
              scanNotice.tone === 'info' ? 'border-brand/40 bg-brand-weak' : 'border-warn/50 bg-warn/10'
            }`}
          >
            <MI name="add_box" size={17} className="flex-none" />
            <span className="underline underline-offset-2">{scanNotice.newCarton.label}</span>
          </button>
        ) : null}
      </div>
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
  const editList = editForm ? (editForm.isLoose ? looseBoxes : scannedBoxes) : [];
  const editIndex = editForm ? editList.findIndex((b) => b.barcode === editForm.barcode) : -1;
  // The local frame, else the uploaded copy: a reload drops `image_data`, and
  // identical rows 2..N never had it — both still have `image_url`.
  const editRow = editIndex >= 0 ? editList[editIndex] : undefined;
  const editImage = editForm ? (editForm.image_data || editRow?.image_url) : undefined;
  const editPanelNode = editForm ? (
    <EditPanel
      // One mount per carton: the panel compares against the values it opened with.
      key={editForm.barcode}
      cartonNumber={editIndex >= 0 ? editIndex + 1 : '—'}
      needsReview={editIndex >= 0 && !!editList[editIndex].needs_review}
      weightWarning={editIndex >= 0 && editList[editIndex].weight_suspect
        ? weightWarningText(editList[editIndex], tr) : undefined}
      // The panel's own error, never the footer's `error`: a scan clash from a
      // background OCR is not this carton's save error.
      saveError={editError}
      saveErrorActions={editDup && digitsOnly(editForm.barcodeInput) === editDup.typed
        ? [
            { label: tr('terminal.barcodeDuplicateRemove'), onPress: removeEditedDuplicate },
            ...(editDup.twinOk ? [{ label: tr('terminal.barcodeDuplicateAdd'), onPress: addTwinFromEdit, primary: true }] : []),
          ]
        : undefined}
      // An English-only OCR name is still a name — don't show it as missing.
      name={editForm.name_he || editForm.name_en}
      weight={editForm.weight}
      units={editRow && isUnitsCarton(editRow) ? { label: tr('carton.unitsPerCarton'), unit: tr('carton.unitsToggle') } : undefined}
      expiry={editForm.expiry}
      barcode={editForm.forcedId || editForm.barcode}
      barcodeEditable={editForm.unidentified}
      barcodeInput={editForm.barcodeInput}
      // Each error goes when the worker changes what it is about: the barcode
      // ones here, "set the item name first" on a name pick or typed name.
      onBarcodeChange={(v) => { setEditForm({ ...editForm, barcodeInput: v }); setEditError(null); }}
      onCreateBarcode={handleCreateBarcode}
      minting={mintingBarcode}
      onNoBarcode={handleNoBarcode}
      showNoBarcode={mintFailed}
      // BOT-32: a carton booked without a barcode can still get one — typed
      // or minted — but only if the worker goes looking for it.
      onAddBarcode={!editForm.unidentified && isNoBarcodeId(editForm.forcedId || editForm.barcode)
        ? () => {
            trace('ui', 'add_barcode_open', { barcode: editForm.barcode });
            setEditForm({ ...editForm, unidentified: true, forcedId: undefined, barcodeInput: '' });
          }
        : undefined}
      itemChips={itemOptions(session?.ocr_data ?? []).map((it) => ({
        label: it.he || it.en,
        code: it.codes.join(' · '),
        active: editForm.name_he
          ? editForm.name_he === it.he
          : !!editForm.name_en && editForm.name_en === it.en,
        onPick: () => {
          setEditForm({ ...editForm, name_he: it.he, name_en: it.en });
          setEditError(null);
        },
      }))}
      imageData={editImage}
      photoPending={!editImage && !!editRow?.photo_pending}
      onViewImage={editImage ? () => setViewingImage(editImage) : undefined}
      // A typed name drops the OCR's English one, which may belong to another
      // item and would otherwise be sent on as item_name.
      onNameChange={(v) => { setEditForm({ ...editForm, name_he: v, name_en: '' }); setEditError(null); }}
      onWeightChange={(v) => setEditForm({ ...editForm, weight: v })}
      onExpiryChange={(v) => { setEditForm({ ...editForm, expiry: v }); setEditError(null); }}
      productionDate={editForm.production_date}
      onProductionDateChange={(v) => { setEditForm({ ...editForm, production_date: v }); setEditError(null); }}
      batch={editForm.batch}
      onBatchChange={(v) => setEditForm({ ...editForm, batch: v })}
      // Neutral "from barcode" on a value that still is the barcode's
      // (lib/barcode-reconcile.ts) — typed over, the marker goes.
      fromBarcode={(() => {
        const f = keepBarcodeFilled(editForm.barcode, editRow?.barcode_filled, parseFloat(editForm.weight), editForm.expiry);
        return f ? { weight: 'weight' in f, expiry: 'expiry' in f } : undefined;
      })()}
      onSave={handleSaveEdit}
      onCancel={() => cancelEdit('x')}
    />
  ) : null;

  function runLooseOcr(lookupKey: string, imageData: string, manual = false): Promise<void> {
    return fetch('/api/multi-pallet-ocr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: imageData, barcode: manual ? '' : lookupKey, token }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (lateReadDropped(lookupKey, 'loose', !!(data?.success && data.ocr_data))) return;
        // Printed digits that identify the carton — see runOcr.
        const ownDigits = manual && data?.success && data.ocr_data
          ? printedDigitsIdentifyCarton(
              digitsOnly(data.ocr_data.barcode_digits), decodedShortRef.current,
              sessionRef.current?.ocr_data, looseBoxesRef.current.map((b) => b.barcode),
            )
          : false;
        // A capture of a carton already on the loose list — see runOcr.
        if (manual && data?.success && data.ocr_data) {
          const digits = digitsOnly(data.ocr_data.barcode_digits);
          const hit = ownDigits
            ? findCountedCartonByDigits(looseBoxesRef.current, digits, lookupKey)
            : null;
          if (hit) {
            trace('ui', 'manual_capture_duplicate', { provisional: lookupKey, digits, of: hit.n, loose: true });
            looseDupFlashRef.current?.('duplicate');
            scanAlreadyCountedFeedback();
            showScanNotice(countedNotice(looseBoxesRef.current, digits, hit, { loose: true, photo: true }));
            highlightRow(hit.row.barcode);
            setLooseBoxes((prev) => prev.filter((b) => b.barcode !== lookupKey));
            return;
          }
        }

        // Barcode wins — see the pallet-phase note; hoisted for the same reason.
        const reading = data?.success && data.ocr_data ? barcodeReading(data.ocr_data, manual, lookupKey, looseBoxesRef.current, 'loose') : null;
        // A failed read keeps what the barcode and the invoice already say.
        const failPatch = data?.success && data.ocr_data ? null : failedReadPatch(lookupKey, looseBoxesRef.current, 'loose');

        setLooseBoxes((prev) => {
          const idx = prev.findIndex((b) => b.barcode === lookupKey);
          if (idx === -1) return prev;
          if (!takesLateRead(prev[idx])) return prev; // saved by the worker meanwhile

          if (!(data.success && data.ocr_data)) {
            return prev.map((b, i) => (i === idx ? { ...b, ...failPatch, ocr_status: 'failed' as OcrStatus } : b));
          }

          let resolvedBarcode = prev[idx].barcode;
          let resolvedSku = prev[idx].sku;
          let needsReview = false;
          if (manual) {
            const digits = digitsOnly(data.ocr_data.barcode_digits);
            if (ownDigits) {
              // The notice was raised above; this only catches a row the ref
              // had not caught up with yet.
              const dup = findCountedCartonByDigits(prev, digits, lookupKey) !== null;
              if (dup) {
                looseDupFlashRef.current?.('duplicate');
                return prev.filter((_, i) => i !== idx);
              }
              resolvedBarcode = digits;
              resolvedSku = digits.slice(0, 13);
              looseProcessedRef.current.add(digits);
              clearScanNotice();
            } else if (unreadDigitsOutcome({
              nameHebrew: data.ocr_data.product_name_hebrew,
              nameEnglish: data.ocr_data.product_name_english,
              weightKg: data.ocr_data.weight_kg,
            }) === 'book_without_barcode') {
              // BOT-32, loose pile: same as the pallet phase (P0 = loose, as
              // stripProvisionalIds books it).
              resolvedBarcode = freeNoBarcodeId(
                sessionRef.current?.document_number || '', 0, idx + 1,
                prev.filter((_, i) => i !== idx).map((b) => b.barcode),
              );
              resolvedSku = '';
              trace('ui', 'loose_manual_capture_no_digits', { provisional: lookupKey, booked_as: resolvedBarcode });
            } else {
              needsReview = true;
            }
          }
          // Same widened gate as the pallet phase: a successful OCR with no
          // name OR a non-positive weight is still bad data and must be
          // resolved before the worker can finish the loose phase.
          const heName = (data.ocr_data.product_name_hebrew || '').trim();
          const enName = (data.ocr_data.product_name_english || '').trim();
          const weight = reading?.weight ?? 0;
          const expiry = reading?.expiry ?? '';
          if ((!heName && !enName) || !(weight > 0)) {
            needsReview = true;
          }
          // A read expiry on/before today or on/before the read production
          // date is refused, not booked: the worker must fix or clear it in
          // the edit panel before the pallet closes (lib/date-validation.ts).
          if (validateCartonDates({
            production: data.ocr_data.production_date,
            expiry,
            receiptDate: localIsoDate(),
          }).expiryError) {
            needsReview = true;
          }

          // See the pallet-phase note: a manual capture's real identity only
          // exists once OCR has read the printed digits.
          if (manual) archiveStickerPhoto(resolvedBarcode, imageData, 'loose');

          return flagSuspectWeights(prev.map((b, i) => {
            if (i !== idx) return b;
            return {
              ...b,
              barcode: resolvedBarcode,
              sku: resolvedSku,
              ocr_status: 'done' as OcrStatus,
              item_name: data.ocr_data.product_name_english || '',
              item_name_hebrew: data.ocr_data.product_name_hebrew || '',
              weight,
              expiry,
              production_date: data.ocr_data.production_date || '',
              supplier_batch: data.ocr_data.supplier_batch || '',
              needs_review: needsReview || undefined,
              barcode_filled: reading && Object.keys(reading.filled).length ? reading.filled : undefined,
            };
          }), { [resolvedBarcode]: [data.ocr_data.product_name_hebrew, data.ocr_data.product_name_english] });
        });
      })
      .catch(() => {
        if (lateReadDropped(lookupKey, 'loose', false)) return;
        const failPatch = failedReadPatch(lookupKey, looseBoxesRef.current, 'loose');
        setLooseBoxes((prev) => {
          const idx = prev.findIndex((b) => b.barcode === lookupKey);
          if (idx === -1) return prev;
          if (!takesLateRead(prev[idx])) return prev;
          return prev.map((b, i) => (i === idx ? { ...b, ...failPatch, ocr_status: 'failed' } : b));
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
    if (refuseIfSessionLost('confirm_loose')) return;
    trace('ui', 'confirm_loose', { boxes: looseBoxes.length, declared: session?.loose_box_count });
    if (labelGate.count > 0) {
      refuseForLabels(labelGate.count, labelGate.batchIds, 'page');
      return;
    }
    setPhase('loose_confirming');
    setError(null);
    if (await reconcileBeforeConfirm(0)) {
      setPhase('loose_scanning');
      showToast(tr('palletVerify.listUpdatedFromServer'), 'cloud_sync', '#13a4ec');
      return;
    }
    // Reads still in flight first; a failed one goes back to the list.
    if (!(await settleReadsBeforeBook('loose'))) {
      setSwipeKey((k) => k + 1);
      setPhase('loose_scanning');
      return;
    }
    const looseToBook = bookWithBarcode(looseBoxesRef.current, 'loose');
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
            looseToBook.map(({ ocr_status: _, image_data: _img, ...box }) => box),
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
      // Booked: the list is closed on the server copy (clearing it next is
      // not a removal of its cartons).
      ledger()?.close(0);
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
      clearAllScans(token); releaseSession();
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

  /** `explicit` = a total chosen in the more-than-your-total question ("Keep
   *  25"), handed over directly — the input's state is a render behind. */
  function handlePalletCountSubmit(explicit?: number) {
    const count = explicit ?? parseInt(boxCountInput, 10);
    trace('ui', 'count_submit', { pallet: currentPallet, input: explicit ?? boxCountInput, scanned: scannedBoxes.length, prefill: countPrefillShown, kept: explicit !== undefined || undefined });
    // Typing the total answers whatever the footer was saying.
    clearScanNotice();
    if (isNaN(count) || count < 1) {
      setPalletCountError(tr('palletVerify.invalidBoxNumber'));
      return;
    }
    // More cartons on the list than the total entered. It used to be refused
    // ("the total must be at least 25"), and on document 48429 David typed
    // the 25 the scanner demanded for a 22-carton pallet: 3 photo-captured
    // cartons had been counted again by 22 labels. Now the question says what
    // it sees and offers remove / keep / fix (the overTotal dialog). A
    // single-item group's 2 samples are rows like any other here, so this
    // also covers a changed single-item total under its samples.
    const above = listAboveTotal(count, scannedBoxes);
    if (above) {
      trace('ui', 'count_below_list', {
        pallet: currentPallet, declared: count, on_list: above.onList, extra: above.extra,
        suggested: above.suggested.length || undefined, edit: totalEdit !== null || undefined,
      });
      setPalletCountError(null);
      setOverTotal({ ...above, via: 'submit' });
      return;
    }
    // A single-item pallet whose total was just changed (canEditTotal): the
    // total is its one locked group's count, plus any carton counted on its
    // own beside it.
    const editedSingle =
      totalEdit !== null && !pendingSingleGroup && uniformGroups.size === 1
        ? Array.from(uniformGroups.values())[0]
        : null;
    const othersBeside = editedSingle ? committedCount() - editedSingle.total_count : 0;
    setPalletCountError(null);
    setCountAsked(false);
    setConfirmedBoxCount(count);
    if (totalEdit !== null) {
      // A changed total is the one figure a worker could lower to dodge the
      // shortfall modal, so every change is on the trace.
      trace('ui', 'count_changed', {
        pallet: currentPallet, from: totalEdit, to: count,
        scope: editedSingle ? 'single_item' : 'pallet_total',
        group: editedSingle ? { name_key: editedSingle.name_key, from: editedSingle.total_count } : undefined,
      });
      setTotalEdit(null);
    }

    if (editedSingle) {
      // Same as the first single-item count below: re-lock the group at the
      // new count and confirm with BOTH handed over explicitly — a deferred
      // callback reading them off state would post the old values.
      const nextGroups = new Map(uniformGroups);
      nextGroups.set(editedSingle.name_key, { ...editedSingle, total_count: count - othersBeside });
      setUniformGroups(nextGroups);
      fetch('/api/multi-pallet-session', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, current_box_count: count }),
      }).catch(() => {});
      setTimeout(() => handleConfirmPallet({ boxCount: count, groups: nextGroups }), 0);
      return;
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
  // same input, prefilled; a total under the list is asked about, never refused. Not on
  // a single-item pallet: there the total IS the locked group's count.
  // Since 2026-10-15 (client request (c)) a single-item pallet's total can be
  // changed too, any time before the LPN: one locked group whose count is
  // the total. Saving re-locks the group and confirms with the new count
  // passed explicitly (handlePalletCountSubmit) — as the first count did.
  const canEditTotal =
    phase === 'scanning' && confirmedBoxCount > 0 && uniformGroups.size <= 1 && !pendingSingleGroup;

  function startTotalEdit() {
    if (!canEditTotal) return;
    trace('ui', 'count_edit_open', { pallet: currentPallet, from: confirmedBoxCount });
    clearScanNotice();
    setTotalEdit(confirmedBoxCount);
    setBoxCountInput(String(confirmedBoxCount));
    setPalletCountError(null);
    setConfirmedBoxCount(0);
    setCountFocusTick((n) => n + 1);
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
    /** The scan rows just booked — mirrors the server's completed_pallets[].barcodes. */
    bookedBarcodes?: string[],
  ) {
    trace('ui', 'pallet_completed', { pallet: currentPallet, lpn: data.lpn, type: palletTypeLabel, boxCount, next_pallet: data.next_pallet, all_done: data.all_done });
    // Booked: the list is closed on the server copy (clearing it for the next
    // pallet is not a removal of its cartons).
    ledger()?.close(currentPallet);
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
                barcodes: bookedBarcodes,
              },
            ],
          }
        : prev,
    );

    if (data.all_done) {
      clearAllScans(token); releaseSession();
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
    setCountAsked(false);
    setOverTotal(null);
    setSelectedBarcode(null);
    setEditForm(null);
    setEditError(null);
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
    // Not a removal of its cartons: whoever takes the pallet next gets them
    // from the server copy.
    ledger()?.close(currentPallet);
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
    if (refuseIfSessionLost('confirm_pallet')) return;
    trace('ui', 'confirm_pallet', { pallet: currentPallet, scanned: scannedBoxes.length, confirmedBoxCount, override: override ? { boxCount: override.boxCount, groups: override.groups } : undefined, forcedMix, detectedType });
    // One carton is a pallet too (the old 2-carton minimum left a lone
    // carton with no way to close). The single-item shortcut still needs its
    // 2 samples — it is offered only on 2 (maybeTriggerUniformPrompt).
    if (scannedBoxes.length < 1) return;
    // Every way into the LPN passes here — the slide, the shortfall modal,
    // the gap chip and the single-item auto-confirm — so the gate sits here.
    if (labelGate.count > 0) {
      refuseForLabels(labelGate.count, labelGate.batchIds, 'page');
      return;
    }
    setPhase('confirming');
    setError(null);
    // Cartons another tab / phone saved on the server that this screen does
    // not show yet: show them first, the worker confirms again.
    if (await reconcileBeforeConfirm(currentPallet)) {
      setPhase('scanning');
      showToast(tr('palletVerify.listUpdatedFromServer'), 'cloud_sync', '#13a4ec');
      return;
    }
    // Label reads still in flight are waited for (bounded); a carton whose
    // read failed goes back to the list, where the gate holds it — S03 booked
    // one with no name and 0 kg (settleReadsBeforeBook).
    if (!(await settleReadsBeforeBook('pallet'))) {
      setSwipeKey((k) => k + 1);
      setPhase('scanning');
      return;
    }
    // The list as it is now (the reconcile above awaited): book exactly this —
    // with every carton's weight and expiry following its barcode, the last
    // pass of the client's barcode-wins rule (lib/barcode-reconcile.ts).
    const rowsToBook = bookWithBarcode(scannedBoxesRef.current, 'pallet');

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
            rowsToBook.map(({ ocr_status: _, image_data: _img, ...box }) => box),
            session?.document_number || '',
            currentPallet,
          ),
          // Single jobs: the server refuses a pallet that is no longer the
          // current one (another tab / phone already booked it).
          pallet_number: currentPallet,
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

      if ((res.status === 409 && data.error === 'pallet_already_completed')
        || (res.status === 400 && data.code === 'session_completed')) {
        // Booked from another tab / phone: nothing was written now. Reload
        // onto the session's current pallet (or the done screen). The list
        // stays in the server copy; the trace names every carton on this
        // screen so a late one can be found and added by hand.
        trace('ui', 'pallet_already_completed', {
          pallet: currentPallet, current: data.current_pallet, code: data.code || data.error,
          barcodes: rowsToBook.map((b) => b.barcode),
        });
        ledger()?.close(currentPallet);
        showToast(tr('palletVerify.palletAlreadyBooked', { n: currentPallet }), 'info', '#13a4ec');
        window.setTimeout(() => window.location.reload(), 1500);
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
      applyCompletion(data, palletTypeLabel, declaredCount, rowsToBook.map((b) => b.barcode));
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
  //    reaches the declared box count for this pallet, AND
  //  - every scanned box has resolved data (no `needs_review` flag, and no
  //    failed label read — lib/failed-read.ts blocksConfirm, S03 23/10).
  //    Worker must tap each warning, see the captured sticker, and fix
  //    the name/weight before the pallet can advance.
  // A list ABOVE the declared total asks before it books (confirmPalletChecked).
  const committed = committedCount();
  const unresolvedWarnings = scannedBoxes.filter(blocksConfirm).length;
  const hasUnresolvedWarnings = unresolvedWarnings > 0;
  // Meat short-shipment feature: unreadable boxes NO LONGER hard-block. They
  // become a soft warning routed to "Create LPN anyway" so a worker is never
  // stuck on a pallet. When the feature is off, the old behaviour holds
  // (warnings block until each box is fixed or deleted).
  const softWarnings = !!session?.meat_discrepancy;
  // An open ratio weight doubt is not an unreadable carton: soft mode does
  // not wave it through "Create LPN anyway" (client, 25/10 — 3x off holds).
  const warningsBlock = (hasUnresolvedWarnings && !softWarnings) || scannedBoxes.some(isOpenRatioDoubt);
  const canConfirm =
    !pendingUniformPrompt &&
    !pendingSingleGroup &&
    confirmedBoxCount > 0 &&
    committed >= confirmedBoxCount &&
    !hasUnresolvedWarnings;
  // Force-create: the worker committed FEWER than declared (a miscount) OR
  // there are unreadable boxes we're allowed to wave through (feature on).
  // Creates the LPN with the committed count behind a warning modal; unreadable
  // boxes are recorded unverified. One counted carton is enough (it was 2: a
  // pallet that really held 1 carton could not be closed at all).
  const canForceConfirm =
    !pendingUniformPrompt &&
    !pendingSingleGroup &&
    confirmedBoxCount > 0 &&
    committed >= 1 &&
    !warningsBlock &&
    (committed < confirmedBoxCount || (hasUnresolvedWarnings && softWarnings));
  // Cartons still to scan against the worker's total (0 when none is set).
  const shortCount = Math.max(0, confirmedBoxCount - committed);

  // The pallet-total input: only when the worker asks for it — "Done
  // scanning?" (countAsked), "Yes — only this product" (pendingSingleGroup) or
  // the pencil (totalEdit). It used to open by itself (4 read cartons, the
  // first label, "No — other products too") and to hide while any sticker
  // was being read, coming back with autofocus after every scan — the
  // keyboard over the camera, carton after carton (19/10). While scanning,
  // the status line just says how many are on the list.
  const showCountInput = confirmedBoxCount === 0 && (
    totalEdit !== null || countAsked || !!pendingSingleGroup
  );

  // SCN-14: what the input offers before the worker types — the note's
  // cartons for this pallet when knowable, else (mixed only) the scanned
  // count. Never submitted for him: he still confirms with Set.
  const countPrefillKey = `${currentPallet}:${pendingSingleGroup ? 's:' + pendingSingleGroup.name_key : 'm'}`;
  let countPrefillNow: CountPrefill | null = null;
  if (showCountInput && totalEdit === null && session) {
    const lines = session.ocr_data ?? [];
    const matched = pendingSingleGroup
      ? matchInvoiceItem(pendingSingleGroup.item_name_hebrew, pendingSingleGroup.item_name, lines)
      : null;
    countPrefillNow = countPrefill({
      lines,
      palletCount: pallet_count,
      currentPallet,
      looseBoxCount: session.loose_box_count || 0,
      isSplit: isSplitSession(session),
      completedBoxCounts: (session.completed_pallets || []).map((p) => p.box_count),
      meatCommitted: session.meat_committed,
      singleItemLine: pendingSingleGroup ? (lines.find((l) => l === matched) ?? null) : undefined,
      scannedTotal: listTotal(scannedBoxes),
    });
  }
  const countPrefillValue = countPrefillNow?.value ?? null;
  const countPrefillSource = countPrefillNow?.source ?? null;
  useEffect(() => {
    if (countPrefillValue === null && countPrefillKeyRef.current === countPrefillKey) return;
    const next = countPrefillValue !== null && countPrefillSource
      ? { value: countPrefillValue, source: countPrefillSource }
      : null;
    if (countPrefillKeyRef.current !== countPrefillKey) {
      // New pallet / path. Fill only an empty input: a restored or
      // worker-typed number is never overwritten.
      if (next === null) {
        // Input not open yet, or nothing to offer. Drop a tag left from the
        // previous pallet/path so it can't label a number he types now.
        if (countPrefillShown) setCountPrefillShown(null);
        return;
      }
      countPrefillKeyRef.current = countPrefillKey;
      if (boxCountInput !== '') { setCountPrefillShown(null); return; }
      setBoxCountInput(String(next.value));
      setCountPrefillShown(next);
      trace('ui', 'count_prefill', { pallet: currentPallet, value: next.value, source: next.source });
      return;
    }
    // Same pallet/path: keep an UNTOUCHED prefill current (the scanned count
    // rises as he scans). Once he edits it, it is his number.
    if (next && countPrefillShown && boxCountInput === String(countPrefillShown.value)
        && (next.value !== countPrefillShown.value || next.source !== countPrefillShown.source)) {
      setBoxCountInput(String(next.value));
      setCountPrefillShown(next);
    }
  }, [countPrefillKey, countPrefillValue, countPrefillSource, boxCountInput, countPrefillShown, currentPallet]);
  // The source line shows only while the input still holds the prefill.
  const countPrefillTag = countPrefillShown && boxCountInput === String(countPrefillShown.value)
    ? countPrefillShown.source
    : null;

  // Group scanned boxes by normalized OCR'd Hebrew name (with worker-accepted
  // AI merges applied). Barcode digits are intentionally NOT used — they're
  // per-box dedup keys, never product identifiers. See lib/group-key.ts.
  const groupedByName = groupBoxesByName(scannedBoxes, acceptedMerges);
  // Object<key, boxes[]> shape for the existing render paths (Object.entries
  // is what the JSX below expects).
  const groupedItems: Record<string, BoxScan[]> = {};
  for (const [k, v] of groupedByName.entries()) groupedItems[k] = v;

  // "By item" — a VIEW filter over each scan list (lib/by-item-filter.ts).
  // It only decides which rows render; booking, counting, Delete all and
  // confirm keep acting on the whole list.
  const palletItemFilter = useItemFilter(scannedBoxes, language, acceptedMerges, 'pallet');
  const looseItemFilter = useItemFilter(looseBoxes, language, undefined, 'loose');

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
  // The server copy's state (lib/scan-ledger.ts): green "Saved" when every
  // carton on the screen is on the server, amber while changes are being
  // sent, red while offline (they wait on the phone and are sent when the
  // network is back).
  function SyncBadge() {
    const st = ledgerStatus;
    if (st.unavailable) return null; // server copy not deployed: page works as before
    if (!st.everSynced && st.pending === 0 && !st.failing) return null;
    const color = st.failing ? '#f8a3a3' : st.pending > 0 ? '#fbbf5c' : '#4ade80';
    const icon = st.failing ? 'cloud_off' : st.pending > 0 ? 'cloud_upload' : 'cloud_done';
    const label = st.failing
      ? tr('palletVerify.syncOffline', { n: st.pending })
      : st.pending > 0
        ? tr('palletVerify.syncPending', { n: st.pending })
        : tr('palletVerify.syncSaved');
    return (
      <span
        data-testid="sync-badge"
        aria-live="polite"
        className="inline-flex items-center gap-[3px] text-[9px] font-bold whitespace-nowrap"
        style={{ color }}
      >
        <MI name={icon} size={12} />
        {label}
      </span>
    );
  }

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

  // lib/session-owner.ts: another tab took this scan. Nothing here is saved
  // any more; continuing reloads, which restores the latest list and takes
  // the scan back. Rendering only this also stops this tab's camera.
  if (passive) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-5 p-6 bg-canvas text-center">
        <AlertTriangle className="text-warn w-12 h-12" />
        <p className="text-lg font-semibold text-ink">{tr('palletVerify.otherTab')}</p>
        <p className="text-ink-body">{tr('palletVerify.otherTabHint')}</p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded-xl bg-brand px-6 py-3 text-base font-semibold text-white"
        >
          {tr('palletVerify.otherTabContinue')}
        </button>
      </div>
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

            {/* Labels still waiting for the printer (Q5 New cartons, and with
                the print gate off any label): the signed "print later" page.
                Printing off: nothing is waiting, so no card. */}
            {PRINTING && (
              <PendingLabelsLink
                count={unprinted.labels.length}
                url={unprinted.labelsUrl}
                from="all_done"
                onCopied={() => showToast(tr('labels.linkCopied'), 'content_copy')}
              />
            )}

            {/* Right under the stats so it is in view without scrolling on a
                long pallet list. */}
            <PriorityPushStatus token={token} documentNumber={session?.document_number} />

            {/* Real: per-pallet sticker links (design list-row style). Each
                row says "Print": printing on only — the LPNs stay in Pallets. */}
            {PRINTING && completed.length > 0 && (
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
                for a reprint after the job (opens the Labels screen).
                Printing on only. */}
            {PRINTING && (
              <button
                type="button"
                onClick={() => setShowLabels(true)}
                className="flex items-center justify-center gap-[7px] w-full mt-4 border border-[#35516a] text-[#e8eef2] text-[12px] font-extrabold rounded-[11px] py-[11px]"
              >
                <MI name="label" size={17} className="text-brand-weak-ink" />
                {tr('terminal.reprintLabels')}
              </button>
            )}

            {looseCount > 0 && (
              <div className="mt-3 bg-warn-weak border border-warn/30 rounded-[11px] p-3 text-[11px] font-semibold text-warn-weak-ink">
                {tr('palletVerify.looseBoxesNote', { count: looseCount })}
              </div>
            )}

            {/* Points to the sticker pages, which are not linked while printing is off. */}
            {PRINTING && (
              <p className="text-[10px] text-ink-muted text-center mt-3">
                {tr('palletVerify.expiryNote')}
              </p>
            )}
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
    const unresolvedLooseWarnings = looseBoxes.filter(blocksConfirm).length;
    const hasUnresolvedLooseWarnings = unresolvedLooseWarnings > 0;
    const canConfirmLoose =
      scanned >= Math.min(2, declared) &&
      (declared === 0 || scanned >= declared) &&
      !hasUnresolvedLooseWarnings;
    // Fewer loose cartons than declared: a way through, behind one question
    // (looseShortAsk). There was none — the pile could only "scan N more".
    // None at all is a way through too: a pile declared on the note that
    // never came off the truck must not leave the delivery open for good
    // (the loose route and the bot both take an empty list).
    const canCloseLooseShort =
      declared > 0 && scanned < declared && !hasUnresolvedLooseWarnings;

    // Terminal layout: newest scan becomes the active card, the rest are
    // history rows (flat, newest first — the design's list shape).
    const looseNewestFirst = [...looseBoxes].reverse();
    // Units saves (lib/units-cartons.ts) draw as one row each — not in the
    // Delete chip's selection, which ticks cartons one by one. A list with
    // none is drawn exactly as before.
    const looseEntries = !selectMode && looseBoxes.some(isUnitsCarton)
      ? groupUnitsRows(looseNewestFirst, (_, i) => looseBoxes.length - i)
      : null;
    const looseActive = looseEntries
      ? (looseEntries[0]?.kind === 'box' ? looseEntries[0].box : undefined)
      : looseNewestFirst[0];
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
            key={box.barcode}
            onViewImage={box.image_data ? () => setViewingImage(box.image_data!) : undefined}
            onRetry={() => retryLooseOcr(box.barcode)}
            // A failed read can be typed in by hand, as on the newest card —
            // Retry is not the only way out (S01, 23/10).
            onEdit={() => openEdit(box, true)}
            onDelete={onDelete}
          />
        );
      }
      return (
        <ScanActions
          key={box.barcode}
          onEdit={() => openEdit(box, true)}
          onIdentical={canDeclareIdentical(box) ? () => openIdentical(box, true) : undefined}
          {...groupCountAction(box, true)}
          onDelete={onDelete}
        />
      );
    };

    // One loose carton's history row (also a units save's cartons, opened).
    const looseHistoryRow = (box: BoxScan, index: number, key: string) => (
      <HistoryRow
        key={key}
        index={index}
        name={box.item_name_hebrew || box.item_name || '—'}
        barcode={isNoBarcodeId(box.barcode) ? undefined : box.barcode}
        weight={isUnitsCarton(box) ? String(box.units) : box.weight > 0 ? box.weight.toFixed(2) : undefined}
        weightFromBarcode={barcodeMarks(box)?.weight ? tr('terminal.fromBarcode') : undefined}
        unitLabel={isUnitsCarton(box) ? tr('carton.unitsToggle') : tr('common.kg')}
        status={
          box.ocr_status === 'processing'
            ? 'pending'
            : box.ocr_status === 'failed'
            ? 'failed'
            : cardNote(box, tr)
            ? 'pending'
            : 'done'
        }
        note={cardNote(box, tr)}
        onClick={selectMode
          ? () => toggleSelectCarton(box.barcode)
          : () => setSelectedBarcode(selectedBarcode === box.barcode ? null : box.barcode)}
        actions={selectMode ? undefined : looseRowActions(box)}
        select={selectMode ? { checked: selectPicked.has(box.barcode), locked: bookedInSession.has(box.barcode) } : undefined}
        unprinted={unprintedShown.has(box.barcode)}
        unprintedLabel={tr('terminal.labelNotPrinted')}
        highlight={box.barcode === flashBarcode}
      />
    );

    const looseFooter = (
      <>
        {footerError}
        {weightReviewBar(true)}
        {canConfirmLoose && labelGate.count > 0 ? (
          // Ready to finish, but saved labels are unprinted: print first.
          labelGateFooter(true)
        ) : canConfirmLoose && phase !== 'loose_confirming' ? (
          // Brand (blue) slide: this books the loose cartons like any normal
          // confirm. Amber slides are kept for booking WITH a shortfall.
          <SwipeConfirm
            key={swipeKey}
            onConfirm={() => confirmPastWeightDoubts(true)}
            label={tr('palletVerify.swipeConfirmLoose', { count: scanned })}
          />
        ) : (
          hasUnresolvedLooseWarnings ? (
          <button
            onClick={() => {
              // The gate's own predicate: the carton it counts is the one opened.
              const bad = looseBoxes.find(blocksConfirm);
              if (bad) openEdit(bad, true);
            }}
            className="flex items-center justify-center gap-[6px] w-full py-3 rounded-[13px] font-black text-[14px] bg-warn text-canvas"
          >
            <MI name="report_problem" size={18} />
            {unresolvedLooseWarnings === 1
              ? tr('palletVerify.warningsBlockConfirmOne')
              : tr('palletVerify.warningsBlockConfirm', { count: unresolvedLooseWarnings })}
          </button>
          ) : canCloseLooseShort && labelGate.count > 0 ? (
            labelGateFooter(true)
          ) : canCloseLooseShort ? (
            // Secondary, outlined amber, like the pallet's "Fewer cartons
            // arrived?": the exception, not the next step.
            <button
              onClick={() => { trace('ui', 'loose_close_short_open', { declared, scanned }); setLooseShortAsk(true); }}
              disabled={phase === 'loose_confirming'}
              className="flex items-center justify-center gap-[6px] w-full py-3 px-3 rounded-[13px] font-extrabold text-[13px] leading-tight text-center bg-tile border-2 border-warn/60 text-warn-weak-ink disabled:opacity-50"
            >
              <MI name="inventory_2" size={18} className="shrink-0" />
              <span className="min-w-0">
                {scanned === 0 ? tr('palletVerify.closeShortLooseNoneBtn') : tr('palletVerify.closeShortLooseBtn', { count: scanned })}
              </span>
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
        {/* No caption under the orange button: it said the same sentence,
            "— tap to open" included, on text that opens nothing. */}
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
            <span className="pe-2 flex items-center gap-2">
              <SyncBadge />
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
              paused={!!editForm || overlayOpen || selectMode || phase === 'loose_confirming'}
              preferCartonCodes
              acceptValue={acceptScannerValue}
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
            traceName="loose"
            toolbar={
              <ToolDock
                chips={buildDockChips({
                  gap: () => showToast(tr('terminal.gapNotApplicable'), 'report_problem', '#fbbf5c'),
                })}
                onLockedPress={showLockToast}
              />
            }
            footer={selectMode ? selectionFooter(true) : looseFooter}
          >
            {(
              <>
                {scanned > 0 && (
                  <ByItemBar
                    filter={looseItemFilter}
                    received={scanned}
                    expected={declared}
                    tone={declared > 0 && scanned >= declared ? 'done' : 'warn'}
                  />
                )}
                {selectHint}
                {looseActive && looseItemFilter.matches(looseActive) && (
                  <ActiveScanCard
                    tone="warn"
                    index={looseBoxes.length}
                    name={looseActive.item_name_hebrew || looseActive.item_name || '—'}
                    value={isUnitsCarton(looseActive) ? String(looseActive.units) : looseActive.weight > 0 ? looseActive.weight.toFixed(2) : '—'}
                    unit={isUnitsCarton(looseActive) ? tr('carton.unitsToggle') : tr('common.kg')}
                    barcode={looseActive.barcode}
                    expiry={looseActive.expiry || undefined}
                    fromBarcode={barcodeMarks(looseActive)}
                    status={
                      looseActive.ocr_status === 'processing'
                        ? 'reading'
                        : looseActive.ocr_status === 'failed'
                        ? 'failed'
                        : 'done'
                    }
                    note={cardNote(looseActive, tr)}
                    expanded={activeExpanded}
                    onToggleExpand={() => setActiveExpanded((v) => !v)}
                    onEdit={() => openEdit(looseActive, true)}
                    onDelete={() => { rescanLooseBox(looseActive.barcode); setSelectedBarcode(null); }}
                    onIdentical={canDeclareIdentical(looseActive) ? () => openIdentical(looseActive, true) : undefined}
                    {...groupCountAction(looseActive, true)}
                    onRetry={looseActive.ocr_status === 'failed' ? () => retryLooseOcr(looseActive.barcode) : undefined}
                    onViewImage={looseActive.image_data ? () => setViewingImage(looseActive.image_data!) : undefined}
                    unprinted={unprintedShown.has(looseActive.barcode)}
                    highlight={looseActive.barcode === flashBarcode}
                    select={selectMode ? {
                      checked: selectPicked.has(looseActive.barcode),
                      locked: bookedInSession.has(looseActive.barcode),
                      onToggle: () => toggleSelectCarton(looseActive.barcode),
                    } : undefined}
                  />
                )}
                {looseEntries ? looseEntries.slice(looseActive ? 1 : 0).map((e, i) => {
                  if (e.kind === 'box') return looseItemFilter.matches(e.box) && looseHistoryRow(e.box, e.index, e.box.barcode + i);
                  const shown = e.rows.filter((r) => looseItemFilter.matches(r.box));
                  if (shown.length === 0) return null;
                  const first = e.rows[0].box;
                  const sum = unitsBatchSummary(e.rows.map((r) => r.box));
                  const open = openUnitsBatch === e.batch;
                  return (
                    <UnitsBatchRow
                      key={`units:${e.batch}`}
                      name={first.item_name_hebrew || first.item_name || '—'}
                      summary={tr(unitsRowKey(sum.cartons), { n: sum.cartons, date: shortExpiry(sum.firstExpiry) })
                        + (sum.moreExpiries > 0 ? ` +${sum.moreExpiries}` : '')}
                      units={sum.units}
                      unitLabel={tr('carton.unitsToggle')}
                      expanded={open}
                      onToggle={() => {
                        trace('ui', 'units_batch_toggle', { batch: e.batch, open: !open, cartons: sum.cartons });
                        setOpenUnitsBatch(open ? null : e.batch);
                      }}
                    >
                      {shown.map((r, j) => looseHistoryRow(r.box, r.index, r.box.barcode + j))}
                    </UnitsBatchRow>
                  );
                }) : looseRest.map((box, i) => looseItemFilter.matches(box) && looseHistoryRow(box, looseBoxes.length - 1 - i, box.barcode + i))}
              </>
            )}
          </BottomSheet>
        </div>

        <Toast toast={toast} />
        {drawer.node}
        {palletsBrowser}
        {cartonOverlays}
        {/* The loose cartons' editor — Edit on a row and the amber "Fix N
            warnings" open it here. Without it the camera paused under an
            editor that never appeared, and Finish loose stayed blocked. */}
        {editPanelNode}
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
          {/* Labels still waiting for the printer — this pallet's and any
              earlier one's: the signed "print later" page for the note.
              Printing off: no card, and no "Print label for this pallet". */}
          {PRINTING && (
            <PendingLabelsLink
              count={unprinted.labels.length}
              url={unprinted.labelsUrl}
              from="pallet_done"
              onCopied={() => showToast(tr('labels.linkCopied'), 'content_copy')}
            />
          )}
          {PRINTING && lpnUrl && (
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
        <Toast toast={toast} />
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
          key={box.barcode}
          onViewImage={box.image_data ? () => setViewingImage(box.image_data!) : undefined}
          onRetry={() => retryPalletOcr(box.barcode)}
          // A failed read can be typed in by hand, as on the newest card —
          // Retry is not the only way out (S01, 23/10).
          onEdit={() => openEdit(box)}
          onDelete={onDelete}
        />
      );
    }
    return (
      <ScanActions
        key={box.barcode}
        onEdit={() => openEdit(box)}
        onIdentical={canDeclareIdentical(box) ? () => openIdentical(box, false) : undefined}
        {...groupCountAction(box, false)}
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
    // Quiet while scanning: how many are on the list, not "enter the total
    // below" after every carton. The total is asked on "Done scanning?".
    ? (committed < 1 ? tr('palletVerify.scanToStart') : tr('palletVerify.scannedSoFar', { count: committed }))
    : tr('palletVerify.leftToScan', { left: shortCount, total: confirmedBoxCount });

  // "Done scanning? Enter the box total" — the one way to the total, there
  // from the first counted carton until a total is set. It used to show only
  // for 1–3 read cartons and hide while a sticker was read; past that the
  // input opened by itself (showCountInput).
  const showDoneScanning =
    confirmedBoxCount === 0 && !showCountInput && !pendingUniformPrompt && committed >= 1;

  /** "Done scanning?": open the total, focused — the worker asked for it. */
  function openCountInput() {
    trace('ui', 'count_open', { pallet: currentPallet, scanned: scannedBoxes.length });
    clearScanNotice(); // a question left on the camera is moot now
    setForcedMix(true);
    setCountAsked(true);
    setPalletCountError(null);
    setCountFocusTick((n) => n + 1);
  }

  /** The confirm slide: a list above the confirmed total asks first (the
   *  total was set, then more cartons were added). */
  function confirmPalletChecked() {
    // Mixed pallets only: a locked single-item group books its own total,
    // whatever its samples on the list (the Set check covers its total).
    const above = uniformGroups.size === 0 ? listAboveTotal(confirmedBoxCount, scannedBoxes) : null;
    if (above) {
      trace('ui', 'count_below_list', {
        pallet: currentPallet, declared: confirmedBoxCount, on_list: above.onList, extra: above.extra,
        suggested: above.suggested.length || undefined, via: 'confirm',
      });
      setSwipeKey((k) => k + 1);
      setOverTotal({ ...above, via: 'confirm' });
      return;
    }
    confirmPastWeightDoubts(false);
  }

  // Footer — priority-ordered modes:
  // (1) single_or_mix uniform prompt (Complete / Continue),
  // (2) deferred pallet box-count input,
  // (3) standard confirm (swipe) / force-confirm / disabled reason.
  const mainFooter = (
    <>
      {footerError}
      {weightReviewBar(false)}
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
            {tr('palletVerify.uniformChoose', {
              weight: pendingUniformPrompt.avg_weight.toFixed(3),
              // 2, or more when OCR finished several at once / a restored list.
              count: pendingUniformPrompt.sample_barcodes.length,
            })}
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
          {/* The other way to the same job: a printed label per carton
              (All boxes identical), the scanned samples counted in. Printing
              on only — "All boxes identical" stays on the row itself. */}
          {PRINTING && uniformLabelSample() && <button
            onClick={handleUniformAsLabels}
            disabled={phase === 'confirming'}
            className="flex items-center justify-center gap-1 w-full min-h-[36px] text-xs font-extrabold text-brand-weak-ink underline underline-offset-2"
          >
            <MI name="new_label" size={15} /> {tr('palletVerify.uniformLabels')}
          </button>}
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
            {/* Where the pre-filled number came from — on the title line, not
                a new one (same 641px footer budget as Cancel). */}
            {totalEdit === null && countPrefillTag && (
              <span className="shrink-0 text-[11px] text-ink-muted">
                {tr(countPrefillTag === 'note' ? 'palletVerify.prefillFromNote' : 'palletVerify.prefillFromScans')}
              </span>
            )}
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
                  scanned: pendingSingleGroup.sample_barcodes.length,
                })
              : tr('palletVerify.deferredCountHint', { scanned: scannedBoxes.length })}
          </p>
          <div className="flex gap-2">
            <input
              ref={countInputRef}
              type="number"
              inputMode="numeric"
              // No floor: a total under the list is asked about, not refused
              // (handlePalletCountSubmit → the overTotal question).
              min={1}
              value={boxCountInput}
              onChange={(e) => {
                setBoxCountInput(e.target.value);
                setPalletCountError(null);
              }}
              onKeyDown={(e) => e.key === 'Enter' && handlePalletCountSubmit()}
              // A pre-filled figure is replaced by the first digit typed,
              // not appended to.
              onFocus={(e) => e.currentTarget.select()}
              placeholder={tr('palletVerify.boxCountPlaceholder')}
              className="flex-1 min-w-0 text-center text-xl font-black font-mono text-ink bg-sunken border-2 border-line-strong rounded-[12px] py-2 px-3 transition outline-none focus:border-brand focus:ring-4 focus:ring-brand/20 placeholder:text-ink-muted placeholder:font-medium placeholder:text-base placeholder:font-sans"
              // Focused by countFocusTick on the worker's own tap only — no
              // autoFocus, which fired on every remount of this footer.
            />
            <button
              onClick={() => handlePalletCountSubmit()}
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
              key={swipeKey}
              onConfirm={confirmPalletChecked}
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
                // The gate's own predicate: the carton it counts is the one opened.
                const bad = scannedBoxes.find(blocksConfirm);
                if (bad) openEdit(bad);
              }}
              className="flex items-center justify-center gap-[6px] w-full py-3 rounded-[13px] font-black text-[14px] bg-warn text-canvas"
            >
              <MI name="report_problem" size={18} />
              {unresolvedWarnings === 1
                ? tr('palletVerify.warningsBlockConfirmOne')
                : tr('palletVerify.warningsBlockConfirm', { count: unresolvedWarnings })}
            </button>
            ) : showDoneScanning ? (
            // No grey placeholder while "Done scanning?" is offered: it only
            // repeated the status line ("Enter pallet total below" twice) and
            // cost ~56px, which on a 568–641px phone pushed the newest card's
            // actions under the footer even at the tall snap.
            null
            ) : (
            <button
              disabled
              className="w-full py-3 rounded-[13px] font-extrabold text-base bg-sunken text-ink-muted cursor-not-allowed"
            >
              {canConfirm
                ? tr('palletVerify.confirmPalletBtn', { current: currentPallet })
                : committed < 1
                ? tr('palletVerify.scanMoreToContinueOne')
                : confirmedBoxCount === 0
                ? // No total declared yet, so nothing is outstanding — the old
                  // fallback rendered a flat "0 more boxes needed" here.
                  tr('palletVerify.setTotalBelow')
                : shortCount === 1
                ? tr('palletVerify.boxesNeededOne')
                : tr('palletVerify.boxesNeeded', { count: shortCount })}
            </button>
            )
          )}
          {showDoneScanning && (
            // The way off a pallet the scanner can't classify on its own —
            // a handful of boxes that aren't all one uniform item. It used to
            // be a thin grey underline that workers missed, so it now carries
            // the same weight as the other footer actions.
            <button
              onClick={openCountInput}
              className={`flex items-center justify-center gap-[6px] w-full ${hasUnresolvedWarnings ? 'mt-2' : ''} py-3 rounded-[13px] font-extrabold text-[14px] bg-tile border-2 border-brand text-brand-weak-ink`}
            >
              <MI name="done_all" size={18} /> {tr('palletVerify.doneScanning')}
            </button>
          )}
          {hasUnresolvedWarnings && softWarnings && !warningsBlock && (
            // Only the soft note: when the cartons hold the pallet, the
            // orange button above already says it (and is the thing to tap)
            // — a caption repeating "— tap to open" opened nothing.
            <p className="flex items-center justify-center gap-1 text-[11px] text-warn-weak-ink text-center mt-1.5">
              <AlertTriangle className="w-3 h-3 shrink-0" />{' '}
              {tr('palletVerify.unreadableSoftNote', { count: unresolvedWarnings })}
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
          <span className="pe-2 flex items-center gap-2">
            <SyncBadge />
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
            paused={!!editForm || overlayOpen || selectMode || phase === 'confirming'}
            // An EAN-13 product code beside the carton's own long code in one
            // frame never wins (lib/frame-reads.ts).
            preferCartonCodes
            acceptValue={acceptScannerValue}
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
          traceName="pallet"
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
          footer={selectMode ? selectionFooter(false) : mainFooter}
        >
          {(
            <>
              {scannedBoxes.length > 0 && (
                <ByItemBar
                  filter={palletItemFilter}
                  received={committed}
                  expected={confirmedBoxCount}
                  tone={canConfirm ? 'done' : 'brand'}
                />
              )}

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

              {selectHint}
              {activeBox && palletItemFilter.matches(activeBox) && (
                <ActiveScanCard
                  index={scannedBoxes.length}
                  name={activeBox.item_name_hebrew || activeBox.item_name || '—'}
                  value={activeBox.weight > 0 ? activeBox.weight.toFixed(2) : '—'}
                  unit={tr('common.kg')}
                  barcode={activeBox.barcode}
                  expiry={activeBox.expiry || undefined}
                  fromBarcode={barcodeMarks(activeBox)}
                  status={
                    activeBox.ocr_status === 'processing'
                      ? 'reading'
                      : activeBox.ocr_status === 'failed'
                      ? 'failed'
                      : 'done'
                  }
                  note={cardNote(activeBox, tr)}
                  expanded={activeExpanded}
                  onToggleExpand={() => setActiveExpanded((v) => !v)}
                  onEdit={() => openEdit(activeBox)}
                  onDelete={() => { rescanPalletBox(activeBox.barcode); setSelectedBarcode(null); }}
                  onIdentical={canDeclareIdentical(activeBox) ? () => openIdentical(activeBox, false) : undefined}
                  {...groupCountAction(activeBox, false)}
                  onRetry={activeBox.ocr_status === 'failed' ? () => retryPalletOcr(activeBox.barcode) : undefined}
                  onViewImage={activeBox.image_data ? () => setViewingImage(activeBox.image_data!) : undefined}
                  unprinted={unprintedShown.has(activeBox.barcode)}
                  highlight={activeBox.barcode === flashBarcode}
                  select={selectMode ? {
                    checked: selectPicked.has(activeBox.barcode),
                    locked: bookedInSession.has(activeBox.barcode),
                    onToggle: () => toggleSelectCarton(activeBox.barcode),
                  } : undefined}
                />
              )}

              {restBoxes.map((box, i) => palletItemFilter.matches(box) && (
                <HistoryRow
                  key={box.barcode + i}
                  index={scannedBoxes.length - 1 - i}
                  name={box.item_name_hebrew || box.item_name || '—'}
                  barcode={isNoBarcodeId(box.barcode) ? undefined : box.barcode}
                  weight={box.weight > 0 ? box.weight.toFixed(2) : undefined}
                  weightFromBarcode={barcodeMarks(box)?.weight ? tr('terminal.fromBarcode') : undefined}
                  unitLabel={tr('common.kg')}
                  status={
                    box.ocr_status === 'processing'
                      ? 'pending'
                      : box.ocr_status === 'failed'
                      ? 'failed'
                      : cardNote(box, tr)
                      ? 'pending'
                      : 'done'
                  }
                  note={cardNote(box, tr)}
                  onClick={selectMode
                    ? () => toggleSelectCarton(box.barcode)
                    : () => setSelectedBarcode(selectedBarcode === box.barcode ? null : box.barcode)}
                  actions={selectMode ? undefined : palletRowActions(box)}
                  select={selectMode ? { checked: selectPicked.has(box.barcode), locked: bookedInSession.has(box.barcode) } : undefined}
                  unprinted={unprintedShown.has(box.barcode)}
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
        // The slide books exactly the {committed} it names: without the
        // override the typed total goes out as box_count, and a one-product
        // pallet whose cartons all weigh the same is booked at that total
        // (the route's uniform-single path) — 15, not the 9 counted. A locked
        // single group already has committed == its total.
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
                ? tr('palletVerify.closeShortBody', { declared: confirmedBoxCount, committed })
                : tr('palletVerify.unreadableSoftNote', { count: unresolvedWarnings })}
            </p>
            {weightDoubts(scannedBoxes).length > 0 && (
              // Said here, in the one question this close already asks —
              // never a second dialog on top of it.
              <p className="text-center text-xs font-bold text-[#fbbf5c] mt-2 leading-snug">
                {weightDoubts(scannedBoxes).length === 1
                  ? tr('palletVerify.weightAskBodyOne')
                  : tr('palletVerify.weightAskBody', { count: weightDoubts(scannedBoxes).length })}
              </p>
            )}
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
                onConfirm={() => { setPendingForceConfirm(false); handleConfirmPallet({ boxCount: committed, groups: uniformGroups }); }}
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
