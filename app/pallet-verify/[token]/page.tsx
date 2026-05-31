'use client';

import { use, useCallback, useEffect, useRef, useState } from 'react';
import {
  CheckCircle,
  XCircle,
  Loader2,
  Package,
  AlertCircle,
  AlertTriangle,
  Scale,
  Boxes,
  Pencil,
  Trash2,
  RotateCw,
  RefreshCw,
  Eye,
  Printer,
  Plus,
  Check,
} from 'lucide-react';
import { SmartScanner } from '@/components/scanner/SmartScanner';
import { DebugLogPanel } from '@/components/shared/DebugLogPanel';
import { SettingsPopover } from '@/components/shared/SettingsPopover';
import { installDebugLogCapture } from '@/lib/debug-log';
import { LanguageContext, useLangDir, t } from '@/lib/i18n';
import type { Language, MultiPalletSession, MultiPalletBoxScan, ParsedBarcode } from '@/types';
import { groupKeyForBox, groupBoxesByName } from '@/lib/group-key';
import { matchInvoiceItem } from '@/lib/invoice-match';
import { useSettingsStore } from '@/stores/settings-store';
import { scanSuccessFeedback, scanDuplicateFeedback } from '@/lib/scan-feedback';

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
  return range < 0.5 ? 'single-uniform' : 'single-nonuniform';
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
// When 2+ boxes of the same OCR'd Hebrew name come back with the same weight
// (within tolerance), the warehouse domain rule says ALL boxes of that item
// on this pallet are the same weight. Worker physically scans 2 samples and
// reports the real total count via a prompt.
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

type UniformPrompt =
  // First uniform pair AND only one item has been scanned so far → ask the
  // worker whether this is single-item or actually mix.
  | { mode: 'single_or_mix'; name_key: string; item_name: string; item_name_hebrew: string; avg_weight: number; sample_barcodes: string[] }
  // Any other case → mandatory: just need the count for this uniform sub-group.
  | { mode: 'mandatory_count'; name_key: string; item_name: string; item_name_hebrew: string; avg_weight: number; sample_barcodes: string[] };

// Tolerance (kg) for "same weight" — matches detectType() and the outbound
// uniform-override threshold.
const UNIFORM_WEIGHT_TOLERANCE = 0.5;

// ── Page state machine ──

type Phase = 'loading' | 'scanning' | 'confirming' | 'pallet_done' | 'loose_scanning' | 'loose_confirming' | 'all_done' | 'error';

