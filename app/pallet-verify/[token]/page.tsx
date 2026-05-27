'use client';

import { use, useCallback, useEffect, useRef, useState } from 'react';
import {
  CheckCircle,
  XCircle,
  Loader2,
  Package,
  AlertCircle,
} from 'lucide-react';
import { SmartScanner } from '@/components/scanner/SmartScanner';
import { DebugLogPanel } from '@/components/shared/DebugLogPanel';
import { installDebugLogCapture } from '@/lib/debug-log';
import { LanguageContext, useLangDir, t } from '@/lib/i18n';
import type { Language, MultiPalletSession, MultiPalletBoxScan, ParsedBarcode } from '@/types';
import { groupKeyForBox, groupBoxesByName } from '@/lib/group-key';

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
      if (processedRef.current.has(barcode)) return;
      processedRef.current.add(barcode);

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

  // ── Retry / Rescan helpers (pallet phase) ──

  function retryPalletOcr(barcode: string) {
    setScannedBoxes((prev) => {
      const target = prev.find((b) => b.barcode === barcode);
      if (!target?.image_data) return prev;
      // Schedule the OCR call after this state update commits.
      const img = target.image_data;
      setTimeout(() => runOcr(barcode, img, 0), 0);
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

  function runOcr(barcode: string, imageData: string, capturedIndex: number) {
    fetch('/api/multi-pallet-ocr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: imageData, barcode }),
    })
      .then((r) => r.json())
      .then((data) => {
        setScannedBoxes((prev) => {
          // find the box by barcode (index may shift if state batched)
          const idx = prev.findIndex((b) => b.barcode === barcode);
          if (idx === -1) return prev;
          const updated = prev.map((b, i) => {
            if (i !== idx) return b;
            if (data.success && data.ocr_data) {
              return {
                ...b,
                ocr_status: 'done' as OcrStatus,
                item_name: data.ocr_data.product_name_english || '',
                item_name_hebrew: data.ocr_data.product_name_hebrew || '',
                weight: data.ocr_data.weight_kg ?? 0,
                expiry: data.ocr_data.expiry_date || '',
              };
            }
            return { ...b, ocr_status: 'failed' as OcrStatus };
          });
          setDetectedType(detectType(updated, acceptedMerges));
          // Check if the box that just finished OCR triggers a uniform-pair prompt.
          maybeTriggerUniformPrompt(updated, barcode);
          return updated;
        });
      })
      .catch(() => {
        setScannedBoxes((prev) => {
          const idx = prev.findIndex((b) => b.barcode === barcode);
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
      if (looseProcessedRef.current.has(barcode)) return;
      looseProcessedRef.current.add(barcode);
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

  // ── Retry / Rescan helpers (loose phase) ──

  function retryLooseOcr(barcode: string) {
    setLooseBoxes((prev) => {
      const target = prev.find((b) => b.barcode === barcode);
      if (!target?.image_data) return prev;
      const img = target.image_data;
      setTimeout(() => runLooseOcr(barcode, img), 0);
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

  // Sum of boxes already committed to the pallet from non-uniform scans
  // (excluding the sample barcodes of the currently-pending uniform prompt).
  function committedExcludingPending(): number {
    const pendingSampleSet = new Set(pendingUniformPrompt?.sample_barcodes ?? []);
    let nonUniformIndividuals = 0;
    for (const box of scannedBoxes) {
      const k = acceptedMerges.get(groupKeyForBox(box)) ?? groupKeyForBox(box);
      if (uniformGroups.has(k)) continue;                   // already in a locked group
      if (pendingSampleSet.has(box.barcode)) continue;      // pending; we'll add total_count instead
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
      className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4"
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
        className="absolute top-4 right-4 bg-white text-gray-900 px-4 py-2 rounded-lg font-semibold text-sm shadow-lg"
      >
        {tr('palletVerify.closeButton')}
      </button>
      <p className="absolute bottom-4 left-1/2 -translate-x-1/2 text-white text-xs opacity-70 whitespace-nowrap">
        {tr('pallet.tapOutsideToClose')}
      </p>
    </div>
  ) : null;

  function runLooseOcr(barcode: string, imageData: string) {
    fetch('/api/multi-pallet-ocr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: imageData, barcode }),
    })
      .then((r) => r.json())
      .then((data) => {
        setLooseBoxes((prev) => {
          const idx = prev.findIndex((b) => b.barcode === barcode);
          if (idx === -1) return prev;
          return prev.map((b, i) => {
            if (i !== idx) return b;
            if (data.success && data.ocr_data) {
              return {
                ...b,
                ocr_status: 'done' as OcrStatus,
                item_name: data.ocr_data.product_name_english || '',
                item_name_hebrew: data.ocr_data.product_name_hebrew || '',
                weight: data.ocr_data.weight_kg ?? 0,
                expiry: data.ocr_data.expiry_date || '',
              };
            }
            return { ...b, ocr_status: 'failed' as OcrStatus };
          });
        });
      })
      .catch(() => {
        setLooseBoxes((prev) => {
          const idx = prev.findIndex((b) => b.barcode === barcode);
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
  //    matches the declared box count for this pallet (with a 2-box minimum).
  const committed = committedCount();
  const canConfirm = !pendingUniformPrompt && committed >= Math.max(2, confirmedBoxCount);

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
      return <span className="text-xs text-gray-400">{tr('palletVerify.scan2Detect')}</span>;
    if (detectedType === 'single-uniform')
      return (
        <span className="text-xs bg-green-100 text-green-700 rounded-full px-2 py-0.5 font-medium">
          {tr('palletVerify.singleUniformBadge')}
        </span>
      );
    if (detectedType === 'single-nonuniform')
      return (
        <span className="text-xs bg-yellow-100 text-yellow-700 rounded-full px-2 py-0.5 font-medium">
          {tr('palletVerify.singleNonuniformBadge')}
        </span>
      );
    return (
      <span className="text-xs bg-blue-100 text-blue-700 rounded-full px-2 py-0.5 font-medium">
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
        ? 'bg-blue-50 border-blue-200'
        : detectedType === 'mix' || sameItem
        ? 'bg-green-50 border-green-200'
        : 'bg-yellow-50 border-yellow-200';

    // Tap the card to reveal a Delete action (two-step, to avoid misclicks).
    const selected = selectedBarcode === box.barcode;
    return (
      <div
        onClick={() => setSelectedBarcode(selected ? null : box.barcode)}
        className={`rounded-xl p-3 border text-sm cursor-pointer ${cardBg} ${selected ? 'ring-2 ring-red-300' : ''}`}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            {box.ocr_status === 'processing' ? (
              <div className="flex items-center gap-1.5 text-blue-600">
                <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                <span className="text-xs">{tr('palletVerify.readingLabel')}</span>
              </div>
            ) : box.ocr_status === 'failed' ? (
              <div>
                <div className="flex items-center gap-1.5">
                  <AlertCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />
                  <span className="text-xs text-red-500">{tr('ocr.failed')}</span>
                </div>
                <div className="flex flex-wrap gap-1.5 mt-1.5">
                  {box.image_data && (
                    <button
                      onClick={(e) => { e.stopPropagation(); setViewingImage(box.image_data!); }}
                      className="text-[11px] px-2 py-0.5 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded font-medium"
                    >
                      {tr('palletVerify.viewWithIcon')}
                    </button>
                  )}
                  <button
                    onClick={(e) => { e.stopPropagation(); retryPalletOcr(box.barcode); }}
                    className="text-[11px] px-2 py-0.5 bg-blue-100 hover:bg-blue-200 text-blue-700 rounded font-medium"
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
                  <p className="font-semibold text-gray-900 truncate">{displayName}</p>
                )}
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="font-bold text-gray-800">
                    {box.weight > 0 ? `${box.weight.toFixed(3)} kg` : '—'}
                  </span>
                  {box.expiry && (
                    <span className="text-xs text-gray-400" dir="ltr">exp {box.expiry}</span>
                  )}
                </div>
              </>
            )}
          </div>

          <div className="shrink-0">
            {idx === 0 ? (
              <span className="text-xs bg-blue-200 text-blue-800 rounded px-1.5 py-0.5">#1</span>
            ) : detectedType !== 'mix' && !sameItem ? (
              <XCircle className="text-yellow-500 w-4 h-4" />
            ) : (
              <CheckCircle className="text-green-500 w-4 h-4" />
            )}
          </div>
        </div>

        {selected && box.ocr_status !== 'failed' && (
          <button
            onClick={(e) => { e.stopPropagation(); rescanPalletBox(box.barcode); setSelectedBarcode(null); }}
            className="mt-2 w-full py-2 rounded-lg bg-red-600 text-white text-xs font-semibold hover:bg-red-700 active:bg-red-800 transition"
          >
            {tr('palletVerify.deleteScan')}
          </button>
        )}
      </div>
    );
  }

  // ── Screens ──

  if (phase === 'error') {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-6 bg-gray-50">
        <XCircle className="text-red-500 w-12 h-12 mb-4" />
        <p className="text-lg font-semibold text-red-700 text-center">{error}</p>
        {debugPanel}
      </div>
    );
  }

  if (phase === 'loading') {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-6 bg-gray-50">
        <Loader2 className="animate-spin text-blue-500 w-10 h-10 mb-4" />
        <p className="text-gray-600">{tr('palletVerify.loadingSession')}</p>
        {debugPanel}
      </div>
    );
  }

  if (phase === 'all_done') {
    const looseCount = session?.loose_box_count || 0;
    const completed = session?.completed_pallets || [];
    return (
      <div className="min-h-screen p-6 bg-green-50">
        <div className="max-w-md mx-auto">
          <div className="text-center">
            <CheckCircle className="text-green-500 w-16 h-16 mx-auto mb-4" />
            <h1 className="text-2xl font-bold text-green-700 mb-2">
              {looseCount > 0
                ? tr('palletVerify.allDoneTitleWithLoose', { count: pallet_count, looseCount })
                : tr('palletVerify.allDoneTitleSimple', { count: pallet_count })}
            </h1>
            <p className="text-sm text-gray-500 mb-6">
              {tr('pallet.stickers.tapHint')}
            </p>
          </div>

          {completed.length > 0 && (
            <div className="space-y-2 mb-6">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-500 px-1">
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
                    className="block bg-white border border-gray-200 rounded-xl p-3 hover:border-green-400 hover:shadow-sm transition"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="font-mono text-sm font-semibold text-gray-900 truncate" dir="ltr">
                          {p.lpn}
                        </div>
                        <div className="text-xs text-gray-500 mt-0.5">
                          {tr('palletVerify.palletEntry', {
                            n: p.pallet_number,
                            count: p.box_count,
                            type: typeLabel,
                          })}
                        </div>
                      </div>
                      <span className="text-green-600 text-sm font-semibold shrink-0">
                        {tr('palletVerify.printSticker')}
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

          <p className="text-xs text-gray-400 text-center">
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
    const canConfirmLoose = scanned >= Math.min(2, declared) && (declared === 0 || scanned >= declared);
    // Loose boxes: group by OCR'd name, same as the pallet path. Barcode is
    // dedup-only and never used as a grouping key.
    const looseGroupedMap = groupBoxesByName(looseBoxes);
    const looseGroupedItems: Record<string, BoxScan[]> = {};
    for (const [k, v] of looseGroupedMap.entries()) looseGroupedItems[k] = v;

    return (
      <div className="min-h-screen flex flex-col bg-gray-50">
        {/* Header */}
        <div className="bg-white border-b px-4 py-3 shadow-sm">
          <div className="flex items-center gap-2">
            <Package className="text-orange-500 w-5 h-5" />
            <div>
              <p className="text-sm font-bold text-gray-800">
                {tr('palletVerify.looseHeader', { scanned, declared })}
              </p>
              <p className="text-xs text-gray-500" dir="ltr">{tr('palletVerify.docPrefix', { doc: session?.document_number || '—' })}</p>
            </div>
          </div>
          <div className="mt-2">
            <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
              <div
                className={`h-full transition-all rounded-full ${declared > 0 && scanned >= declared ? 'bg-green-500' : 'bg-orange-400'}`}
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
            scannedBarcodes={new Map()}
            ocrResults={new Map()}
          />
          {phase === 'loose_confirming' && (
            <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
              <div className="bg-white rounded-xl px-4 py-3 flex items-center gap-2">
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
                    <p className="text-xs text-gray-500 mb-1">{tr('palletVerify.totalWeightLine', { weight: totalWeight.toFixed(3) })}</p>
                  )}
                  <div className="space-y-1">
                    {boxes.map((box, bi) => {
                      // Tap a loose-box row to reveal its Delete action (two-step).
                      const selected = selectedBarcode === box.barcode;
                      return (
                      <div
                        key={box.barcode + bi}
                        onClick={() => setSelectedBarcode(selected ? null : box.barcode)}
                        className={`text-xs text-gray-600 flex items-center gap-1.5 flex-wrap cursor-pointer rounded px-1 ${selected ? 'bg-red-50 ring-1 ring-red-200' : ''}`}
                      >
                        {box.ocr_status === 'processing' ? (
                          <>
                            <Loader2 className="w-3 h-3 animate-spin text-orange-400 shrink-0" />
                            <span className="text-orange-500">{tr('palletVerify.reading')}</span>
                          </>
                        ) : box.ocr_status === 'done' ? (
                          <>
                            <CheckCircle className="w-3 h-3 text-green-500 shrink-0" />
                            <span>{box.weight > 0 ? `${box.weight.toFixed(3)} kg` : '—'}</span>
                            {box.expiry && <span className="text-gray-400" dir="ltr">· {box.expiry}</span>}
                            {selected && (
                              <button
                                onClick={(e) => { e.stopPropagation(); rescanLooseBox(box.barcode); setSelectedBarcode(null); }}
                                className="ms-auto px-1.5 py-0.5 bg-red-600 text-white rounded text-[10px] font-semibold hover:bg-red-700"
                              >
                                {tr('palletVerify.deleteScan')}
                              </button>
                            )}
                          </>
                        ) : (
                          <>
                            <AlertCircle className="w-3 h-3 text-red-300 shrink-0" />
                            <span className="text-gray-400">{tr('ocr.failed')}</span>
                            <div className="flex gap-1 ms-auto">
                              {box.image_data && (
                                <button
                                  onClick={(e) => { e.stopPropagation(); setViewingImage(box.image_data!); }}
                                  className="px-1.5 py-0.5 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded text-[10px] font-medium"
                                >
                                  {tr('ocr.view')}
                                </button>
                              )}
                              <button
                                onClick={(e) => { e.stopPropagation(); retryLooseOcr(box.barcode); }}
                                className="px-1.5 py-0.5 bg-blue-100 hover:bg-blue-200 text-blue-700 rounded text-[10px] font-medium"
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
        <div className="p-4 bg-white border-t sticky bottom-0">
          {error && <p className="text-red-600 text-sm text-center mb-2">{error}</p>}
          <button
            onClick={handleConfirmLooseBoxes}
            disabled={!canConfirmLoose || phase === 'loose_confirming'}
            className={`w-full py-3 rounded-xl font-semibold text-base transition ${
              canConfirmLoose && phase !== 'loose_confirming'
                ? 'bg-orange-500 text-white hover:bg-orange-600 active:bg-orange-700'
                : 'bg-gray-200 text-gray-400 cursor-not-allowed'
            }`}
          >
            {canConfirmLoose
              ? tr('palletVerify.confirmLooseBtn', { count: scanned })
              : declared > 0
              ? tr('palletVerify.scanMoreLoose', { count: Math.max(0, declared - scanned) })
              : tr('palletVerify.scanAtLeast2')}
          </button>
        </div>
        {imageModal}
        {debugPanel}
      </div>
    );
  }

  if (phase === 'pallet_done') {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-6 bg-green-50 text-center">
        <CheckCircle className="text-green-500 w-14 h-14 mb-4" />
        <h1 className="text-xl font-bold text-green-700 mb-1">
          {tr('palletVerify.palletDoneTitle', { current: currentPallet, total: pallet_count })}
        </h1>
        <p className="text-gray-700 mb-1">
          <span className="font-mono font-bold" dir="ltr">{tr('palletVerify.lpnLabel', { lpn })}</span>
        </p>
        {lpnUrl && (
          <a
            href={`${lpnUrl}?token=${encodeURIComponent(token)}${language === 'Hebrew' ? '&lang=Hebrew' : ''}`}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-block bg-green-600 text-white px-5 py-2 rounded-xl text-sm font-semibold hover:bg-green-700 transition"
          >
            {tr('palletVerify.viewPrintSticker')}
          </a>
        )}
        <div className="mt-6 flex items-center gap-2 text-gray-500 text-sm">
          <Loader2 className="animate-spin w-4 h-4" />
          <span>{tr('palletVerify.movingNext', { next: currentPallet + 1 })}</span>
        </div>
        {debugPanel}
      </div>
    );
  }

  // ── Scanning / confirming ──

  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b px-4 py-3 shadow-sm">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Package className="text-blue-600 w-5 h-5" />
            <div>
              <p className="text-sm font-bold text-gray-800">
                {confirmedBoxCount > 0
                  ? tr('palletVerify.palletHeaderWithCount', { current: currentPallet, total: pallet_count, count: confirmedBoxCount })
                  : tr('palletVerify.palletHeaderShort', { current: currentPallet, total: pallet_count })}
              </p>
              <p className="text-xs text-gray-500" dir="ltr">{tr('palletVerify.docPrefix', { doc: session?.document_number || '—' })}</p>
            </div>
          </div>
          <TypeBadge />
        </div>

        <div className="mt-2">
          <div className="flex justify-between text-xs text-gray-500 mb-1">
            <span>
              {confirmedBoxCount > 0
                ? tr('palletVerify.committed', { committed, total: confirmedBoxCount })
                : tr('palletVerify.scannedSoFar', { count: committed })}
            </span>
            <span className={canConfirm ? 'text-green-600 font-semibold' : 'text-gray-400'}>
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
          <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
            <div
              className={`h-full transition-all rounded-full ${canConfirm ? 'bg-green-500' : 'bg-blue-400'}`}
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
          <div className="mt-2 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
            <p className="text-[11px] font-semibold text-emerald-700 mb-1">
              {tr('palletVerify.uniformItemsHeader')}
            </p>
            <ul className="text-xs text-emerald-900 space-y-0.5">
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
          scannedBarcodes={new Map()}
          ocrResults={new Map()}
        />
        {phase === 'confirming' && (
          <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
            <div className="bg-white rounded-xl px-4 py-3 flex items-center gap-2">
              <Loader2 className="animate-spin w-5 h-5 text-blue-500" />
              <span className="text-sm font-medium">{tr('palletVerify.savingPallet')}</span>
            </div>
          </div>
        )}
      </div>

      {/* AI consolidation banner — appears when /api/consolidate-items
          suggests two of the on-pallet groups are actually the same
          product (OCR drift). Worker confirms or dismisses. */}
      {pendingMerge && (
        <div className="mx-4 mt-3 bg-amber-50 border border-amber-300 rounded-xl p-3 shadow-sm">
          <p className="text-xs font-semibold text-amber-900 mb-1">
            {tr('palletVerify.aiMergeBanner')}
          </p>
          <ul className="text-xs text-amber-900 mb-2 space-y-0.5">
            {pendingMerge.sample_names.map((nm, i) => {
              const fallbackKey = pendingMerge.from_keys[i]?.replace(/^(he|en|unknown):/, '') ?? '';
              const display = nm.he || nm.en || fallbackKey;
              const count = pendingMerge.box_counts[i] ?? 0;
              return (
                <li key={pendingMerge.from_keys[i] ?? i} className="flex items-baseline gap-1">
                  <span className="font-semibold">{display}</span>
                  <span className="text-amber-700">×{count}</span>
                </li>
              );
            })}
          </ul>
          <div className="flex gap-2">
            <button
              onClick={handleAcceptMerge}
              className="flex-1 min-w-0 py-2 rounded-lg bg-amber-600 text-white text-xs font-semibold hover:bg-amber-700 active:bg-amber-800 transition"
            >
              {tr('palletVerify.aiMergeAccept')}
            </button>
            <button
              onClick={handleRejectMerge}
              className="shrink-0 px-4 py-2 rounded-lg bg-white border-2 border-amber-300 text-amber-800 text-xs font-semibold hover:bg-amber-100 transition"
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
                  <div key={nameKey} className="bg-blue-50 border border-blue-200 rounded-xl p-3">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm font-semibold text-blue-900 truncate max-w-[70%]">
                        {displayName}
                      </span>
                      <span className="text-xs bg-blue-200 text-blue-800 rounded-full px-2 py-0.5 font-semibold">
                        {tr('palletVerify.boxesUnit', { count: boxes.length })}
                      </span>
                    </div>
                    {avgWeight > 0 && (
                      <p className="text-xs text-gray-500 mb-1">{tr('palletVerify.avgWeightLine', { weight: avgWeight.toFixed(3) })}</p>
                    )}
                    <div className="space-y-1">
                      {boxes.map((box, bi) => {
                        // Tap a box row to reveal its Delete action (two-step).
                        const selected = selectedBarcode === box.barcode;
                        return (
                        <div
                          key={box.barcode + bi}
                          onClick={() => setSelectedBarcode(selected ? null : box.barcode)}
                          className={`text-xs text-gray-600 flex items-center gap-1.5 flex-wrap cursor-pointer rounded px-1 ${selected ? 'bg-red-50 ring-1 ring-red-200' : ''}`}
                        >
                          {box.ocr_status === 'processing' ? (
                            <>
                              <Loader2 className="w-3 h-3 animate-spin text-blue-400 shrink-0" />
                              <span className="text-blue-500">{tr('palletVerify.reading')}</span>
                            </>
                          ) : box.ocr_status === 'done' ? (
                            <>
                              <CheckCircle className="w-3 h-3 text-green-500 shrink-0" />
                              <span>{box.weight > 0 ? `${box.weight.toFixed(3)} kg` : '—'}</span>
                              {box.expiry && <span className="text-gray-400" dir="ltr">· {box.expiry}</span>}
                              {selected && (
                                <button
                                  onClick={(e) => { e.stopPropagation(); rescanPalletBox(box.barcode); setSelectedBarcode(null); }}
                                  className="ms-auto px-1.5 py-0.5 bg-red-600 text-white rounded text-[10px] font-semibold hover:bg-red-700"
                                >
                                  {tr('palletVerify.deleteScan')}
                                </button>
                              )}
                            </>
                          ) : (
                            <>
                              <AlertCircle className="w-3 h-3 text-red-300 shrink-0" />
                              <span className="text-gray-400">{tr('ocr.failed')}</span>
                              <div className="flex gap-1 ms-auto">
                                {box.image_data && (
                                  <button
                                    onClick={(e) => { e.stopPropagation(); setViewingImage(box.image_data!); }}
                                    className="px-1.5 py-0.5 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded text-[10px] font-medium"
                                  >
                                    {tr('ocr.view')}
                                  </button>
                                )}
                                <button
                                  onClick={(e) => { e.stopPropagation(); retryPalletOcr(box.barcode); }}
                                  className="px-1.5 py-0.5 bg-blue-100 hover:bg-blue-200 text-blue-700 rounded text-[10px] font-medium"
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
              <p className="text-xs text-gray-400 text-center mt-1">
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
            <p className="text-xs text-gray-400 text-center mt-3">
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
      <div className="p-4 bg-white border-t sticky bottom-0">
        {error && <p className="text-red-600 text-sm text-center mb-2">{error}</p>}

        {pendingUniformPrompt?.mode === 'single_or_mix' ? (
          <div className="space-y-2">
            <p className="text-xs text-gray-600 text-center mb-1">
              {tr('palletVerify.uniformChoose')}
            </p>
            <button
              onClick={handleCompleteAsSingle}
              disabled={phase === 'confirming'}
              className="w-full py-3 rounded-xl font-semibold text-base bg-green-600 text-white hover:bg-green-700 active:bg-green-800 transition disabled:bg-gray-200 disabled:text-gray-400"
            >
              {tr('palletVerify.uniformCompleteBtn')}
            </button>
            <button
              onClick={handleContinueAsMix}
              disabled={phase === 'confirming'}
              className="w-full py-3 rounded-xl font-semibold text-base bg-white border-2 border-blue-500 text-blue-700 hover:bg-blue-50 transition"
            >
              {tr('palletVerify.uniformContinueMix')}
            </button>
            <button
              onClick={handleScanEachIndividually}
              disabled={phase === 'confirming'}
              className="w-full text-xs text-gray-500 hover:text-gray-700 underline pt-1"
            >
              {tr('palletVerify.uniformScanEach')}
            </button>
          </div>
        ) : (pendingUniformPrompt?.mode === 'mandatory_count' && confirmedBoxCount > 0) ? (
          <div className="space-y-2">
            <label className="block text-xs text-gray-700 font-medium">
              {tr('palletVerify.uniformHowMany', {
                item:
                  pendingUniformPrompt.item_name_hebrew ||
                  pendingUniformPrompt.item_name ||
                  pendingUniformPrompt.name_key.replace(/^(he|en|unknown):/, ''),
              })}
            </label>
            <p className="text-[11px] text-gray-500">
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
                className="flex-1 min-w-0 text-center text-xl font-bold text-gray-900 bg-white border-2 border-gray-400 rounded-xl py-2 px-3 shadow-sm transition outline-none focus:border-blue-600 focus:ring-4 focus:ring-blue-200 placeholder:text-gray-400 placeholder:font-medium placeholder:text-base"
                autoFocus
              />
              <button
                onClick={handleSetUniformCount}
                className="shrink-0 px-5 py-2 rounded-xl bg-blue-600 text-white font-semibold text-sm hover:bg-blue-700 transition"
              >
                {tr('palletVerify.uniformSet')}
              </button>
            </div>
            {countError && (
              <p className="text-red-600 text-xs">{countError}</p>
            )}
            <button
              onClick={handleScanEachIndividually}
              className="w-full text-xs text-gray-500 hover:text-gray-700 underline pt-1"
            >
              {tr('palletVerify.uniformScanEach')}
            </button>
          </div>
        ) : (confirmedBoxCount === 0 && scannedBoxes.length >= 2) ? (
          <div className="space-y-2">
            <label className="block text-xs text-gray-700 font-medium">
              {tr('palletVerify.deferredCountTitle')}
            </label>
            <p className="text-[11px] text-gray-500">
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
                className="flex-1 min-w-0 text-center text-xl font-bold text-gray-900 bg-white border-2 border-gray-400 rounded-xl py-2 px-3 shadow-sm transition outline-none focus:border-blue-600 focus:ring-4 focus:ring-blue-200 placeholder:text-gray-400 placeholder:font-medium placeholder:text-base"
                autoFocus
              />
              <button
                onClick={handlePalletCountSubmit}
                className="shrink-0 px-5 py-2 rounded-xl bg-blue-600 text-white font-semibold text-sm hover:bg-blue-700 transition"
              >
                {tr('palletVerify.uniformSet')}
              </button>
            </div>
            {palletCountError && (
              <p className="text-red-600 text-xs">{palletCountError}</p>
            )}
            {pendingSingleGroup && (
              <button
                onClick={handleCancelSingleConfirm}
                className="w-full text-xs text-gray-500 hover:text-gray-700 underline pt-1"
              >
                {tr('palletVerify.cancelSingle')}
              </button>
            )}
          </div>
        ) : (
          <button
            onClick={handleConfirmPallet}
            disabled={!canConfirm || phase === 'confirming'}
            className={`w-full py-3 rounded-xl font-semibold text-base transition ${
              canConfirm && phase !== 'confirming'
                ? 'bg-green-600 text-white hover:bg-green-700 active:bg-green-800'
                : 'bg-gray-200 text-gray-400 cursor-not-allowed'
            }`}
          >
            {canConfirm
              ? tr('palletVerify.confirmPalletBtn', { current: currentPallet })
              : committed < 2
              ? tr('palletVerify.scanMoreToContinue', { count: 2 - committed })
              : tr('palletVerify.boxesNeeded', { count: Math.max(0, confirmedBoxCount - committed) })}
          </button>
        )}
      </div>
      {imageModal}
      {debugPanel}
    </div>
  );
}
