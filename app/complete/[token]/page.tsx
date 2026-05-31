'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { scannerAPI } from '@/lib/api-client';
import { ScanSession } from '@/types';
import { CheckCircle, Package, AlertTriangle } from 'lucide-react';
import { useT } from '@/lib/i18n';
import { LangDirRoot } from '@/components/shared/LangDirRoot';
import { Card } from '@/components/ui/Card';
import { Spinner } from '@/components/ui/Spinner';

export default function CompletePage() {
  const params = useParams();
  const token = params.token as string;

  const [session, setSession] = useState<ScanSession | null>(null);
  const [loading, setLoading] = useState(true);
  const tr = useT();

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

  if (loading) {
    return (
      <div className="min-h-screen bg-canvas text-ink flex items-center justify-center">
        <Spinner size={48} tone="brand" />
      </div>
    );
  }

  if (!session) {
    return (
      <div className="min-h-screen bg-canvas text-ink flex items-center justify-center p-6">
        <div className="text-center">
          <AlertTriangle className="w-12 h-12 text-danger mx-auto mb-4" strokeWidth={2} />
          <h1 className="text-xl font-bold mb-2">{tr('session.notFound')}</h1>
        </div>
      </div>
    );
  }

  const totalWeight = session.scanned_items?.reduce((sum, item) => sum + (item.total_weight || 0), 0) || 0;
  const totalBoxes = session.scanned_items?.length || 0;

  return (
    <LangDirRoot language={session.language}>
      <div className="min-h-screen bg-canvas text-ink p-6">
        <div className="max-w-md mx-auto">
          {/* Success Header */}
          <div className="text-center mb-8 pt-8">
            <div className="inline-flex items-center justify-center w-20 h-20 bg-ok rounded-full mb-4 animate-scaleIn">
              <CheckCircle className="w-12 h-12 text-ink-inverse" />
            </div>
            <h1 className="text-2xl font-bold mb-2">{tr('complete.title')}</h1>
            <p className="text-ink-muted">{tr('complete.subtitle')}</p>
          </div>

          {/* Summary Cards */}
          <div className="grid grid-cols-2 gap-4 mb-6">
            <Card className="text-center">
              <div className="text-3xl font-bold text-brand">{totalBoxes}</div>
              <div className="text-sm text-ink-muted mt-1">{tr('complete.boxesScanned')}</div>
            </Card>
            <Card className="text-center">
              <div className="text-3xl font-bold text-ok">{totalWeight.toFixed(2)}</div>
              <div className="text-sm text-ink-muted mt-1">{tr('complete.totalWeight')}</div>
            </Card>
          </div>

          {/* Scanned Items List */}
          {session.scanned_items && session.scanned_items.length > 0 && (
            <Card className="mb-6">
              <h2 className="font-semibold mb-3 flex items-center gap-2">
                <Package className="w-5 h-5 text-ink-muted" />
                {tr('complete.itemsLabel')}
              </h2>
              <div className="space-y-2">
                {session.scanned_items.map((item, idx) => (
                  <div key={idx} className="flex justify-between items-center py-2 border-b border-line last:border-0">
                    <span className="text-sm">{item.item_name || tr('complete.unknownItem')}</span>
                    <span className="text-sm text-ink-muted">
                      {item.box_count} {tr('common.boxes')} · {(item.total_weight || 0).toFixed(2)} kg
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* Instructions */}
          <Card tone="info" className="text-center">
            <p className="text-sm text-info-weak-ink">{tr('complete.returnToTelegram')}</p>
          </Card>
        </div>
      </div>
    </LangDirRoot>
  );
}
