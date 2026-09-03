'use client';

import { useEffect, useState, useCallback, useRef, use } from 'react';
import { SmartScanner } from '@/components/scanner/SmartScanner';
import { BoxDetailModal } from '@/components/issue/BoxDetailModal';
import { IssuedBoxList } from '@/components/issue/IssuedBoxList';
import { AlertTriangle, CheckCircle } from 'lucide-react';
import type {
  Language,
  ParsedBarcode,
  BoxStickerOCR,
  ScanSession,
  BoxLookupResult,
  IssuedBox,
} from '@/types';
import { useLangDir, useT, LanguageContext, t } from '@/lib/i18n';
import { DesignHeader } from '@/components/terminal/DesignHeader';
import { ProgressHeader } from '@/components/terminal/ProgressHeader';
import { BottomSheet } from '@/components/terminal/BottomSheet';
import { ToolDock, type ToolChip } from '@/components/terminal/ToolDock';
import { PalletIcon } from '@/components/terminal/MI';
import { Toast, useLockToast } from '@/components/terminal/Toast';
import { useDrawerHost } from '@/components/terminal/DrawerHost';
import { PalletsBrowser } from '@/components/terminal/PalletsBrowser';
import { LabelsBrowser } from '@/components/terminal/LabelsBrowser';
import { useSettingsStore } from '@/stores/settings-store';
import { scanSuccessFeedback, scanDuplicateFeedback } from '@/lib/scan-feedback';

type IssuePhase =
  | 'loading'
  | 'scanning'
  | 'box_detail'
  | 'completing'
  | 'complete'
  | 'error';

