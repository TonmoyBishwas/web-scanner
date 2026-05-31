'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { scannerAPI } from '@/lib/api';
import { CheckCircle, AlertTriangle, Check } from 'lucide-react';
import { useLangDir, useT, LanguageContext } from '@/lib/i18n';
import type { Language, ScanSession } from '@/types';

function CompleteContent({ session }: { session: ScanSession }) {
  const tr = useT();

  const scannedItems = Object.values(session.scanned_items || {});
  const totalScans = session.scanned_barcodes?.length || 0;
  const totalWeight = scannedItems.reduce((sum, item) => sum + item.scanned_weight, 0);

  return (
    <div className="min-h-screen bg-canvas text-ink p-4">
      <div className="max-w-md mx-auto">
        {/* Success Header */}
        <div className="text-center mb-8">
          <CheckCircle className="w-16 h-16 text-ok mx-auto mb-4" />
          <h1 className="text-2xl font-bold mb-2">{tr('complete.title')}</h1>
          <p className="text-ink-muted">{tr('complete.returnToWhatsApp')}</p>
        </div>

        {/* Summary */}
        <div className="bg-raised border border-line rounded-2xl p-4 mb-6">
          <h2 className="text-lg font-medium mb-4">{tr('complete.summary')}</h2>
          <div className="space-y-2">
            <div className="flex justify-between">
              <span className="text-ink-muted">{tr('complete.totalScanned')}</span>
              <span className="font-medium">{totalScans}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-ink-muted">{tr('complete.totalWeightLabel')}</span>
              <span className="font-medium">{totalWeight.toFixed(2)} kg</span>
            </div>
            <div className="flex justify-between">
              <span className="text-ink-muted">{tr('complete.itemsLabel')}</span>
              <span className="font-medium">{scannedItems.length}</span>
            </div>
          </div>
        </div>

        {/* Items List */}
        <div className="bg-raised border border-line rounded-2xl p-4 mb-6">
          <h2 className="text-lg font-medium mb-4">{tr('complete.scannedItemsTitle')}</h2>
          <div className="space-y-3">
            {scannedItems.map((item) => {
              const percentage = (item.scanned_weight / item.expected_weight) * 100;
              const isComplete = item.scanned_weight >= item.expected_weight;

              return (
                <div key={item.item_index} className="border-b border-line pb-3 last:border-0">
                  <div className="flex justify-between items-start mb-1">
                    <span className="font-medium">{item.item_name}</span>
                    {isComplete && <Check className="w-4 h-4 text-ok" />}
                  </div>
                  <div className="text-sm text-ink-muted space-y-1">
                    <p>{tr('complete.boxesUnit', { count: item.scanned_count })}</p>
                    <p>
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
        <div className="bg-info-weak border border-info/30 rounded-2xl p-4">
          <p className="text-sm text-info-weak-ink">
            <strong>{tr('complete.nextSteps')}</strong><br />
            1. {tr('complete.step1')}<br />
            2. {tr('complete.step2')}<br />
            3. {tr('complete.step3')}
          </p>
        </div>

        {/* Close Button */}
        <button
          onClick={() => window.close()}
          className="w-full mt-6 bg-sunken text-ink py-3 rounded-xl font-medium hover:bg-hover transition-colors"
        >
          {tr('complete.closeButton')}
        </button>
      </div>
    </div>
  );
}

function LoadingScreen() {
  const tr = useT();
  return (
    <div className="min-h-screen bg-canvas text-ink flex items-center justify-center">
      <div className="text-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-brand mx-auto mb-4"></div>
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
