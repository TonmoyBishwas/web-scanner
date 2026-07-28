'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { scannerAPI } from '@/lib/api';
import { CheckCircle, AlertTriangle, Check, Share2 } from 'lucide-react';
import { useLangDir, useT, LanguageContext } from '@/lib/i18n';
import type { Language, ScanSession } from '@/types';

function CompleteContent({ session }: { session: ScanSession }) {
  const tr = useT();
  const [shareToast, setShareToast] = useState(false);
  const shareToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scannedItems = Object.values(session.scanned_items || {});
  const totalScans = session.scanned_barcodes?.length || 0;
  const totalWeight = scannedItems.reduce((sum, item) => sum + item.scanned_weight, 0);

  async function handleShare() {
    const lines = [
      `${tr('complete.summary')} — ${tr('complete.title')}`,
      `${tr('complete.totalScanned')}: ${totalScans}`,
      `${tr('complete.totalWeightLabel')}: ${totalWeight.toFixed(2)} kg`,
      ...scannedItems.map(
        item => `• ${item.item_name}: ${tr('complete.boxesUnit', { count: item.scanned_count })}, ${item.scanned_weight.toFixed(2)} kg`
      ),
    ];
    const text = lines.join('\n');
    if (navigator.share) {
      try {
        await navigator.share({ text });
        return;
      } catch (e) {
        // user dismissed the sheet — done; anything else → clipboard fallback
        if ((e as DOMException)?.name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(text);
      setShareToast(true);
      if (shareToastTimer.current) clearTimeout(shareToastTimer.current);
      shareToastTimer.current = setTimeout(() => setShareToast(false), 2400);
    } catch {
      // clipboard unavailable — nothing sensible to do
    }
  }

  return (
    <div className="min-h-screen bg-canvas text-ink p-4">
      <div className="max-w-md mx-auto">
        {/* Success Header */}
        <div className="text-center mb-8 animate-fadeUp">
          <div className="w-16 h-16 rounded-full bg-ok-weak flex items-center justify-center mx-auto mb-4 animate-donePop">
            <CheckCircle className="w-9 h-9 text-ok" />
          </div>
          <h1 className="text-2xl font-extrabold mb-2">{tr('complete.title')}</h1>
          <p className="text-ink-muted">{tr('complete.returnToWhatsApp')}</p>
        </div>

        {/* Summary */}
        <div className="bg-raised border border-line rounded-[14px] p-4 mb-6">
          <h2 className="eyebrow mb-4">{tr('complete.summary')}</h2>
          <div className="space-y-2">
            <div className="flex justify-between items-center border-b border-line/60 pb-2">
              <span className="text-sm text-ink-body">{tr('complete.totalScanned')}</span>
              <span className="font-mono font-bold text-ink" dir="ltr">{totalScans}</span>
            </div>
            <div className="flex justify-between items-center border-b border-line/60 pb-2">
              <span className="text-sm text-ink-body">{tr('complete.totalWeightLabel')}</span>
              <span className="font-mono font-bold text-ink" dir="ltr">{totalWeight.toFixed(2)} kg</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-sm text-ink-body">{tr('complete.itemsLabel')}</span>
              <span className="font-mono font-bold text-ink" dir="ltr">{scannedItems.length}</span>
            </div>
          </div>
        </div>

        {/* Items List */}
        <div className="bg-raised border border-line rounded-[14px] p-4 mb-6">
          <h2 className="eyebrow mb-4">{tr('complete.scannedItemsTitle')}</h2>
          <div className="space-y-3">
            {scannedItems.map((item) => {
              const percentage = (item.scanned_weight / item.expected_weight) * 100;
              const isComplete = item.scanned_weight >= item.expected_weight;

              return (
                <div key={item.item_index} className="border-b border-line pb-3 last:border-0">
                  <div className="flex justify-between items-start mb-1">
                    <span className="font-extrabold text-ink">{item.item_name}</span>
                    {isComplete && <Check className="w-4 h-4 text-ok" />}
                  </div>
                  <div className="text-sm text-ink-muted space-y-1">
                    <p>{tr('complete.boxesUnit', { count: item.scanned_count })}</p>
                    <p className="font-mono" dir="ltr">
                      {item.scanned_weight.toFixed(2)} / {item.expected_weight.toFixed(2)} kg
                      {' '}({percentage.toFixed(0)}%)
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Instructions */}
        <div className="bg-info-weak border border-info/30 rounded-[14px] p-4">
          <p className="text-sm text-info-weak-ink">
            <strong>{tr('complete.nextSteps')}</strong><br />
            1. {tr('complete.step1')}<br />
            2. {tr('complete.step2')}<br />
            3. {tr('complete.step3')}
          </p>
        </div>

        {/* Share + Close */}
        <button
          onClick={handleShare}
          className="w-full mt-6 h-12 bg-brand-weak border border-brand/40 text-brand-weak-ink rounded-xl font-bold hover:opacity-90 transition-opacity flex items-center justify-center gap-2"
        >
          <Share2 className="w-4 h-4" /> {tr('complete.shareButton')}
        </button>
        <button
          onClick={() => window.close()}
          className="w-full mt-2 h-12 bg-tile border border-line-strong text-ink rounded-xl font-bold hover:bg-hover transition-colors"
        >
          {tr('complete.closeButton')}
        </button>

        {/* Copied toast (clipboard fallback feedback) */}
        {shareToast && (
          <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 bg-[#0d171d] border border-line-strong rounded-xl px-4 py-2.5 shadow-lg animate-toastIn">
            <Check className="w-4 h-4 text-ok" />
            <span className="text-sm font-bold text-ink">{tr('complete.shareCopied')}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function LoadingScreen() {
  const tr = useT();
  return (
    <div className="min-h-screen bg-canvas text-ink flex items-center justify-center">
      <div className="text-center">
        <div className="animate-spin rounded-full h-12 w-12 border-4 border-line border-t-brand mx-auto mb-4"></div>
        <p>{tr('common.loading')}</p>
      </div>
    </div>
  );
}

function NotFoundScreen() {
  const tr = useT();
  return (
    <div className="min-h-screen bg-canvas text-ink flex items-center justify-center p-4">
      <div className="text-center">
        <AlertTriangle className="w-10 h-10 text-warn mx-auto mb-4" />
        <p className="mb-4">{tr('session.notFoundShort')}</p>
      </div>
    </div>
  );
}

export default function CompletePage() {
  const params = useParams();
  const token = params.token as string;

  const [session, setSession] = useState<ScanSession | null>(null);
  const [loading, setLoading] = useState(true);

  // RTL flips automatically when the session language is Hebrew.
  const language = (session?.language as Language) || 'English';
  useLangDir(language);

  useEffect(() => {
    async function loadSession() {
      try {
        const data = await scannerAPI.getSession(token);
        setSession(data);
      } catch (err) {
        console.error('Failed to load session:', err);
      } finally {
        setLoading(false);
      }
    }
    loadSession();
  }, [token]);

  return (
    <LanguageContext.Provider value={language}>
      {loading ? (
        <LoadingScreen />
      ) : !session ? (
        <NotFoundScreen />
      ) : (
        <CompleteContent session={session} />
      )}
    </LanguageContext.Provider>
  );
}