export default function IssuePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);

  const [session, setSession] = useState<ScanSession | null>(null);
  const [phase, setPhase] = useState<IssuePhase>('loading');
  const language = (session?.language as Language) || 'English';
  useLangDir(language);
  const [error, setError] = useState<string | null>(null);

  // Scan tracking (needed for SmartScanner dedup)
  const [scannedBarcodes, setScannedBarcodes] = useState<Map<string, ParsedBarcode>>(new Map());
  const [ocrResults] = useState<Map<string, BoxStickerOCR>>(new Map());

  // Box detail state
  const [currentBox, setCurrentBox] = useState<BoxLookupResult['box'] | null>(null);
  const [isConfirming, setIsConfirming] = useState(false);

  // Issued boxes
  const [issuedBoxes, setIssuedBoxes] = useState<IssuedBox[]>([]);

  // Feedback
  const [flashColor, setFlashColor] = useState<'green' | 'red' | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Refs
  const lookupInProgress = useRef(false);

  // Hydrate Sound / Vibration settings from localStorage so scan-feedback
  // honours the worker's toggles (defaults to ON until hydrated).
  const hydrateSettings = useSettingsStore((s) => s.hydrate);
  useEffect(() => {
    hydrateSettings();
  }, [hydrateSettings]);

  // Audio + haptic feedback — delegated to the shared scan-feedback module so
  // this page cues identically to the other scanners and honours the same
  // Sound / Vibration toggles (both handle vibration internally).
  const playSuccessSound = useCallback(() => {
    scanSuccessFeedback();
  }, []);

  const playErrorSound = useCallback(() => {
    scanDuplicateFeedback();
  }, []);

  const showToast = useCallback((msg: string, type: 'success' | 'error') => {
    setToastMessage(msg);
    setFlashColor(type === 'success' ? 'green' : 'red');
    setTimeout(() => {
      setToastMessage(null);
      setFlashColor(null);
    }, 2500);
  }, []);

  // Load session
  useEffect(() => {
    async function loadSession() {
      try {
        const res = await fetch(`/api/session?token=${encodeURIComponent(token)}`);
        if (!res.ok) {
          setError(t(undefined, 'session.notFound'));
          setPhase('error');
          return;
        }
        const data: ScanSession = await res.json();

        if (data.operation_type !== 'ISSUE') {
          // Use the loaded session's language for the error if possible.
          setError(t(data.language as Language | undefined, 'session.notIssue'));
          setPhase('error');
          return;
        }

        if (data.status === 'COMPLETED') {
          setSession(data);
          setIssuedBoxes(data.issued_boxes || []);
          setPhase('complete');
          return;
        }

        setSession(data);
        setIssuedBoxes(data.issued_boxes || []);

        // Rebuild scannedBarcodes from previously issued boxes (for dedup in SmartScanner)
        const existingBarcodes = new Map<string, ParsedBarcode>();
        for (const box of data.issued_boxes || []) {
          existingBarcodes.set(box.barcode, {
            type: 'id-only',
            sku: box.sku,
            weight: 0,
            expiry: '',
            raw_barcode: box.barcode,
            expiry_source: 'ocr_required',
          });
        }
        setScannedBarcodes(existingBarcodes);
        setPhase('scanning');
      } catch (err) {
        console.error('Failed to load session:', err);
        setError(t(undefined, 'session.failedLoad'));
        setPhase('error');
      }
    }
    loadSession();
  }, [token]);

  // Handle barcode detected from scanner
  const handleBarcodeDetected = useCallback(
    async (barcode: string, _data: ParsedBarcode) => {
      if (phase !== 'scanning' || lookupInProgress.current) return;

      // Check local dedup
      if (scannedBarcodes.has(barcode)) {
        playErrorSound();
        showToast(t(language, 'issue.alreadyIssuedToast'), 'error');
        return;
      }

      lookupInProgress.current = true;

      try {
        const res = await fetch('/api/issue-lookup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, barcode }),
        });

        const result: BoxLookupResult = await res.json();

        if (!result.found || !result.box) {
          playErrorSound();

          if (result.error === 'not_found') {
            showToast(t(language, 'issue.boxNotFoundToast'), 'error');
          } else if (result.error === 'already_issued') {
            showToast(result.message || t(language, 'issue.boxAlreadyIssuedToast'), 'error');
          } else {
            showToast(result.message || t(language, 'issue.lookupFailedToast'), 'error');
          }
          return;
        }

        // Found and available - show detail modal
        playSuccessSound();
        setCurrentBox(result.box);
        setPhase('box_detail');
      } catch (err) {
        console.error('Lookup error:', err);
        playErrorSound();
        showToast(t(language, 'issue.lookupErrorToast'), 'error');
      } finally {
        lookupInProgress.current = false;
      }
    },
    [phase, scannedBarcodes, token, language, playSuccessSound, playErrorSound, showToast]
  );

  // Confirm issue
  const handleConfirmIssue = useCallback(async () => {
    if (!currentBox || isConfirming) return;

    setIsConfirming(true);

    try {
      const res = await fetch('/api/issue-confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          box_record_id: currentBox.record_id,
          batch_id: currentBox.batch_id,
          barcode: currentBox.barcode,
          weight: currentBox.weight,
          sku: currentBox.sku,
          item_name: currentBox.item_name,
          supplier: currentBox.supplier,
          invoice_number: currentBox.invoice_number,
          expiry: currentBox.expiry,
        }),
      });

      const result = await res.json();

      if (!result.success) {
        playErrorSound();
        showToast(result.error || t(language, 'issue.failedToIssue'), 'error');
        setIsConfirming(false);
        return;
      }

      // Add to issued list
      const newIssuedBox: IssuedBox = {
        barcode: currentBox.barcode,
        sku: currentBox.sku,
        item_name: currentBox.item_name,
        weight: currentBox.weight,
        expiry: currentBox.expiry,
        supplier: currentBox.supplier,
        invoice_number: currentBox.invoice_number,
        box_record_id: currentBox.record_id,
        batch_id: currentBox.batch_id,
        transaction_id: result.transaction_id,
        issued_at: new Date().toISOString(),
      };

      setIssuedBoxes((prev) => [...prev, newIssuedBox]);

      // Add to scannedBarcodes for dedup
      setScannedBarcodes((prev) => {
        const next = new Map(prev);
        next.set(currentBox.barcode, {
          type: 'id-only',
          sku: currentBox.sku,
          weight: 0,
          expiry: '',
          raw_barcode: currentBox.barcode,
          expiry_source: 'ocr_required',
        });
        return next;
      });

      playSuccessSound();
      showToast(
        t(language, 'issue.issuedToast', { item: currentBox.item_name, weight: currentBox.weight }),
        'success',
      );

      // Back to scanning
      setCurrentBox(null);
      setIsConfirming(false);
      setPhase('scanning');
    } catch (err) {
      console.error('Confirm error:', err);
      playErrorSound();
      showToast(t(language, 'issue.failedToIssue'), 'error');
      setIsConfirming(false);
    }
  }, [currentBox, isConfirming, token, language, playSuccessSound, playErrorSound, showToast]);

  // Cancel box detail
  const handleCancelDetail = useCallback(() => {
    setCurrentBox(null);
    setPhase('scanning');
  }, []);

  // Complete session
  const handleComplete = useCallback(async () => {
    if (issuedBoxes.length === 0) {
      showToast(t(language, 'issue.noBoxesYet'), 'error');
      return;
    }

    setPhase('completing');

    try {
      const res = await fetch('/api/issue-complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });

      const result = await res.json();

      if (!result.success) {
        showToast(result.error || t(language, 'issue.completeFailed'), 'error');
        setPhase('scanning');
        return;
      }

      setPhase('complete');
    } catch (err) {
      console.error('Complete error:', err);
      showToast(t(language, 'issue.completeFailedSession'), 'error');
      setPhase('scanning');
    }
  }, [issuedBoxes.length, token, language, showToast]);

  return (
    <LanguageContext.Provider value={language}>
      <IssueRender
        token={token}
        phase={phase}
        error={error}
        session={session}
        issuedBoxes={issuedBoxes}
        currentBox={currentBox}
        isConfirming={isConfirming}
        flashColor={flashColor}
        toastMessage={toastMessage}
        scannedBarcodes={scannedBarcodes}
        ocrResults={ocrResults}
        handleBarcodeDetected={handleBarcodeDetected}
        handleComplete={handleComplete}
        handleConfirmIssue={handleConfirmIssue}
        handleCancelDetail={handleCancelDetail}
      />
    </LanguageContext.Provider>
  );
}

