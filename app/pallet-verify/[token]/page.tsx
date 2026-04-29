'use client';

import { use, useCallback, useEffect, useRef, useState } from 'react';
import {
  CheckCircle,
  XCircle,
  Loader2,
  Package,
  ChevronRight,
  AlertCircle,
} from 'lucide-react';
import { SmartScanner } from '@/components/scanner/SmartScanner';
import type { MultiPalletSession, MultiPalletBoxScan, ParsedBarcode } from '@/types';

// ── Type detection using OCR-derived weights only ──

type DetectedType = 'unknown' | 'single-uniform' | 'single-nonuniform' | 'mix';

function detectType(boxes: BoxScan[]): DetectedType {
  if (boxes.length < 2) return 'unknown';
  const skus = new Set(boxes.map((b) => b.sku).filter(Boolean));
  if (skus.size > 1) return 'mix';
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
// When 2+ boxes of the SAME SKU come back from OCR with the SAME weight (within
// tolerance), the warehouse domain rule says ALL boxes of that SKU on this
// pallet are the same weight. The worker only physically scans 2 samples and
// reports the real total count via a prompt.

interface UniformGroup {
  sku: string;
  item_name: string;
  item_name_hebrew: string;
  avg_weight: number;
  total_count: number;          // user-entered (or declared count for Complete-as-single)
  sample_barcodes: string[];    // the scanned-sample barcodes (2+)
}

type UniformPrompt =
  // First uniform pair AND only one SKU has been scanned so far → ask the
  // worker whether this is single-item or actually mix.
  | { mode: 'single_or_mix'; sku: string; item_name: string; item_name_hebrew: string; avg_weight: number; sample_barcodes: string[] }
  // Any other case → mandatory: just need the count for this uniform sub-group.
  | { mode: 'mandatory_count'; sku: string; item_name: string; item_name_hebrew: string; avg_weight: number; sample_barcodes: string[] };

// Tolerance (kg) for "same weight" — matches detectType() and the outbound
// uniform-override threshold.
const UNIFORM_WEIGHT_TOLERANCE = 0.5;

// ── Page state machine ──

type Phase = 'loading' | 'box_count' | 'scanning' | 'confirming' | 'pallet_done' | 'loose_scanning' | 'loose_confirming' | 'all_done' | 'error';

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
  // Number-input state for the mandatory_count prompt + its validation error.
  const [countInput, setCountInput] = useState('');
  const [countError, setCountError] = useState<string | null>(null);

  // ── Load session ──

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(`/api/multi-pallet-session?token=${token}`);
        if (!res.ok) {
          setError('Session not found or expired. Ask the manager to resend the link.');
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
          setConfirmedBoxCount(data.current_box_count);
          setBoxCountInput(String(data.current_box_count));
          setPhase('scanning');
        } else {
          setPhase('box_count');
        }
      } catch {
        setError('Failed to load session.');
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
      setDetectedType(detectType(filtered));

      // If the rescanned box belonged to a locked uniform group and the group
      // would be left with fewer than 2 same-weight samples, drop the group
      // (the worker can re-scan and re-prompt).
      if (target?.sku) {
        setUniformGroups((groups) => {
          const g = groups.get(target.sku);
          if (!g) return groups;
          const remainingSamples = filtered.filter(
            (b) => b.sku === target.sku && b.ocr_status === 'done'
          );
          if (remainingSamples.length < 2) {
            const next = new Map(groups);
            next.delete(target.sku);
            return next;
          }
          return groups;
        });
        // Also clear a pending prompt that's about this same SKU.
        setPendingUniformPrompt((p) => (p && p.sku === target.sku ? null : p));
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
          setDetectedType(detectType(updated));
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
    if (!justFinished || justFinished.ocr_status !== 'done' || !justFinished.sku || justFinished.weight <= 0) return;
    const sku = justFinished.sku;
    if (uniformGroupsRef.current.has(sku)) return; // already locked

    const sameSkuDone = latestBoxes.filter(
      (b) => b.sku === sku && b.ocr_status === 'done' && b.weight > 0
    );
    if (sameSkuDone.length < 2) return;
    const ws = sameSkuDone.map((b) => b.weight);
    const span = Math.max(...ws) - Math.min(...ws);
    if (span >= UNIFORM_WEIGHT_TOLERANCE) return;

    const distinctSkus = new Set(latestBoxes.map((b) => b.sku).filter(Boolean));
    const mode: UniformPrompt['mode'] =
      distinctSkus.size === 1 && uniformGroupsRef.current.size === 0 ? 'single_or_mix' : 'mandatory_count';

    const avg = ws.reduce((a, b) => a + b, 0) / ws.length;
    setPendingUniformPrompt({
      mode,
      sku,
      item_name: justFinished.item_name || '',
      item_name_hebrew: justFinished.item_name_hebrew || '',
      avg_weight: Math.round(avg * 1000) / 1000,
      sample_barcodes: sameSkuDone.map((b) => b.barcode),
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

  // "Complete as single-item" path: lock the group at the declared box count
  // and immediately confirm the pallet (treating it as single-uniform).
  function handleCompleteAsSingle() {
    const p = pendingUniformPrompt;
    if (!p || p.mode !== 'single_or_mix') return;
    const group: UniformGroup = {
      sku: p.sku,
      item_name: p.item_name,
      item_name_hebrew: p.item_name_hebrew,
      avg_weight: p.avg_weight,
      total_count: confirmedBoxCount,
      sample_barcodes: p.sample_barcodes,
    };
    setUniformGroups((prev) => {
      const next = new Map(prev);
      next.set(p.sku, group);
      return next;
    });
    setPendingUniformPrompt(null);
    // Defer one tick so React commits the state updates before we hit the API.
    setTimeout(() => handleConfirmPallet(), 0);
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

  // Sum of boxes already committed to the pallet from non-uniform scans
  // (excluding the sample barcodes of the currently-pending uniform prompt).
  function committedExcludingPending(): number {
    const pendingSampleSet = new Set(pendingUniformPrompt?.sample_barcodes ?? []);
    let nonUniformIndividuals = 0;
    for (const box of scannedBoxes) {
      if (uniformGroups.has(box.sku)) continue;            // already in a locked group
      if (pendingSampleSet.has(box.barcode)) continue;     // pending; we'll add total_count instead
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
      setCountError('Enter a valid number ≥ 1.');
      return;
    }
    const remaining = confirmedBoxCount - committedExcludingPending();
    if (n > remaining) {
      setCountError(
        `Total would exceed declared ${confirmedBoxCount} boxes — max is ${Math.max(0, remaining)} for this item.`
      );
      return;
    }
    const group: UniformGroup = {
      sku: p.sku,
      item_name: p.item_name,
      item_name_hebrew: p.item_name_hebrew,
      avg_weight: p.avg_weight,
      total_count: n,
      sample_barcodes: p.sample_barcodes,
    };
    setUniformGroups((prev) => {
      const next = new Map(prev);
      next.set(p.sku, group);
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
      if (!uniformGroups.has(box.sku)) nonUniformIndividuals += 1;
    }
    let lockedTotal = 0;
    for (const g of uniformGroups.values()) lockedTotal += g.total_count;
    return nonUniformIndividuals + lockedTotal;
  }

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
        ✕ Close
      </button>
      <p className="absolute bottom-4 left-1/2 -translate-x-1/2 text-white text-xs opacity-70 whitespace-nowrap">
        Tap outside to close
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
        setError(data.error || 'Failed to complete loose boxes.');
        setPhase('loose_scanning');
        return;
      }
      setPhase('all_done');
    } catch {
      setError('Network error. Please try again.');
      setPhase('loose_scanning');
    }
  }

  // ── Box count submitted ──

  function handleBoxCountSubmit() {
    const count = parseInt(boxCountInput, 10);
    if (isNaN(count) || count < 1) {
      setError('Please enter a valid number of boxes (minimum 1).');
      return;
    }
    setError(null);
    setConfirmedBoxCount(count);
    setScannedBoxes([]);
    processedRef.current.clear();
    setDetectedType('unknown');
    setPhase('scanning');
    fetch('/api/multi-pallet-session', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, current_box_count: count }),
    }).catch(() => {});
  }

  // ── Confirm pallet ──

  async function handleConfirmPallet() {
    if (scannedBoxes.length < 2) return;
    setPhase('confirming');
    setError(null);

    // Build uniform_groups overrides from locked groups (and image_data is
    // intentionally stripped from scanned_boxes — the server doesn't need it).
    const uniformGroupsPayload = Array.from(uniformGroups.values()).map((g) => ({
      sku: g.sku,
      total_count: g.total_count,
      avg_weight: g.avg_weight,
    }));

    try {
      const res = await fetch('/api/multi-pallet-complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          scanned_boxes: scannedBoxes.map(({ ocr_status: _, image_data: _img, ...box }) => box),
          box_count: confirmedBoxCount,
          uniform_groups: uniformGroupsPayload,
        }),
      });
      const data = await res.json();

      if (!data.success) {
        setError(data.error || 'Failed to complete pallet.');
        setPhase('scanning');
        return;
      }

      setLpn(data.lpn || '');
      setLpnUrl(data.lpn_url || '');

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
          setCountInput('');
          setCountError(null);
          setPhase('box_count');
        }, 4000);
      }
    } catch {
      setError('Network error. Please try again.');
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

  const groupedBySku = scannedBoxes.reduce<Record<string, BoxScan[]>>((acc, box) => {
    const key = box.sku || 'unknown';
    if (!acc[key]) acc[key] = [];
    acc[key].push(box);
    return acc;
  }, {});

  // ── Type badge ──

  function TypeBadge() {
    if (detectedType === 'unknown')
      return <span className="text-xs text-gray-400">Scan 2+ boxes to detect type</span>;
    if (detectedType === 'single-uniform')
      return (
        <span className="text-xs bg-green-100 text-green-700 rounded-full px-2 py-0.5 font-medium">
          ✅ Single · uniform weight
        </span>
      );
    if (detectedType === 'single-nonuniform')
      return (
        <span className="text-xs bg-yellow-100 text-yellow-700 rounded-full px-2 py-0.5 font-medium">
          ⚖️ Single · scan all boxes
        </span>
      );
    return (
      <span className="text-xs bg-blue-100 text-blue-700 rounded-full px-2 py-0.5 font-medium">
        📦 Mix · scan all boxes
      </span>
    );
  }

  // ── Box card ──

  function BoxCard({ box, idx }: { box: BoxScan; idx: number }) {
    const firstSku = scannedBoxes[0]?.sku;
    const skuMatch = box.sku === firstSku;
    const displayName = box.item_name_hebrew || box.item_name;

    const cardBg =
      idx === 0
        ? 'bg-blue-50 border-blue-200'
        : detectedType === 'mix' || skuMatch
        ? 'bg-green-50 border-green-200'
        : 'bg-yellow-50 border-yellow-200';

    return (
      <div className={`rounded-xl p-3 border text-sm ${cardBg}`}>
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            {box.ocr_status === 'processing' ? (
              <div className="flex items-center gap-1.5 text-blue-600">
                <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                <span className="text-xs">Reading label…</span>
              </div>
            ) : box.ocr_status === 'failed' ? (
              <div>
                <div className="flex items-center gap-1.5">
                  <AlertCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />
                  <span className="text-xs text-red-500">OCR failed</span>
                </div>
                <div className="flex flex-wrap gap-1.5 mt-1.5">
                  {box.image_data && (
                    <button
                      onClick={() => setViewingImage(box.image_data!)}
                      className="text-[11px] px-2 py-0.5 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded font-medium"
                    >
                      🖼 View
                    </button>
                  )}
                  <button
                    onClick={() => retryPalletOcr(box.barcode)}
                    className="text-[11px] px-2 py-0.5 bg-blue-100 hover:bg-blue-200 text-blue-700 rounded font-medium"
                  >
                    ↻ Retry
                  </button>
                  <button
                    onClick={() => rescanPalletBox(box.barcode)}
                    className="text-[11px] px-2 py-0.5 bg-orange-100 hover:bg-orange-200 text-orange-700 rounded font-medium"
                  >
                    🔄 Rescan
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
                    <span className="text-xs text-gray-400">exp {box.expiry}</span>
                  )}
                </div>
              </>
            )}
          </div>

          <div className="shrink-0">
            {idx === 0 ? (
              <span className="text-xs bg-blue-200 text-blue-800 rounded px-1.5 py-0.5">#1</span>
            ) : detectedType !== 'mix' && !skuMatch ? (
              <XCircle className="text-yellow-500 w-4 h-4" />
            ) : (
              <CheckCircle className="text-green-500 w-4 h-4" />
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── Screens ──

  if (phase === 'error') {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-6 bg-gray-50">
        <XCircle className="text-red-500 w-12 h-12 mb-4" />
        <p className="text-lg font-semibold text-red-700 text-center">{error}</p>
      </div>
    );
  }

  if (phase === 'loading') {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-6 bg-gray-50">
        <Loader2 className="animate-spin text-blue-500 w-10 h-10 mb-4" />
        <p className="text-gray-600">Loading session…</p>
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
              All {pallet_count} pallet{pallet_count !== 1 ? 's' : ''}
              {looseCount > 0 ? ` + ${looseCount} loose box${looseCount !== 1 ? 'es' : ''}` : ''} complete!
            </h1>
            <p className="text-sm text-gray-500 mb-6">
              Tap a sticker below to view or print. Links also sent via WhatsApp.
            </p>
          </div>

          {completed.length > 0 && (
            <div className="space-y-2 mb-6">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-500 px-1">
                Pallet stickers
              </h2>
              {completed.map((p) => (
                <a
                  key={p.lpn}
                  href={`/pallet/${encodeURIComponent(p.lpn)}?token=${encodeURIComponent(token)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block bg-white border border-gray-200 rounded-xl p-3 hover:border-green-400 hover:shadow-sm transition"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="font-mono text-sm font-semibold text-gray-900 truncate">
                        {p.lpn}
                      </div>
                      <div className="text-xs text-gray-500 mt-0.5">
                        Pallet {p.pallet_number} · {p.box_count} box{p.box_count !== 1 ? 'es' : ''} · {p.pallet_type}
                      </div>
                    </div>
                    <span className="text-green-600 text-sm font-semibold shrink-0">
                      Print →
                    </span>
                  </div>
                </a>
              ))}
            </div>
          )}

          {looseCount > 0 && (
            <div className="bg-orange-50 border border-orange-200 rounded-xl p-3 text-sm text-orange-800 mb-6">
              📦 {looseCount} loose box{looseCount !== 1 ? 'es' : ''} recorded — no physical sticker (system-tracked only).
            </div>
          )}

          <p className="text-xs text-gray-400 text-center">
            This page stays available for ~2 hours. Individual sticker pages stay available indefinitely.
          </p>
        </div>
      </div>
    );
  }

  if (phase === 'loose_scanning' || phase === 'loose_confirming') {
    const declared = session?.loose_box_count || 0;
    const scanned = looseBoxes.length;
    const canConfirmLoose = scanned >= Math.min(2, declared) && (declared === 0 || scanned >= declared);
    const looseGroupedBySku = looseBoxes.reduce<Record<string, BoxScan[]>>((acc, box) => {
      const key = box.sku || 'unknown';
      if (!acc[key]) acc[key] = [];
      acc[key].push(box);
      return acc;
    }, {});

    return (
      <div className="min-h-screen flex flex-col bg-gray-50">
        {/* Header */}
        <div className="bg-white border-b px-4 py-3 shadow-sm">
          <div className="flex items-center gap-2">
            <Package className="text-orange-500 w-5 h-5" />
            <div>
              <p className="text-sm font-bold text-gray-800">
                Loose Boxes · {scanned} / {declared} scanned
              </p>
              <p className="text-xs text-gray-500">Doc: {session?.document_number || '—'}</p>
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
                <span className="text-sm font-medium">Saving loose boxes…</span>
              </div>
            </div>
          )}
        </div>

        {/* Scanned loose boxes */}
        {looseBoxes.length > 0 && (
          <div className="px-4 py-3 flex-1 overflow-y-auto space-y-2">
            {Object.entries(looseGroupedBySku).map(([sku, boxes]) => {
              const displayName =
                boxes.find((b) => b.item_name_hebrew)?.item_name_hebrew ||
                boxes.find((b) => b.item_name)?.item_name ||
                sku;
              const doneWeights = boxes.filter((b) => b.weight > 0).map((b) => b.weight);
              const totalWeight = doneWeights.reduce((s, w) => s + w, 0);
              return (
                <div key={sku} className="bg-orange-50 border border-orange-200 rounded-xl p-3">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm font-semibold text-orange-900 truncate max-w-[70%]">
                      {displayName}
                    </span>
                    <span className="text-xs bg-orange-200 text-orange-800 rounded-full px-2 py-0.5 font-semibold">
                      {boxes.length} box{boxes.length !== 1 ? 'es' : ''}
                    </span>
                  </div>
                  {totalWeight > 0 && (
                    <p className="text-xs text-gray-500 mb-1">{totalWeight.toFixed(3)} kg total</p>
                  )}
                  <div className="space-y-1">
                    {boxes.map((box, bi) => (
                      <div key={box.barcode + bi} className="text-xs text-gray-600 flex items-center gap-1.5 flex-wrap">
                        {box.ocr_status === 'processing' ? (
                          <>
                            <Loader2 className="w-3 h-3 animate-spin text-orange-400 shrink-0" />
                            <span className="text-orange-500">Reading…</span>
                          </>
                        ) : box.ocr_status === 'done' ? (
                          <>
                            <CheckCircle className="w-3 h-3 text-green-500 shrink-0" />
                            <span>{box.weight > 0 ? `${box.weight.toFixed(3)} kg` : '—'}</span>
                            {box.expiry && <span className="text-gray-400">· {box.expiry}</span>}
                          </>
                        ) : (
                          <>
                            <AlertCircle className="w-3 h-3 text-red-300 shrink-0" />
                            <span className="text-gray-400">OCR failed</span>
                            <div className="flex gap-1 ml-auto">
                              {box.image_data && (
                                <button
                                  onClick={() => setViewingImage(box.image_data!)}
                                  className="px-1.5 py-0.5 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded text-[10px] font-medium"
                                >
                                  View
                                </button>
                              )}
                              <button
                                onClick={() => retryLooseOcr(box.barcode)}
                                className="px-1.5 py-0.5 bg-blue-100 hover:bg-blue-200 text-blue-700 rounded text-[10px] font-medium"
                              >
                                Retry
                              </button>
                              <button
                                onClick={() => rescanLooseBox(box.barcode)}
                                className="px-1.5 py-0.5 bg-orange-100 hover:bg-orange-200 text-orange-700 rounded text-[10px] font-medium"
                              >
                                Rescan
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    ))}
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
              ? `✅ Confirm ${scanned} Loose Box${scanned !== 1 ? 'es' : ''}`
              : declared > 0
              ? `Scan ${Math.max(0, declared - scanned)} more box${declared - scanned === 1 ? '' : 'es'}`
              : `Scan at least 2 boxes`}
          </button>
        </div>
        {imageModal}
      </div>
    );
  }

  if (phase === 'pallet_done') {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-6 bg-green-50 text-center">
        <CheckCircle className="text-green-500 w-14 h-14 mb-4" />
        <h1 className="text-xl font-bold text-green-700 mb-1">
          Pallet {currentPallet}/{pallet_count} done!
        </h1>
        <p className="text-gray-700 mb-1">
          LPN: <span className="font-mono font-bold">{lpn}</span>
        </p>
        {lpnUrl && (
          <a
            href={`${lpnUrl}?token=${encodeURIComponent(token)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-block bg-green-600 text-white px-5 py-2 rounded-xl text-sm font-semibold hover:bg-green-700 transition"
          >
            View & Print Sticker →
          </a>
        )}
        <div className="mt-6 flex items-center gap-2 text-gray-500 text-sm">
          <Loader2 className="animate-spin w-4 h-4" />
          <span>Moving to pallet {currentPallet + 1}…</span>
        </div>
      </div>
    );
  }

  if (phase === 'box_count') {
    return (
      <div className="min-h-screen flex flex-col bg-gray-50">
        <div className="bg-white border-b px-4 py-3 shadow-sm">
          <div className="flex items-center gap-2">
            <Package className="text-blue-600 w-5 h-5" />
            <div>
              <p className="text-sm font-bold text-gray-800">
                Pallet {currentPallet} of {pallet_count}
              </p>
              <p className="text-xs text-gray-500">Doc: {session?.document_number || '—'}</p>
            </div>
          </div>
          <div className="flex gap-1 mt-2">
            {Array.from({ length: pallet_count }, (_, i) => (
              <div
                key={i}
                className={`h-1.5 flex-1 rounded-full ${
                  i + 1 < currentPallet
                    ? 'bg-green-500'
                    : i + 1 === currentPallet
                    ? 'bg-blue-500'
                    : 'bg-gray-200'
                }`}
              />
            ))}
          </div>
        </div>

        <div className="flex-1 flex flex-col items-center justify-center px-6">
          <div className="w-full max-w-sm">
            <h2 className="text-xl font-bold text-gray-800 text-center mb-2">
              📦 How many boxes?
            </h2>
            <p className="text-sm text-gray-500 text-center mb-6">
              Total boxes on pallet {currentPallet}.
            </p>
            <input
              type="number"
              inputMode="numeric"
              min="1"
              value={boxCountInput}
              onChange={(e) => setBoxCountInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleBoxCountSubmit()}
              placeholder="e.g. 10"
              className="w-full text-center text-3xl font-bold border-2 border-gray-300 rounded-xl py-4 px-4 focus:border-blue-500 focus:outline-none"
              autoFocus
            />
            {error && <p className="text-red-500 text-sm text-center mt-2">{error}</p>}
            <button
              onClick={handleBoxCountSubmit}
              className="w-full mt-4 py-3 rounded-xl bg-blue-600 text-white font-semibold text-base hover:bg-blue-700 transition flex items-center justify-center gap-2"
            >
              Start Scanning <ChevronRight className="w-5 h-5" />
            </button>
          </div>
        </div>
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
                Pallet {currentPallet}/{pallet_count} · {confirmedBoxCount} boxes
              </p>
              <p className="text-xs text-gray-500">Doc: {session?.document_number || '—'}</p>
            </div>
          </div>
          <TypeBadge />
        </div>

        <div className="mt-2">
          <div className="flex justify-between text-xs text-gray-500 mb-1">
            <span>
              {committed} / {confirmedBoxCount} committed
            </span>
            <span className={canConfirm ? 'text-green-600 font-semibold' : 'text-gray-400'}>
              {canConfirm
                ? '✅ Ready to confirm'
                : pendingUniformPrompt
                ? '⏳ Waiting for your input below'
                : `${Math.max(0, confirmedBoxCount - committed)} more box${
                    confirmedBoxCount - committed === 1 ? '' : 'es'
                  } to go`}
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
              🟢 Uniform items
            </p>
            <ul className="text-xs text-emerald-900 space-y-0.5">
              {Array.from(uniformGroups.values()).map((g) => {
                const name = g.item_name_hebrew || g.item_name || g.sku;
                return (
                  <li key={g.sku}>
                    ✓ {name} — <span className="font-semibold">{g.total_count}</span> boxes locked
                    <span className="text-emerald-600/70"> ({g.avg_weight} kg/box)</span>
                  </li>
                );
              })}
              {pendingUniformPrompt && (
                <li className="text-emerald-800">
                  ⏳ {pendingUniformPrompt.item_name_hebrew || pendingUniformPrompt.item_name || pendingUniformPrompt.sku}{' '}
                  — awaiting count below
                  <span className="text-emerald-600/70"> ({pendingUniformPrompt.avg_weight} kg/box)</span>
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
              <span className="text-sm font-medium">Saving pallet…</span>
            </div>
          </div>
        )}
      </div>

      {/* Scanned boxes */}
      {scannedBoxes.length > 0 && (
        <div className="px-4 py-3 flex-1 overflow-y-auto">
          {detectedType === 'mix' ? (
            <div className="space-y-2">
              {Object.entries(groupedBySku).map(([sku, boxes]) => {
                const displayName =
                  boxes.find((b) => b.item_name_hebrew)?.item_name_hebrew ||
                  boxes.find((b) => b.item_name)?.item_name ||
                  sku;
                const doneWeights = boxes.filter((b) => b.weight > 0).map((b) => b.weight);
                const avgWeight =
                  doneWeights.length > 0
                    ? doneWeights.reduce((s, w) => s + w, 0) / doneWeights.length
                    : 0;

                return (
                  <div key={sku} className="bg-blue-50 border border-blue-200 rounded-xl p-3">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm font-semibold text-blue-900 truncate max-w-[70%]">
                        {displayName}
                      </span>
                      <span className="text-xs bg-blue-200 text-blue-800 rounded-full px-2 py-0.5 font-semibold">
                        {boxes.length} box{boxes.length !== 1 ? 'es' : ''}
                      </span>
                    </div>
                    {avgWeight > 0 && (
                      <p className="text-xs text-gray-500 mb-1">avg {avgWeight.toFixed(3)} kg/box</p>
                    )}
                    <div className="space-y-1">
                      {boxes.map((box, bi) => (
                        <div key={box.barcode + bi} className="text-xs text-gray-600 flex items-center gap-1.5 flex-wrap">
                          {box.ocr_status === 'processing' ? (
                            <>
                              <Loader2 className="w-3 h-3 animate-spin text-blue-400 shrink-0" />
                              <span className="text-blue-500">Reading…</span>
                            </>
                          ) : box.ocr_status === 'done' ? (
                            <>
                              <CheckCircle className="w-3 h-3 text-green-500 shrink-0" />
                              <span>{box.weight > 0 ? `${box.weight.toFixed(3)} kg` : '—'}</span>
                              {box.expiry && <span className="text-gray-400">· {box.expiry}</span>}
                            </>
                          ) : (
                            <>
                              <AlertCircle className="w-3 h-3 text-red-300 shrink-0" />
                              <span className="text-gray-400">OCR failed</span>
                              <div className="flex gap-1 ml-auto">
                                {box.image_data && (
                                  <button
                                    onClick={() => setViewingImage(box.image_data!)}
                                    className="px-1.5 py-0.5 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded text-[10px] font-medium"
                                  >
                                    View
                                  </button>
                                )}
                                <button
                                  onClick={() => retryPalletOcr(box.barcode)}
                                  className="px-1.5 py-0.5 bg-blue-100 hover:bg-blue-200 text-blue-700 rounded text-[10px] font-medium"
                                >
                                  Retry
                                </button>
                                <button
                                  onClick={() => rescanPalletBox(box.barcode)}
                                  className="px-1.5 py-0.5 bg-orange-100 hover:bg-orange-200 text-orange-700 rounded text-[10px] font-medium"
                                >
                                  Rescan
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
              <p className="text-xs text-gray-400 text-center mt-1">
                {Object.keys(groupedBySku).length} item type
                {Object.keys(groupedBySku).length !== 1 ? 's' : ''} detected
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
              Confirm now or keep scanning to add more boxes
            </p>
          )}
        </div>
      )}

      {/* Footer — switches between three modes:
          (1) single_or_mix prompt (Complete / Continue),
          (2) mandatory_count prompt (number input + Set),
          (3) standard Confirm Pallet button.                         */}
      <div className="p-4 bg-white border-t sticky bottom-0">
        {error && <p className="text-red-600 text-sm text-center mb-2">{error}</p>}

        {pendingUniformPrompt?.mode === 'single_or_mix' ? (
          <div className="space-y-2">
            <p className="text-xs text-gray-600 text-center mb-1">
              Same item & weight detected — choose how to proceed:
            </p>
            <button
              onClick={handleCompleteAsSingle}
              disabled={phase === 'confirming'}
              className="w-full py-3 rounded-xl font-semibold text-base bg-green-600 text-white hover:bg-green-700 active:bg-green-800 transition disabled:bg-gray-200 disabled:text-gray-400"
            >
              ✅ Complete as single-item ({confirmedBoxCount} boxes)
            </button>
            <button
              onClick={handleContinueAsMix}
              disabled={phase === 'confirming'}
              className="w-full py-3 rounded-xl font-semibold text-base bg-white border-2 border-blue-500 text-blue-700 hover:bg-blue-50 transition"
            >
              ⏭ Continue scanning (this is a mix pallet)
            </button>
          </div>
        ) : pendingUniformPrompt?.mode === 'mandatory_count' ? (
          <div className="space-y-2">
            <label className="block text-xs text-gray-700 font-medium">
              How many boxes of{' '}
              <span className="font-semibold">
                {pendingUniformPrompt.item_name_hebrew || pendingUniformPrompt.item_name || pendingUniformPrompt.sku}
              </span>{' '}
              are on this pallet?
            </label>
            <p className="text-[11px] text-gray-500">
              Max {Math.max(0, confirmedBoxCount - committedExcludingPending())} (each box ≈ {pendingUniformPrompt.avg_weight} kg)
            </p>
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
                placeholder="Enter count"
                className="flex-1 text-center text-lg font-bold border-2 border-gray-300 rounded-xl py-2 px-3 focus:border-blue-500 focus:outline-none"
                autoFocus
              />
              <button
                onClick={handleSetUniformCount}
                className="px-5 py-2 rounded-xl bg-blue-600 text-white font-semibold text-sm hover:bg-blue-700 transition"
              >
                Set
              </button>
            </div>
            {countError && (
              <p className="text-red-600 text-xs">{countError}</p>
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
              ? `✅ Confirm Pallet ${currentPallet}`
              : committed < 2
              ? `Scan ${2 - committed} more box${2 - committed === 1 ? '' : 'es'} to continue`
              : `${Math.max(0, confirmedBoxCount - committed)} more box${
                  confirmedBoxCount - committed === 1 ? '' : 'es'
                } needed`}
          </button>
        )}
      </div>
      {imageModal}
    </div>
  );
}