export default function PalletVerifyPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);

  const [phase, setPhase] = useState<Phase>('loading');
  const [session, setSession] = useState<MultiPalletSession | null>(null);
  const [currentPallet, setCurrentPallet] = useState(1);
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
  const looseProcessedRef = useRef<Set<string>>(new Set());
  // Modal: full-size view of a captured frame (used after OCR failures so the
  // worker can confirm whether the photo is bad or worth retrying).
  const [viewingImage, setViewingImage] = useState<string | null>(null);
  // Uniform-pair state (per pallet — reset between pallets).
  const [uniformGroups, setUniformGroups] = useState<Map<string, UniformGroup>>(new Map());
  const [pendingUniformPrompt, setPendingUniformPrompt] = useState<UniformPrompt | null>(null);
  // Refs mirror the above state for read-during-callback access without stale
  // closure issues (used inside runOcr's success path).
  const uniformGroupsRef = useRef<Map<string, UniformGroup>>(new Map());
  const pendingUniformPromptRef = useRef<UniformPrompt | null>(null);
  useEffect(() => { uniformGroupsRef.current = uniformGroups; }, [uniformGroups]);
  useEffect(() => { pendingUniformPromptRef.current = pendingUniformPrompt; }, [pendingUniformPrompt]);
  // Item name_keys the worker marked "scan each box individually" — for the
  // "mix-e" shape (one item whose boxes have mixed weights, some matching some
  // not). Suppresses the uniform-count prompt for that item so every box is
  // scanned and recorded with its own real weight. Per pallet (reset between
  // pallets). Ref mirror so maybeTriggerUniformPrompt sees the latest set when
  // it runs inside a setState callback.
  const [individualKeys, setIndividualKeys] = useState<Set<string>>(new Set());
  const individualKeysRef = useRef<Set<string>>(new Set());
  useEffect(() => { individualKeysRef.current = individualKeys; }, [individualKeys]);
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
  // Number-input state for the mandatory_count prompt + its validation error.
  const [countInput, setCountInput] = useState('');
  const [countError, setCountError] = useState<string | null>(null);
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
          setSession(data);
          setPhase('all_done');
          return;
        }
        setSession(data);

        // All pallets confirmed but loose boxes still pending → restore loose phase
        // (e.g. user refreshed the tab between pallet 2/2 confirm and scanning loose boxes)
        if (data.current_pallet > data.pallet_count && (data.loose_box_count || 0) > 0) {
          setPhase('loose_scanning');
          return;
        }

        setCurrentPallet(data.current_pallet);
        if (data.current_box_count && data.current_box_count > 0) {
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
  }, [token]);

  // ── Barcode detected — SmartScanner passes the captured frame as imageData ──
  // The barcode IS on the sticker, so that frame is the sticker. Auto-OCR it.

  const handleBarcodeDetected = useCallback(
    (_barcode: string, _parsed: ParsedBarcode, imageData?: string) => {
      const barcode = _barcode.trim();
      if (processedRef.current.has(barcode)) {
        scanDuplicateFeedback(); // already scanned this sticker
        return;
      }
      processedRef.current.add(barcode);
      scanSuccessFeedback(); // good scan — box added below

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
              resolvedBarcode = digits;
              resolvedSku = digits.slice(0, 13);
              processedRef.current.add(digits); // so a later bar-scan of this sticker is caught
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

  // Decide whether the just-completed scan should fire a prompt. Reads via
  // refs (kept in sync by the useEffects above) so we always see the latest
  // uniformGroups / pendingUniformPrompt values, even when this is called
  // from inside another setState callback.
  function maybeTriggerUniformPrompt(latestBoxes: BoxScan[], justFinishedBarcode: string) {
    if (pendingUniformPromptRef.current) return; // already prompting
    const justFinished = latestBoxes.find((b) => b.barcode === justFinishedBarcode);
    if (
      !justFinished ||
      justFinished.ocr_status !== 'done' ||
      justFinished.weight <= 0 ||
      (!justFinished.item_name && !justFinished.item_name_hebrew)
    ) {
      return;
    }
    // Group key derived from the OCR'd Hebrew name (with worker-accepted
    // merges applied), never from barcode digits.
    const nameKey = acceptedMerges.get(groupKeyForBox(justFinished)) ?? groupKeyForBox(justFinished);
    if (uniformGroupsRef.current.has(nameKey)) return; // already locked
    if (individualKeysRef.current.has(nameKey)) return; // worker chose scan-each

    const sameItemDone = latestBoxes.filter((b) => {
      const k = acceptedMerges.get(groupKeyForBox(b)) ?? groupKeyForBox(b);
      return k === nameKey && b.ocr_status === 'done' && b.weight > 0;
    });
    if (sameItemDone.length < 2) return;
    const ws = sameItemDone.map((b) => b.weight);
    const span = Math.max(...ws) - Math.min(...ws);
    if (span >= UNIFORM_WEIGHT_TOLERANCE) return;

    const distinctNameKeys = new Set(
      latestBoxes
        .filter((b) => b.item_name || b.item_name_hebrew)
        .map((b) => acceptedMerges.get(groupKeyForBox(b)) ?? groupKeyForBox(b))
    );
    const mode: UniformPrompt['mode'] =
      distinctNameKeys.size === 1 && uniformGroupsRef.current.size === 0 ? 'single_or_mix' : 'mandatory_count';

    const avg = ws.reduce((a, b) => a + b, 0) / ws.length;
    setPendingUniformPrompt({
      mode,
      name_key: nameKey,
      item_name: justFinished.item_name || '',
      item_name_hebrew: justFinished.item_name_hebrew || '',
      avg_weight: Math.round(avg * 1000) / 1000,
      sample_barcodes: sameItemDone.map((b) => b.barcode),
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

  // "Continue scanning (this is mix)" → switch the prompt from
  // single_or_mix to mandatory_count for the same SKU.
  function handleContinueAsMix() {
    setPendingUniformPrompt((p) =>
      p ? { ...p, mode: 'mandatory_count' } : p
    );
    setCountInput('');
    setCountError(null);
  }

  // "Different weights — scan each box" → the mix-e shape: one item whose
  // boxes have mixed weights. Decline the count shortcut for this item; mark
  // its name_key so the uniform prompt won't fire again for it, and let the
  // worker scan every box (each recorded with its real weight). The boxes are
  // already counted as individuals by committedCount(), so nothing else to do.
  function handleScanEachIndividually() {
    const p = pendingUniformPrompt;
    if (!p) return;
    setIndividualKeys((prev) => new Set(prev).add(p.name_key));
    setPendingUniformPrompt(null);
    setCountInput('');
    setCountError(null);
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

  // Boxes already committed to the pallet from OTHER products, used to cap the
  // per-product count input. Exclude EVERY box of the product currently being
  // counted (by name_key) — not just the 2 trigger samples — because the count
  // the worker types covers all of them. (Counting the extra same-product
  // scans as "other" was the off-by-N behind the "max 63 instead of 65" bug.)
  function committedExcludingPending(): number {
    const pendingKey = pendingUniformPrompt?.name_key;
    let nonUniformIndividuals = 0;
    for (const box of scannedBoxes) {
      const k = acceptedMerges.get(groupKeyForBox(box)) ?? groupKeyForBox(box);
      if (uniformGroups.has(k)) continue;                   // already in a locked group
      if (pendingKey && k === pendingKey) continue;         // same product we're counting now
      nonUniformIndividuals += 1;
    }
    let lockedTotal = 0;
    for (const g of uniformGroups.values()) lockedTotal += g.total_count;
    return nonUniformIndividuals + lockedTotal;
  }

  function handleSetUniformCount() {
    const p = pendingUniformPrompt;
    if (!p || p.mode !== 'mandatory_count') return;
    const n = parseInt(countInput, 10);
    if (!Number.isFinite(n) || n < 1) {
      setCountError(tr('palletVerify.uniformInvalidCount'));
      return;
    }
    const remaining = confirmedBoxCount - committedExcludingPending();
    if (n > remaining) {
      setCountError(
        tr('palletVerify.uniformExceedsCount', {
          declared: confirmedBoxCount,
          max: Math.max(0, remaining),
        }),
      );
      return;
    }
    const group: UniformGroup = {
      name_key: p.name_key,
      item_name: p.item_name,
      item_name_hebrew: p.item_name_hebrew,
      avg_weight: p.avg_weight,
      total_count: n,
      sample_barcodes: p.sample_barcodes,
    };
    setUniformGroups((prev) => {
      const next = new Map(prev);
      next.set(p.name_key, group);
      return next;
    });
    setPendingUniformPrompt(null);
    setCountInput('');
    setCountError(null);
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

  // Always-visible bug-report widget. Tap the floating 🐛 button to see
  // captured console logs and copy them out — no Chrome DevTools needed.
  const debugPanel = <DebugLogPanel />;

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

  // Edit-a-scan view: a FULL-SCREEN sheet so the worker can see the captured
  // sticker large AND fix the item / weight / expiry in the same view. The
  // sticker sits at the top of a scrollable body; tapping it opens the pinch-
  // zoom overlay (z-[60], above this sheet). Save/Cancel stay pinned at the
  // bottom so they're always reachable regardless of how far the worker scrolls.
  const editModal = editForm ? (
    <div className="fixed inset-0 z-50 flex flex-col bg-raised">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-line shrink-0">
        <h2 className="text-base font-bold text-ink">{tr('palletVerify.editTitle')}</h2>
        <button
          onClick={() => setEditForm(null)}
          aria-label={tr('palletVerify.editCancel')}
          className="text-ink-muted hover:text-ink-body text-3xl leading-none px-2 -mr-2"
        >
          &times;
        </button>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Captured sticker preview — large. The whole point of this view is to
            let the worker fix the OCR by reading the actual photo. Tap to open
            the pinch-zoom overlay for an even closer look. */}
        {editForm.image_data && (
          <button
            type="button"
            onClick={() => setViewingImage(editForm.image_data!)}
            className="block w-full"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={editForm.image_data}
              alt={tr('palletVerify.viewWithIcon')}
              className="w-full max-h-[45vh] object-contain rounded-xl bg-canvas border border-line"
            />
            <p className="text-[11px] text-ink-muted mt-1 text-center">
              {tr('palletVerify.tapToZoom')}
            </p>
          </button>
        )}

        {(session?.ocr_data?.length ?? 0) > 0 && (
          <div>
            <label className="block text-xs font-medium text-ink-body mb-1">
              {tr('palletVerify.editPickItem')}
            </label>
            <div className="space-y-1.5">
              {(session?.ocr_data ?? []).map((it) => {
                const active = editForm.name_he === it.item_name_hebrew && !!it.item_name_hebrew;
                return (
                  <button
                    key={it.item_code + it.item_name_hebrew}
                    onClick={() =>
                      setEditForm({ ...editForm, name_he: it.item_name_hebrew, name_en: it.item_name_english })
                    }
                    className={`w-full text-start px-3 py-2 rounded-lg border text-sm transition ${
                      active
                        ? 'border-blue-500 bg-brand-weak text-brand-weak-ink font-semibold'
                        : 'border-line-strong text-ink-body hover:bg-hover'
                    }`}
                  >
                    {it.item_name_hebrew || it.item_name_english}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div>
          <label className="block text-xs font-medium text-ink-body mb-1">
            {tr('palletVerify.editTypeManually')}
          </label>
          <input
            type="text"
            dir="rtl"
            value={editForm.name_he}
            onChange={(e) => setEditForm({ ...editForm, name_he: e.target.value })}
            className="w-full text-base text-ink bg-raised border-2 border-line-strong rounded-xl py-2 px-3 outline-none focus:border-blue-600 focus:ring-4 focus:ring-blue-200"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-ink-body mb-1">
            {tr('palletVerify.editWeight')}
          </label>
          <input
            type="number"
            inputMode="decimal"
            step="0.001"
            min={0}
            value={editForm.weight}
            onChange={(e) => setEditForm({ ...editForm, weight: e.target.value })}
            className="w-full text-center text-xl font-bold text-ink bg-raised border-2 border-line-strong rounded-xl py-2 px-3 outline-none focus:border-blue-600 focus:ring-4 focus:ring-blue-200"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-ink-body mb-1">
            {tr('palletVerify.editExpiry')}
          </label>
          <input
            type="text"
            inputMode="numeric"
            dir="ltr"
            placeholder="DD/MM/YYYY"
            value={editForm.expiry}
            onChange={(e) => setEditForm({ ...editForm, expiry: e.target.value })}
            className="w-full text-center text-base text-ink bg-raised border-2 border-line-strong rounded-xl py-2 px-3 outline-none focus:border-blue-600 focus:ring-4 focus:ring-blue-200"
          />
        </div>
      </div>

      {/* Sticky action bar */}
      <div className="flex gap-3 p-4 border-t border-line shrink-0">
        <button
          onClick={() => setEditForm(null)}
          className="flex-1 py-3 rounded-xl bg-sunken text-ink-body font-semibold text-sm hover:bg-hover transition"
        >
          {tr('palletVerify.editCancel')}
        </button>
        <button
          onClick={handleSaveEdit}
          className="flex-1 py-3 rounded-xl bg-ok text-ink-inverse font-semibold text-sm hover:opacity-90 transition"
        >
          {tr('palletVerify.editSave')}
        </button>
      </div>
    </div>
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
        }),
      });
      const data = await res.json();
      if (!data.success) {
        setError(data.error || tr('palletVerify.failedLooseComplete'));
        setPhase('loose_scanning');
        return;
      }
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
        }),
      });
      const data = await res.json();

      if (!data.success) {
        setError(data.error || tr('palletVerify.failedComplete'));
        setPhase('scanning');
        return;
      }

      setLpn(data.lpn || '');
      setLpnUrl(data.lpn_url || '');

      // Mirror what the API just persisted into React's session state so the
      // all_done view (which reads session.completed_pallets) sees every
      // confirmed pallet — without needing a refetch after each confirm.
      // Per the user's config model: any non-uniform weights even on a single
      // item-name → 'mix' (scenario 2 / "Mix (a)"). Only same-name AND
      // same-weight counts as single.
      const palletTypeLabel: 'single' | 'mix' =
        detectedType === 'single-uniform' ? 'single' : 'mix';
      setSession((prev) =>
        prev
          ? {
              ...prev,
              current_pallet: data.next_pallet ?? prev.current_pallet,
              completed_pallets: [
                ...prev.completed_pallets,
                {
                  pallet_number: data.pallet_number,
                  lpn: data.lpn,
                  pallet_type: palletTypeLabel,
                  box_count: confirmedBoxCount,
                },
              ],
            }
          : prev,
      );

      if (data.all_done) {
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
        setTimeout(() => {
          setCurrentPallet(data.next_pallet);
          setBoxCountInput('');
          setConfirmedBoxCount(0);
          setScannedBoxes([]);
          processedRef.current.clear();
          setDetectedType('unknown');
          // Reset per-pallet uniform-detection state.
          setUniformGroups(new Map());
          setPendingUniformPrompt(null);
          setIndividualKeys(new Set());
          setSelectedBarcode(null);
          setEditForm(null);
          setCountInput('');
          setCountError(null);
          setPendingSingleGroup(null);
          setPalletCountError(null);
          // AI consolidation is per-pallet — merges accepted on pallet 1
          // shouldn't carry over to pallet 2.
          setAcceptedMerges(new Map());
          setRejectedMergePairs(new Set());
          setPendingMerge(null);
          // New deferred-count flow: stay in 'scanning'. The footer
          // surfaces the count input again after 2 OCR-completed scans.
          setPhase('scanning');
        }, 4000);
      }
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
  const unresolvedWarnings = scannedBoxes.filter((b) => b.needs_review).length;
  const hasUnresolvedWarnings = unresolvedWarnings > 0;
  const canConfirm =
    !pendingUniformPrompt &&
    committed >= Math.max(2, confirmedBoxCount) &&
    !hasUnresolvedWarnings;

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
        <span className="inline-flex items-center gap-1 text-xs bg-ok-weak text-ok-weak-ink rounded-full px-2 py-0.5 font-medium">
          <CheckCircle className="w-3.5 h-3.5 shrink-0" />
          {tr('palletVerify.singleUniformBadge')}
        </span>
      );
    if (detectedType === 'single-nonuniform')
      return (
        <span className="inline-flex items-center gap-1 text-xs bg-warn-weak text-warn-weak-ink rounded-full px-2 py-0.5 font-medium">
          <Scale className="w-3.5 h-3.5 shrink-0" />
          {tr('palletVerify.singleNonuniformBadge')}
        </span>
      );
    return (
      <span className="inline-flex items-center gap-1 text-xs bg-brand-weak text-brand-weak-ink rounded-full px-2 py-0.5 font-medium">
        <Boxes className="w-3.5 h-3.5 shrink-0" />
        {tr('palletVerify.mixBadge')}
      </span>
    );
  }

  // ── Box card ──

  function BoxCard({ box, idx }: { box: BoxScan; idx: number }) {
    // "Same-item" colour cue derived from the OCR'd name (with worker-accepted
    // merges applied), not barcode digits.
    const firstBox = scannedBoxes[0];
    const firstKey = firstBox
      ? acceptedMerges.get(groupKeyForBox(firstBox)) ?? groupKeyForBox(firstBox)
      : '';
    const thisKey = acceptedMerges.get(groupKeyForBox(box)) ?? groupKeyForBox(box);
    const sameItem = thisKey === firstKey;
    const displayName = box.item_name_hebrew || box.item_name;

    const cardBg =
      idx === 0
        ? 'bg-brand-weak border-brand/30'
        : detectedType === 'mix' || sameItem
        ? 'bg-ok-weak border-ok/30'
        : 'bg-warn-weak border-yellow-200';

    // Tap the card to reveal a Delete action (two-step, to avoid misclicks).
    // Exception: a needs_review box opens the edit modal directly — the worker
    // has to fix it before the pallet can be confirmed, so the warning row IS
    // a "fix me" affordance.
    const selected = selectedBarcode === box.barcode;
    const cardBgFinal = box.needs_review
      ? 'bg-warn-weak border-warn/30'
      : cardBg;
    return (
      <div
        onClick={() =>
          box.needs_review
            ? openEdit(box)
            : setSelectedBarcode(selected ? null : box.barcode)
        }
        className={`rounded-xl p-3 border text-sm cursor-pointer ${cardBgFinal} ${selected ? 'ring-2 ring-danger/40' : ''}`}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            {box.ocr_status === 'processing' ? (
              <div className="flex items-center gap-1.5 text-brand">
                <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                <span className="text-xs">{tr('palletVerify.readingLabel')}</span>
              </div>
            ) : box.ocr_status === 'failed' ? (
              <div>
                <div className="flex items-center gap-1.5">
                  <AlertCircle className="w-3.5 h-3.5 text-danger shrink-0" />
                  <span className="text-xs text-danger">{tr('ocr.failed')}</span>
                </div>
                <div className="flex flex-wrap gap-1.5 mt-1.5">
                  {box.image_data && (
                    <button
                      onClick={(e) => { e.stopPropagation(); setViewingImage(box.image_data!); }}
                      className="text-[11px] px-2 py-0.5 bg-sunken hover:bg-hover text-ink-body rounded font-medium"
                    >
                      {tr('palletVerify.viewWithIcon')}
                    </button>
                  )}
                  <button
                    onClick={(e) => { e.stopPropagation(); retryPalletOcr(box.barcode); }}
                    className="text-[11px] px-2 py-0.5 bg-brand-weak hover:opacity-90 text-brand-weak-ink rounded font-medium"
                  >
                    {tr('palletVerify.retryWithIcon')}
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); rescanPalletBox(box.barcode); }}
                    className="text-[11px] px-2 py-0.5 bg-orange-100 hover:bg-orange-200 text-orange-700 rounded font-medium"
                  >
                    {tr('palletVerify.rescanWithIcon')}
                  </button>
                </div>
              </div>
            ) : (
              <>
                {displayName && (
                  <p className="font-semibold text-ink truncate">{displayName}</p>
                )}
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="font-bold text-ink">
                    {box.weight > 0 ? `${box.weight.toFixed(3)} kg` : '—'}
                  </span>
                  {box.expiry && (
                    <span className="text-xs text-ink-muted" dir="ltr">exp {box.expiry}</span>
                  )}
                </div>
                {box.needs_review && (
                  <p className="flex items-center gap-1 text-[11px] text-warn-weak-ink mt-1 font-medium">
                    <AlertTriangle className="w-3 h-3 shrink-0" /> {tr('palletVerify.needsReview')} · {tr('palletVerify.tapToFix')}
                  </p>
                )}
              </>
            )}
          </div>

          <div className="shrink-0">
            {idx === 0 ? (
              <span className="text-xs bg-brand-weak text-brand-weak-ink rounded px-1.5 py-0.5">#1</span>
            ) : detectedType !== 'mix' && !sameItem ? (
              <XCircle className="text-warn w-4 h-4" />
            ) : (
              <CheckCircle className="text-ok w-4 h-4" />
            )}
          </div>
        </div>

        {selected && box.ocr_status !== 'failed' && (
          <div className="mt-2 flex gap-2">
            <button
              onClick={(e) => { e.stopPropagation(); openEdit(box); }}
              className="flex items-center justify-center gap-1.5 flex-1 py-2 rounded-lg bg-brand text-ink-inverse text-xs font-semibold hover:bg-brand-hover active:bg-brand-active transition"
            >
              <Pencil className="w-3.5 h-3.5" /> {tr('palletVerify.editScan')}
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); rescanPalletBox(box.barcode); setSelectedBarcode(null); }}
              className="flex items-center justify-center gap-1.5 flex-1 py-2 rounded-lg bg-danger text-ink-inverse text-xs font-semibold hover:opacity-90 active:opacity-80 transition"
            >
              <Trash2 className="w-3.5 h-3.5" /> {tr('palletVerify.deleteScan')}
            </button>
          </div>
        )}
      </div>
    );
  }

  // ── Screens ──

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

  if (phase === 'all_done') {
    const looseCount = session?.loose_box_count || 0;
    const completed = session?.completed_pallets || [];
    return (
      <div className="min-h-screen p-6 bg-ok-weak">
        <div className="max-w-md mx-auto">
          <div className="text-center">
            <CheckCircle className="text-ok w-16 h-16 mx-auto mb-4" />
            <h1 className="text-2xl font-bold text-ok-weak-ink mb-2">
              {looseCount > 0
                ? tr('palletVerify.allDoneTitleWithLoose', { count: pallet_count, looseCount })
                : tr('palletVerify.allDoneTitleSimple', { count: pallet_count })}
            </h1>
            <p className="text-sm text-ink-muted mb-6">
              {tr('pallet.stickers.tapHint')}
            </p>
          </div>

          {completed.length > 0 && (
            <div className="space-y-2 mb-6">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-muted px-1">
                {tr('pallet.stickers.title')}
              </h2>
              {completed.map((p) => {
                const typeLabel =
                  p.pallet_type === 'mix'
                    ? tr('palletVerify.palletTypeMix')
                    : tr('palletVerify.palletTypeSingle');
                const langSuffix = language === 'Hebrew' ? '&lang=Hebrew' : '';
                return (
                  <a
                    key={p.lpn}
                    href={`/pallet/${encodeURIComponent(p.lpn)}?token=${encodeURIComponent(token)}${langSuffix}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block bg-raised border border-line rounded-xl p-3 hover:border-green-400 hover:shadow-sm transition"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="font-mono text-sm font-semibold text-ink truncate" dir="ltr">
                          {p.lpn}
                        </div>
                        <div className="text-xs text-ink-muted mt-0.5">
                          {tr('palletVerify.palletEntry', {
                            n: p.pallet_number,
                            count: p.box_count,
                            type: typeLabel,
                          })}
                        </div>
                      </div>
                      <span className="inline-flex items-center gap-1 text-ok-weak-ink text-sm font-semibold shrink-0">
                        <Printer className="w-4 h-4" /> {tr('palletVerify.printSticker')}
                      </span>
                    </div>
                  </a>
                );
              })}
            </div>
          )}

          {looseCount > 0 && (
            <div className="bg-orange-50 border border-orange-200 rounded-xl p-3 text-sm text-orange-800 mb-6">
              {tr('palletVerify.looseBoxesNote', { count: looseCount })}
            </div>
          )}

          <p className="text-xs text-ink-muted text-center">
            {tr('palletVerify.expiryNote')}
          </p>
        </div>
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
    // Loose boxes: group by OCR'd name, same as the pallet path. Barcode is
    // dedup-only and never used as a grouping key.
    const looseGroupedMap = groupBoxesByName(looseBoxes);
    const looseGroupedItems: Record<string, BoxScan[]> = {};
    for (const [k, v] of looseGroupedMap.entries()) looseGroupedItems[k] = v;

    return (
      <div className="min-h-screen flex flex-col bg-canvas">
        {/* Header */}
        <div className="bg-raised border-b px-4 py-3 shadow-sm">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Package className="text-orange-500 w-5 h-5" />
              <div>
                <p className="text-sm font-bold text-ink">
                  {tr('palletVerify.looseHeader', { scanned, declared })}
                </p>
                <p className="text-xs text-ink-muted" dir="ltr">{tr('palletVerify.docPrefix', { doc: session?.document_number || '—' })}</p>
              </div>
            </div>
            <SettingsPopover />
          </div>
          <div className="mt-2">
            <div className="h-2 bg-sunken rounded-full overflow-hidden">
              <div
                className={`h-full transition-all rounded-full ${declared > 0 && scanned >= declared ? 'bg-ok' : 'bg-orange-400'}`}
                style={{ width: `${declared > 0 ? Math.min((scanned / declared) * 100, 100) : 0}%` }}
              />
            </div>
          </div>
        </div>

        {/* Scanner — explicit key forces a fresh mount so the internal
            scanContinuously() closure picks up handleLooseBarcodeDetected
            instead of the stale pallet-phase handler. */}
        <div className="relative">
          <SmartScanner
            key="loose-scanner"
            onBarcodeDetected={handleLooseBarcodeDetected}
            onManualCapture={handleLooseManualCapture}
            onDuplicateFlash={(fn) => { looseDupFlashRef.current = fn; }}
            scannedBarcodes={new Map()}
            ocrResults={new Map()}
          />
          {phase === 'loose_confirming' && (
            <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
              <div className="bg-raised rounded-xl px-4 py-3 flex items-center gap-2">
                <Loader2 className="animate-spin w-5 h-5 text-orange-500" />
                <span className="text-sm font-medium">{tr('palletVerify.savingLoose')}</span>
              </div>
            </div>
          )}
        </div>

        {/* Scanned loose boxes */}
        {looseBoxes.length > 0 && (
          <div className="px-4 py-3 flex-1 overflow-y-auto space-y-2">
            {Object.entries(looseGroupedItems).map(([nameKey, boxes]) => {
              const displayName =
                boxes.find((b) => b.item_name_hebrew)?.item_name_hebrew ||
                boxes.find((b) => b.item_name)?.item_name ||
                nameKey.replace(/^(he|en|unknown):/, '');
              const doneWeights = boxes.filter((b) => b.weight > 0).map((b) => b.weight);
              const totalWeight = doneWeights.reduce((s, w) => s + w, 0);
              return (
                <div key={nameKey} className="bg-orange-50 border border-orange-200 rounded-xl p-3">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm font-semibold text-orange-900 truncate max-w-[70%]">
                      {displayName}
                    </span>
                    <span className="text-xs bg-orange-200 text-orange-800 rounded-full px-2 py-0.5 font-semibold">
                      {tr('palletVerify.boxesUnit', { count: boxes.length })}
                    </span>
                  </div>
                  {totalWeight > 0 && (
                    <p className="text-xs text-ink-muted mb-1">{tr('palletVerify.totalWeightLine', { weight: totalWeight.toFixed(3) })}</p>
                  )}
                  <div className="space-y-1">
                    {boxes.map((box, bi) => {
                      // Tap a loose-box row to reveal its Delete action (two-step).
                      // Exception: a needs_review row opens the edit modal —
                      // the worker has to fix it before loose-phase Confirm
                      // unlocks. openEdit is called with isLoose=true so the
                      // save patches looseBoxes (not scannedBoxes).
                      const selected = selectedBarcode === box.barcode;
                      const needsReviewRow = !!box.needs_review;
                      return (
                      <div
                        key={box.barcode + bi}
                        onClick={() =>
                          needsReviewRow
                            ? openEdit(box, true)
                            : setSelectedBarcode(selected ? null : box.barcode)
                        }
                        className={`text-xs text-ink-body flex items-center gap-1.5 flex-wrap cursor-pointer rounded px-1 ${
                          needsReviewRow
                            ? 'bg-warn-weak ring-1 ring-amber-300 py-1'
                            : selected
                            ? 'bg-danger-weak ring-1 ring-red-200'
                            : ''
                        }`}
                      >
                        {box.ocr_status === 'processing' ? (
                          <>
                            <Loader2 className="w-3 h-3 animate-spin text-orange-400 shrink-0" />
                            <span className="text-orange-500">{tr('palletVerify.reading')}</span>
                          </>
                        ) : box.ocr_status === 'done' ? (
                          <>
                            <CheckCircle className={`w-3 h-3 shrink-0 ${needsReviewRow ? 'text-amber-500' : 'text-ok'}`} />
                            <span>{box.weight > 0 ? `${box.weight.toFixed(3)} kg` : '—'}</span>
                            {box.expiry && <span className="text-ink-muted" dir="ltr">· {box.expiry}</span>}
                            {needsReviewRow && (
                              <span className="inline-flex items-center gap-1 text-warn-weak-ink font-medium">
                                <AlertTriangle className="w-3 h-3 shrink-0" /> {tr('palletVerify.tapToFix')}
                              </span>
                            )}
                            {selected && !needsReviewRow && (
                              <span className="ms-auto flex gap-1">
                                <button
                                  onClick={(e) => { e.stopPropagation(); openEdit(box, true); }}
                                  className="px-1.5 py-0.5 bg-brand text-ink-inverse rounded text-[10px] font-semibold hover:bg-brand-hover"
                                >
                                  {tr('palletVerify.editScan')}
                                </button>
                                <button
                                  onClick={(e) => { e.stopPropagation(); rescanLooseBox(box.barcode); setSelectedBarcode(null); }}
                                  className="px-1.5 py-0.5 bg-danger text-ink-inverse rounded text-[10px] font-semibold hover:opacity-90"
                                >
                                  {tr('palletVerify.deleteScan')}
                                </button>
                              </span>
                            )}
                          </>
                        ) : (
                          <>
                            <AlertCircle className="w-3 h-3 text-danger shrink-0" />
                            <span className="text-ink-muted">{tr('ocr.failed')}</span>
                            <div className="flex gap-1 ms-auto">
                              {box.image_data && (
                                <button
                                  onClick={(e) => { e.stopPropagation(); setViewingImage(box.image_data!); }}
                                  className="px-1.5 py-0.5 bg-sunken hover:bg-hover text-ink-body rounded text-[10px] font-medium"
                                >
                                  {tr('ocr.view')}
                                </button>
                              )}
                              <button
                                onClick={(e) => { e.stopPropagation(); retryLooseOcr(box.barcode); }}
                                className="px-1.5 py-0.5 bg-brand-weak hover:opacity-90 text-brand-weak-ink rounded text-[10px] font-medium"
                              >
                                {tr('ocr.retry')}
                              </button>
                              <button
                                onClick={(e) => { e.stopPropagation(); rescanLooseBox(box.barcode); }}
                                className="px-1.5 py-0.5 bg-orange-100 hover:bg-orange-200 text-orange-700 rounded text-[10px] font-medium"
                              >
                                {tr('ocr.rescan')}
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Footer */}
        <div className="p-4 bg-raised border-t sticky bottom-0">
          {error && <p className="text-danger-weak-ink text-sm text-center mb-2">{error}</p>}
          <button
            onClick={handleConfirmLooseBoxes}
            disabled={!canConfirmLoose || phase === 'loose_confirming'}
            className={`w-full py-3 rounded-xl font-semibold text-base transition ${
              canConfirmLoose && phase !== 'loose_confirming'
                ? 'bg-orange-500 text-ink-inverse hover:bg-orange-600 active:bg-orange-700'
                : 'bg-sunken text-ink-muted cursor-not-allowed'
            }`}
          >
            {canConfirmLoose
              ? tr('palletVerify.confirmLooseBtn', { count: scanned })
              : hasUnresolvedLooseWarnings
              ? tr('palletVerify.warningsBlockConfirm', { count: unresolvedLooseWarnings })
              : declared > 0
              ? tr('palletVerify.scanMoreLoose', { count: Math.max(0, declared - scanned) })
              : tr('palletVerify.scanAtLeast2')}
          </button>
          {hasUnresolvedLooseWarnings && (
            <p className="flex items-center justify-center gap-1 text-[11px] text-warn-weak-ink text-center mt-1.5">
              <AlertTriangle className="w-3 h-3 shrink-0" /> {tr('palletVerify.warningsBlockConfirm', { count: unresolvedLooseWarnings })}
            </p>
          )}
        </div>
        {imageModal}
        {editModal}
        {debugPanel}
      </div>
    );
  }

  if (phase === 'pallet_done') {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-6 bg-ok-weak text-center">
        <CheckCircle className="text-ok w-14 h-14 mb-4" />
        <h1 className="text-xl font-bold text-ok-weak-ink mb-1">
          {tr('palletVerify.palletDoneTitle', { current: currentPallet, total: pallet_count })}
        </h1>
        <p className="text-ink-body mb-1">
          <span className="font-mono font-bold" dir="ltr">{tr('palletVerify.lpnLabel', { lpn })}</span>
        </p>
        {lpnUrl && (
          <a
            href={`${lpnUrl}?token=${encodeURIComponent(token)}${language === 'Hebrew' ? '&lang=Hebrew' : ''}`}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-flex items-center gap-1.5 bg-ok text-ink-inverse px-5 py-2 rounded-xl text-sm font-semibold hover:opacity-90 transition"
          >
            <Printer className="w-4 h-4" /> {tr('palletVerify.viewPrintSticker')}
          </a>
        )}
        <div className="mt-6 flex items-center gap-2 text-ink-muted text-sm">
          <Loader2 className="animate-spin w-4 h-4" />
          <span>{tr('palletVerify.movingNext', { next: currentPallet + 1 })}</span>
        </div>
        {debugPanel}
      </div>
    );
  }

  // ── Scanning / confirming ──

  return (
    <div className="min-h-screen flex flex-col bg-canvas">
      {/* Header */}
      <div className="bg-raised border-b px-4 py-3 shadow-sm">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Package className="text-brand w-5 h-5" />
            <div>
              <p className="text-sm font-bold text-ink">
                {confirmedBoxCount > 0
                  ? tr('palletVerify.palletHeaderWithCount', { current: currentPallet, total: pallet_count, count: confirmedBoxCount })
                  : tr('palletVerify.palletHeaderShort', { current: currentPallet, total: pallet_count })}
              </p>
              <p className="text-xs text-ink-muted" dir="ltr">{tr('palletVerify.docPrefix', { doc: session?.document_number || '—' })}</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <TypeBadge />
            <SettingsPopover />
          </div>
        </div>

        <div className="mt-2">
          <div className="flex justify-between text-xs text-ink-muted mb-1">
            <span>
              {confirmedBoxCount > 0
                ? tr('palletVerify.committed', { committed, total: confirmedBoxCount })
                : tr('palletVerify.scannedSoFar', { count: committed })}
            </span>
            <span className={canConfirm ? 'text-ok-weak-ink font-semibold' : 'text-ink-muted'}>
              {canConfirm
                ? tr('palletVerify.readyToConfirm')
                : pendingUniformPrompt
                ? tr('palletVerify.waitingInput')
                : confirmedBoxCount === 0
                ? (committed < 2
                    ? tr('palletVerify.scanToStart')
                    : tr('palletVerify.setTotalBelow'))
                : tr('palletVerify.moreBoxesToGo', { count: Math.max(0, confirmedBoxCount - committed) })}
            </span>
          </div>
          <div className="h-2 bg-sunken rounded-full overflow-hidden">
            <div
              className={`h-full transition-all rounded-full ${canConfirm ? 'bg-ok' : 'bg-brand'}`}
              style={{
                width: `${Math.min(
                  (committed / Math.max(confirmedBoxCount, 2)) * 100,
                  100
                )}%`,
              }}
            />
          </div>
        </div>

        {/* Uniform-group banner: shows locked groups + the currently-pending one. */}
        {(uniformGroups.size > 0 || pendingUniformPrompt) && (
          <div className="mt-2 bg-ok-weak border border-ok/30 rounded-lg px-3 py-2">
            <p className="flex items-center gap-1 text-[11px] font-semibold text-ok-weak-ink mb-1">
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
              {pendingUniformPrompt && (
                <li className="text-emerald-800">
                  {tr('palletVerify.uniformPendingItem', {
                    name:
                      pendingUniformPrompt.item_name_hebrew ||
                      pendingUniformPrompt.item_name ||
                      pendingUniformPrompt.name_key.replace(/^(he|en|unknown):/, ''),
                    weight: pendingUniformPrompt.avg_weight,
                  })}
                </li>
              )}
            </ul>
          </div>
        )}
      </div>

      {/* Scanner — keyed per pallet so each new pallet gets a fresh
          scanner instance (clears the internal cooldown/dedup refs). */}
      <div className="relative">
        <SmartScanner
          key={`pallet-scanner-${currentPallet}`}
          onBarcodeDetected={handleBarcodeDetected}
          onManualCapture={handleManualCapture}
          onDuplicateFlash={(fn) => { dupFlashRef.current = fn; }}
          scannedBarcodes={new Map()}
          ocrResults={new Map()}
        />
        {phase === 'confirming' && (
          <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
            <div className="bg-raised rounded-xl px-4 py-3 flex items-center gap-2">
              <Loader2 className="animate-spin w-5 h-5 text-brand" />
              <span className="text-sm font-medium">{tr('palletVerify.savingPallet')}</span>
            </div>
          </div>
        )}
      </div>

      {/* AI consolidation banner — appears when /api/consolidate-items
          suggests two of the on-pallet groups are actually the same
          product (OCR drift). Worker confirms or dismisses. */}
      {pendingMerge && (
        <div className="mx-4 mt-3 bg-warn-weak border border-warn/30 rounded-xl p-3 shadow-sm">
          <p className="flex items-center gap-1 text-xs font-semibold text-warn-weak-ink mb-1">
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
                  <span className="text-warn-weak-ink">×{count}</span>
                </li>
              );
            })}
          </ul>
          <div className="flex gap-2">
            <button
              onClick={handleAcceptMerge}
              className="flex items-center justify-center gap-1.5 flex-1 min-w-0 py-2 rounded-lg bg-warn text-ink-inverse text-xs font-semibold hover:opacity-90 active:opacity-80 transition"
            >
              <Check className="w-3.5 h-3.5" /> {tr('palletVerify.aiMergeAccept')}
            </button>
            <button
              onClick={handleRejectMerge}
              className="shrink-0 px-4 py-2 rounded-lg bg-raised border-2 border-warn/30 text-warn-weak-ink text-xs font-semibold hover:bg-warn-weak transition"
            >
              {tr('palletVerify.aiMergeReject')}
            </button>
          </div>
        </div>
      )}

      {/* Scanned boxes */}
      {scannedBoxes.length > 0 && (
        <div className="px-4 py-3 flex-1 overflow-y-auto">
          {detectedType === 'mix' ? (
            <div className="space-y-2">
              {Object.entries(groupedItems).map(([nameKey, boxes]) => {
                const displayName =
                  boxes.find((b) => b.item_name_hebrew)?.item_name_hebrew ||
                  boxes.find((b) => b.item_name)?.item_name ||
                  // Stripping the `he:` / `en:` prefix here is purely cosmetic
                  // — the prefix is helpful for debugging the React key but
                  // would look noisy in the UI.
                  nameKey.replace(/^(he|en|unknown):/, '');
                const doneWeights = boxes.filter((b) => b.weight > 0).map((b) => b.weight);
                const avgWeight =
                  doneWeights.length > 0
                    ? doneWeights.reduce((s, w) => s + w, 0) / doneWeights.length
                    : 0;

                return (
                  <div key={nameKey} className="bg-brand-weak border border-brand/30 rounded-xl p-3">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm font-semibold text-brand-weak-ink truncate max-w-[70%]">
                        {displayName}
                      </span>
                      <span className="text-xs bg-brand-weak text-brand-weak-ink rounded-full px-2 py-0.5 font-semibold">
                        {tr('palletVerify.boxesUnit', { count: boxes.length })}
                      </span>
                    </div>
                    {avgWeight > 0 && (
                      <p className="text-xs text-ink-muted mb-1">{tr('palletVerify.avgWeightLine', { weight: avgWeight.toFixed(3) })}</p>
                    )}
                    <div className="space-y-1">
                      {boxes.map((box, bi) => {
                        // Tap a box row to reveal its Delete action (two-step).
                        const selected = selectedBarcode === box.barcode;
                        return (
                        <div
                          key={box.barcode + bi}
                          onClick={() => setSelectedBarcode(selected ? null : box.barcode)}
                          className={`text-xs text-ink-body flex items-center gap-1.5 flex-wrap cursor-pointer rounded px-1 ${selected ? 'bg-danger-weak ring-1 ring-red-200' : ''}`}
                        >
                          {box.ocr_status === 'processing' ? (
                            <>
                              <Loader2 className="w-3 h-3 animate-spin text-brand shrink-0" />
                              <span className="text-brand">{tr('palletVerify.reading')}</span>
                            </>
                          ) : box.ocr_status === 'done' ? (
                            <>
                              <CheckCircle className="w-3 h-3 text-ok shrink-0" />
                              <span>{box.weight > 0 ? `${box.weight.toFixed(3)} kg` : '—'}</span>
                              {box.expiry && <span className="text-ink-muted" dir="ltr">· {box.expiry}</span>}
                              {selected && (
                                <span className="ms-auto flex gap-1">
                                  <button
                                    onClick={(e) => { e.stopPropagation(); openEdit(box); }}
                                    className="px-1.5 py-0.5 bg-brand text-ink-inverse rounded text-[10px] font-semibold hover:bg-brand-hover"
                                  >
                                    {tr('palletVerify.editScan')}
                                  </button>
                                  <button
                                    onClick={(e) => { e.stopPropagation(); rescanPalletBox(box.barcode); setSelectedBarcode(null); }}
                                    className="px-1.5 py-0.5 bg-danger text-ink-inverse rounded text-[10px] font-semibold hover:opacity-90"
                                  >
                                    {tr('palletVerify.deleteScan')}
                                  </button>
                                </span>
                              )}
                            </>
                          ) : (
                            <>
                              <AlertCircle className="w-3 h-3 text-danger shrink-0" />
                              <span className="text-ink-muted">{tr('ocr.failed')}</span>
                              <div className="flex gap-1 ms-auto">
                                {box.image_data && (
                                  <button
                                    onClick={(e) => { e.stopPropagation(); setViewingImage(box.image_data!); }}
                                    className="px-1.5 py-0.5 bg-sunken hover:bg-hover text-ink-body rounded text-[10px] font-medium"
                                  >
                                    {tr('ocr.view')}
                                  </button>
                                )}
                                <button
                                  onClick={(e) => { e.stopPropagation(); retryPalletOcr(box.barcode); }}
                                  className="px-1.5 py-0.5 bg-brand-weak hover:opacity-90 text-brand-weak-ink rounded text-[10px] font-medium"
                                >
                                  {tr('ocr.retry')}
                                </button>
                                <button
                                  onClick={(e) => { e.stopPropagation(); rescanPalletBox(box.barcode); }}
                                  className="px-1.5 py-0.5 bg-orange-100 hover:bg-orange-200 text-orange-700 rounded text-[10px] font-medium"
                                >
                                  {tr('ocr.rescan')}
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
              <p className="text-xs text-ink-muted text-center mt-1">
                {tr('palletVerify.itemTypesDetected', { count: Object.keys(groupedItems).length })}
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {scannedBoxes.map((box, idx) => (
                <BoxCard key={box.barcode + idx} box={box} idx={idx} />
              ))}
            </div>
          )}

          {canConfirm && (
            <p className="text-xs text-ink-muted text-center mt-3">
              {tr('palletVerify.confirmOrKeep')}
            </p>
          )}
        </div>
      )}

      {/* Footer — priority-ordered modes:
          (1) single_or_mix uniform prompt (Complete / Continue),
          (2) mandatory_count per-SKU prompt (number input + Set) —
              ONLY once the pallet total is known (confirmedBoxCount > 0),
              because its overflow validation caps the per-SKU count at
              (pallet total − boxes already committed). With no total set
              the cap would be 0 and the worker could never submit, so we
              fall through to mode (3) first to capture the pallet total,
              then this prompt re-appears with a meaningful cap.
          (3) deferred pallet box-count input (surfaces after 2
              OCR-completed scans when no count has been set yet, OR
              after the worker picks "Single-item" in mode 1, OR while a
              mandatory_count prompt is pending but the total is still 0),
          (4) standard Confirm Pallet button.                         */}
      <div className="p-4 bg-raised border-t sticky bottom-0">
        {error && <p className="text-danger-weak-ink text-sm text-center mb-2">{error}</p>}

        {pendingUniformPrompt?.mode === 'single_or_mix' ? (
          <div className="space-y-2">
            <p className="text-xs text-ink-body text-center mb-1">
              {tr('palletVerify.uniformChoose')}
            </p>
            <button
              onClick={handleCompleteAsSingle}
              disabled={phase === 'confirming'}
              className="flex items-center justify-center gap-1.5 w-full py-3 rounded-xl font-semibold text-base bg-ok text-ink-inverse hover:opacity-90 active:bg-ok transition disabled:bg-sunken disabled:text-ink-muted"
            >
              <CheckCircle className="w-4 h-4" /> {tr('palletVerify.uniformCompleteBtn')}
            </button>
            <button
              onClick={handleContinueAsMix}
              disabled={phase === 'confirming'}
              className="flex items-center justify-center gap-1.5 w-full py-3 rounded-xl font-semibold text-base bg-raised border-2 border-brand text-brand-weak-ink hover:bg-brand-weak transition"
            >
              <Plus className="w-4 h-4" /> {tr('palletVerify.uniformContinueMix')}
            </button>
            <button
              onClick={handleScanEachIndividually}
              disabled={phase === 'confirming'}
              className="w-full text-xs text-ink-muted hover:text-ink-body underline pt-1"
            >
              {tr('palletVerify.uniformScanEach')}
            </button>
          </div>
        ) : (pendingUniformPrompt?.mode === 'mandatory_count' && confirmedBoxCount > 0) ? (
          <div className="space-y-2">
            <label className="block text-xs text-ink-body font-medium">
              {tr('palletVerify.uniformHowMany', {
                item:
                  pendingUniformPrompt.item_name_hebrew ||
                  pendingUniformPrompt.item_name ||
                  pendingUniformPrompt.name_key.replace(/^(he|en|unknown):/, ''),
              })}
            </label>
            <p className="text-[11px] text-ink-muted">
              {tr('palletVerify.uniformMaxNote', {
                max: Math.max(0, confirmedBoxCount - committedExcludingPending()),
                weight: pendingUniformPrompt.avg_weight,
              })}
            </p>
            {/* min-w-0 on the input + shrink-0 on the button keeps the
                button inside the viewport. Without min-w-0 the input's
                intrinsic placeholder width forces the row wider than the
                screen and the Set button slides off the (RTL) left edge. */}
            <div className="flex gap-2">
              <input
                type="number"
                inputMode="numeric"
                min={1}
                value={countInput}
                onChange={(e) => {
                  setCountInput(e.target.value);
                  setCountError(null);
                }}
                onKeyDown={(e) => e.key === 'Enter' && handleSetUniformCount()}
                placeholder={tr('palletVerify.uniformPlaceholder')}
                className="flex-1 min-w-0 text-center text-xl font-bold text-ink bg-raised border-2 border-gray-400 rounded-xl py-2 px-3 shadow-sm transition outline-none focus:border-blue-600 focus:ring-4 focus:ring-blue-200 placeholder:text-ink-muted placeholder:font-medium placeholder:text-base"
                autoFocus
              />
              <button
                onClick={handleSetUniformCount}
                className="shrink-0 px-5 py-2 rounded-xl bg-brand text-ink-inverse font-semibold text-sm hover:bg-brand-hover transition"
              >
                {tr('palletVerify.uniformSet')}
              </button>
            </div>
            {countError && (
              <p className="text-danger-weak-ink text-xs">{countError}</p>
            )}
            <button
              onClick={handleScanEachIndividually}
              className="w-full text-xs text-ink-muted hover:text-ink-body underline pt-1"
            >
              {tr('palletVerify.uniformScanEach')}
            </button>
          </div>
        ) : (confirmedBoxCount === 0 && scannedBoxes.length >= 2) ? (
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
                className="flex-1 min-w-0 text-center text-xl font-bold text-ink bg-raised border-2 border-gray-400 rounded-xl py-2 px-3 shadow-sm transition outline-none focus:border-blue-600 focus:ring-4 focus:ring-blue-200 placeholder:text-ink-muted placeholder:font-medium placeholder:text-base"
                autoFocus
              />
              <button
                onClick={handlePalletCountSubmit}
                className="shrink-0 px-5 py-2 rounded-xl bg-brand text-ink-inverse font-semibold text-sm hover:bg-brand-hover transition"
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
                className="w-full text-xs text-ink-muted hover:text-ink-body underline pt-1"
              >
                {tr('palletVerify.cancelSingle')}
              </button>
            )}
          </div>
        ) : (
          <>
            <button
              onClick={handleConfirmPallet}
              disabled={!canConfirm || phase === 'confirming'}
              className={`w-full py-3 rounded-xl font-semibold text-base transition ${
                canConfirm && phase !== 'confirming'
                  ? 'bg-ok text-ink-inverse hover:opacity-90 active:bg-ok'
                  : 'bg-sunken text-ink-muted cursor-not-allowed'
              }`}
            >
              {canConfirm
                ? tr('palletVerify.confirmPalletBtn', { current: currentPallet })
                : hasUnresolvedWarnings
                ? tr('palletVerify.warningsBlockConfirm', { count: unresolvedWarnings })
                : committed < 2
                ? tr('palletVerify.scanMoreToContinue', { count: 2 - committed })
                : tr('palletVerify.boxesNeeded', { count: Math.max(0, confirmedBoxCount - committed) })}
            </button>
            {hasUnresolvedWarnings && (
              <p className="flex items-center justify-center gap-1 text-[11px] text-warn-weak-ink text-center mt-1.5">
                <AlertTriangle className="w-3 h-3 shrink-0" /> {tr('palletVerify.warningsBlockConfirm', { count: unresolvedWarnings })}
              </p>
            )}
          </>
        )}
      </div>
      {imageModal}
      {editModal}
      {debugPanel}
    </div>
  );
}