interface IssueRenderProps {
  token: string;
  phase: IssuePhase;
  error: string | null;
  session: ScanSession | null;
  issuedBoxes: IssuedBox[];
  currentBox: BoxLookupResult['box'] | null;
  isConfirming: boolean;
  flashColor: 'green' | 'red' | null;
  toastMessage: string | null;
  scannedBarcodes: Map<string, ParsedBarcode>;
  ocrResults: Map<string, BoxStickerOCR>;
  handleBarcodeDetected: (barcode: string, data: ParsedBarcode) => Promise<void>;
  handleComplete: () => Promise<void>;
  handleConfirmIssue: () => Promise<void>;
  handleCancelDetail: () => void;
}

function IssueRender({
  token,
  phase,
  error,
  session,
  issuedBoxes,
  currentBox,
  isConfirming,
  flashColor,
  toastMessage,
  scannedBarcodes,
  ocrResults,
  handleBarcodeDetected,
  handleComplete,
  handleConfirmIssue,
  handleCancelDetail,
}: IssueRenderProps) {
  const tr = useT();
  // Terminal chrome — IssueRender lives under LanguageContext.Provider, so
  // the context-translating hooks resolve the session language correctly.
  const drawer = useDrawerHost(token);
  const { toast: infoToast, showToast: showInfoToast, showLockToast } = useLockToast();
  const [showPallets, setShowPallets] = useState(false);
  // מדבקות is reachable here so a worker can reprint a carton sticker mid-job.
  // צור קרטון stays locked on the ISSUE page: it labels goods being received
  // against an invoice line, which an outbound session has no business doing.
  const [showLabels, setShowLabels] = useState(false);

  // Loading
  if (phase === 'loading') {
    return (
      <div className="min-h-screen bg-canvas text-ink flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-brand mx-auto mb-4" />
          <p>{tr('issue.loadingSession')}</p>
        </div>
      </div>
    );
  }

  // Error
  if (phase === 'error') {
    return (
      <div className="min-h-screen bg-canvas text-ink flex items-center justify-center p-4">
        <div className="text-center">
          <AlertTriangle className="w-10 h-10 text-danger mx-auto mb-4" />
          <p className="mb-2 text-lg font-extrabold">{tr('session.errorTitle')}</p>
          <p className="text-ink-muted">{error}</p>
        </div>
      </div>
    );
  }

  // Complete
  if (phase === 'complete') {
    const totalWeight = issuedBoxes.reduce((s, b) => s + b.weight, 0);
    const summaryKey =
      issuedBoxes.length === 1 ? 'issue.completeSummarySingle' : 'issue.completeSummary';
    return (
      <div className="min-h-screen bg-canvas text-ink p-4">
        <div className="max-w-md mx-auto">
          <div className="text-center mb-8">
            <CheckCircle className="w-16 h-16 text-ok mx-auto mb-4 animate-donePop" />
            <h1 className="text-2xl font-extrabold mb-2">{tr('issue.completeTitle')}</h1>
            <p className="text-ink-muted">
              {tr(summaryKey, { count: issuedBoxes.length, weight: totalWeight.toFixed(2) })}
            </p>
          </div>

          <div className="bg-raised border border-line rounded-[14px] p-4 mb-6">
            <h2 className="text-lg font-extrabold mb-4">{tr('issue.summaryTitle')}</h2>
            <div className="space-y-2">
              {issuedBoxes.map((box, idx) => (
                <div
                  key={idx}
                  className="flex justify-between items-center border-b border-line pb-2 last:border-0"
                >
                  <span className="text-ink truncate me-2">{box.item_name}</span>
                  <span className="text-info-weak-ink font-mono font-bold whitespace-nowrap" dir="ltr">
                    {box.weight} kg
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-info-weak border border-info/30 rounded-[14px] p-4 mb-6">
            <p className="text-sm text-info-weak-ink">{tr('issue.doneNote')}</p>
          </div>

          <button
            onClick={() => window.close()}
            className="w-full h-12 bg-tile border border-line-strong text-ink rounded-xl font-bold hover:bg-hover transition-colors"
          >
            {tr('issue.closeButton')}
          </button>
        </div>
      </div>
    );
  }

  // Completing (spinner)
  if (phase === 'completing') {
    return (
      <div className="min-h-screen bg-canvas text-ink flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-info mx-auto mb-4" />
          <p>{tr('issue.completing')}</p>
        </div>
      </div>
    );
  }

  // Scanning / Box Detail — terminal main screen
  const shareIssued = async () => {
    const lines = issuedBoxes.map((b, i) => `${i + 1}. ${b.item_name} · ${b.weight} kg`);
    const text = [tr('issue.summaryTitle'), ...lines].join('\n');
    try {
      if (navigator.share) { await navigator.share({ text }); return; }
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
    }
    try {
      await navigator.clipboard.writeText(text);
      showInfoToast(tr('terminal.shareCopied'));
    } catch { /* no fallback left */ }
  };

  const issueDockChips: ToolChip[] = [
    { id: 'create', icon: 'add', label: tr('terminal.toolCreateCarton'), tint: 'blue', iconColor: '#33b1f0', locked: true },
    { id: 'labels', icon: 'label', label: tr('terminal.toolLabels'), tint: 'neutral', onPress: () => setShowLabels(true) },
    { id: 'warehouses', icon: 'warehouse', label: tr('terminal.toolWarehouses'), tint: 'neutral', locked: true },
    { id: 'pallets', icon: <PalletIcon />, label: tr('terminal.toolPallets'), tint: 'neutral', onPress: () => setShowPallets(true) },
    { id: 'delete', icon: 'delete_sweep', label: tr('terminal.toolDelete'), tint: 'red', locked: true },
    { id: 'share', icon: 'ios_share', label: tr('terminal.toolShare'), tint: 'blue', onPress: shareIssued },
    { id: 'assign', icon: 'send', flip: true, label: tr('terminal.toolAssign'), tint: 'green', locked: true },
    {
      id: 'gap', icon: 'report_problem', label: tr('terminal.toolGap'), tint: 'amber', iconColor: '#fbbf5c',
      onPress: () => showInfoToast(tr('terminal.gapNotApplicable'), 'report_problem', '#fbbf5c'),
    },
  ];

  return (
    <div className="h-dvh bg-canvas text-ink flex flex-col overflow-hidden">
      {/* Flash overlay */}
      {flashColor && (
        <div
          className={`fixed inset-0 z-40 pointer-events-none transition-opacity duration-300 ${
            flashColor === 'green' ? 'bg-ok/20' : 'bg-danger/20'
          }`}
        />
      )}

      {/* Toast (lookup feedback) */}
      {toastMessage && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 bg-tile border border-line-strong text-ink px-4 py-2.5 rounded-full shadow-lg text-sm font-semibold max-w-xs text-center animate-toastIn">
          {toastMessage}
        </div>
      )}

      <DesignHeader
        title={tr('issue.title')}
        subtitle={
          session?.user_info
            ? tr('issue.scanningAs', { nickname: session.user_info.nickname })
            : tr('issue.headerSubtitle')
        }
        onMenu={drawer.open}
      />
      <ProgressHeader
        label={tr('terminal.progressLabelIssue')}
        count={issuedBoxes.length}
        total={0}
        unitLabel={tr('terminal.statCartons')}
        tone={issuedBoxes.length > 0 ? 'done' : 'brand'}
      />

      {/* Camera + floating sheet */}
      <div className="flex-1 min-h-0 relative bg-black">
        <div className="absolute inset-0">
          <SmartScanner
            frame="corner"
            className="h-full"
            onBarcodeDetected={handleBarcodeDetected}
            scannedBarcodes={scannedBarcodes}
            ocrResults={ocrResults}
          />
        </div>

        <BottomSheet
          toolbar={<ToolDock chips={issueDockChips} onLockedPress={showLockToast} />}
          footer={
            <button
              onClick={handleComplete}
              disabled={issuedBoxes.length === 0}
              className={`w-full h-12 rounded-[13px] font-black text-[14px] transition-colors ${
                issuedBoxes.length > 0
                  ? 'bg-brand text-ink-inverse'
                  : 'bg-sunken text-ink-muted cursor-not-allowed'
              }`}
            >
              {tr('issue.doneButton', { count: issuedBoxes.length })}
            </button>
          }
        >
          <IssuedBoxList issuedBoxes={issuedBoxes} />
        </BottomSheet>
      </div>

      <Toast toast={infoToast} />
      {drawer.node}
      {showPallets && <PalletsBrowser token={token} onBack={() => setShowPallets(false)} />}
      {showLabels && (
        <LabelsBrowser
          token={token}
          documentNumber={session?.document_number}
          onBack={() => setShowLabels(false)}
        />
      )}

      {/* Box detail modal */}
      {phase === 'box_detail' && currentBox && (
        <BoxDetailModal
          box={currentBox}
          onConfirm={handleConfirmIssue}
          onCancel={handleCancelDetail}
          isLoading={isConfirming}
        />
      )}
    </div>
  );
}
