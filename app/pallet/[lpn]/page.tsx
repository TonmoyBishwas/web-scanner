import type { Metadata } from 'next';
import { PrintButton } from './PrintButton';
import { t } from '@/lib/i18n/server';
import type { Language } from '@/types';
import { LPN_STICKER_MARKER } from '@/lib/lpn-constants';
import { computeLpnSignature } from '@/lib/lpn-signature';
import { supabase } from '@/lib/supabase';

// NEVER cache this page. `supabase-js` reads through `fetch`, so any segment
// `revalidate` also caches the Supabase response in the Data Cache. The bot
// INSERTs the pallets row with lifecycle fields only and backfills the display
// columns (item/boxes/kg/doc) a moment later, so a read landing in that window
// returns an all-zero row — and a cached zero row gets printed onto a physical
// label. Each sticker is opened a handful of times, so there is nothing to gain
// from caching and a wrong warehouse label to lose.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface PalletRecord {
  lpn: string;
  item_name: string;
  item_code: string;
  document_number: string;
  box_count: number;
  ocr_box_weight: number;
  calc_weight: number;
  scale_weight: number;
  status: string;
  created_at: string;
}

async function fetchPalletRecord(lpn: string): Promise<PalletRecord | null> {
  try {
    const { data, error } = await supabase
      .from('pallets')
      .select(
        'lpn, item_name, item_code, document_number, box_count, ocr_box_weight_kg, calculated_total_weight_kg, scale_weight_kg, status, created_at'
      )
      .eq('lpn', lpn)
      .maybeSingle();

    if (error || !data) return null;

    return {
      lpn: data.lpn || lpn,
      item_name: data.item_name || '',
      item_code: data.item_code || '',
      document_number: data.document_number || '',
      box_count: data.box_count || 0,
      ocr_box_weight: data.ocr_box_weight_kg || 0,
      calc_weight: data.calculated_total_weight_kg || 0,
      scale_weight: data.scale_weight_kg || 0,
      status: data.status || 'Unknown',
      created_at: data.created_at || new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

/**
 * Resolve the page language from the `?lang=` query string.
 * Accepts: 'he' | 'Hebrew' (case-insensitive). Anything else → English.
 * The pallet-verify scanner appends &lang=Hebrew when the session is Hebrew.
 */
function resolveLanguage(raw: string | undefined): Language {
  if (!raw) return 'English';
  const v = raw.toLowerCase();
  return v === 'he' || v === 'hebrew' ? 'Hebrew' : 'English';
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lpn: string }>;
}): Promise<Metadata> {
  const { lpn } = await params;
  return { title: `Pallet ${lpn}` };
}

export default async function PalletStickerPage({
  params,
  searchParams,
}: {
  params: Promise<{ lpn: string }>;
  searchParams: Promise<{ token?: string; lang?: string }>;
}) {
  const { lpn } = await params;
  const { token, lang } = await searchParams;
  const language = resolveLanguage(lang);
  const pallet = await fetchPalletRecord(lpn);

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://scanner.vercel.app';
  // The QR payload uses the new `/sticker/v1/{lpn}?sig=WHPL-…` namespace so
  // the bot can uniquely identify our printed stickers. The legacy
  // `/pallet/{lpn}` URL stays alive (this page) for old physical stickers.
  // Language is preserved as a query param so re-openings keep RTL.
  const signature = computeLpnSignature(lpn);
  const qrPayloadParams = new URLSearchParams();
  if (signature) qrPayloadParams.set('sig', signature);
  if (language === 'Hebrew') qrPayloadParams.set('lang', 'Hebrew');
  const qrQuery = qrPayloadParams.toString();
  const palletUrl = `${appUrl}/sticker/v1/${encodeURIComponent(lpn)}${qrQuery ? `?${qrQuery}` : ''}`;
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(palletUrl)}`;
  // If reached from an active scanner session, "Back" returns there instead of the home page.
  const backHref = token ? `/pallet-verify/${encodeURIComponent(token)}` : '/';
  const backLabel = token ? t(language, 'lpn.backToScanner') : t(language, 'lpn.back');
  const dir = language === 'Hebrew' ? 'rtl' : 'ltr';

  // DD/MM/YYYY works for both en-GB and Israeli convention; keep as-is.
  const displayDate = pallet
    ? new Date(pallet.created_at).toLocaleDateString('en-GB')
    : new Date().toLocaleDateString('en-GB');

  return (
    <div
      lang={language === 'Hebrew' ? 'he' : 'en'}
      dir={dir}
      id="pallet-page"
      className="min-h-screen bg-canvas print:bg-white flex flex-col items-center justify-center p-4"
    >
      {/* Print button (hidden when printing) */}
      <div className="no-print mb-6 flex gap-3">
        <PrintButton />
        <a
          href={backHref}
          className="inline-flex items-center h-12 px-6 bg-tile border border-line-strong text-ink rounded-xl font-bold hover:bg-hover transition text-sm"
        >
          {backLabel}
        </a>
      </div>

      {/* Sticker Card */}
      <div
        id="pallet-sticker"
        className="bg-white border-2 border-gray-800 rounded-xl p-6 w-full max-w-sm shadow-lg print:shadow-none print:border-black print:rounded-none print:p-4"
        style={{ fontFamily: 'monospace' }}
      >
        {/* Header — the marker text is exactly what the bot's Gemini
            classifier looks for to confirm "this is one of our printed
            stickers". Don't translate it; keep the literal LPN_STICKER_MARKER. */}
        <div className="border-b-2 border-gray-800 pb-3 mb-3 text-center">
          <p className="text-sm font-bold text-gray-900 tracking-wide" dir="ltr">
            {LPN_STICKER_MARKER}
          </p>
          <p className="text-[10px] text-gray-500 uppercase tracking-widest mt-1">
            {t(language, 'lpn.warehousePallet')}
          </p>
          <p className="text-xl font-bold text-gray-900 mt-1 tracking-wide" dir="ltr">{lpn}</p>
        </div>

        {pallet ? (
          <>
            {/* Item info */}
            <div className="space-y-1.5 mb-4 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-500">{t(language, 'lpn.itemLabelShort')}</span>
                <span className="font-semibold text-gray-900 text-end max-w-[60%] leading-tight">
                  {pallet.item_name}
                </span>
              </div>
              {pallet.item_code && (
                <div className="flex justify-between">
                  <span className="text-gray-500">{t(language, 'lpn.skuLabel')}</span>
                  <span className="font-mono text-xs text-gray-700" dir="ltr">{pallet.item_code}</span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-gray-500">{t(language, 'lpn.boxesLabelShort')}</span>
                <span className="font-bold text-gray-900">{pallet.box_count}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">{t(language, 'lpn.weightLabelShort')}</span>
                <span className="font-bold text-gray-900">{pallet.calc_weight} kg</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">{t(language, 'lpn.scaleLabel')}</span>
                <span className="text-gray-700">{pallet.scale_weight} kg</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">{t(language, 'lpn.docLabel')}</span>
                <span className="text-gray-700" dir="ltr">{pallet.document_number}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">{t(language, 'lpn.dateLabelShort')}</span>
                <span className="text-gray-700" dir="ltr">{displayDate}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">{t(language, 'lpn.statusLabel')}</span>
                <span
                  className={`text-xs font-semibold px-2 py-0.5 rounded ${
                    pallet.status === 'Verified'
                      ? 'bg-green-100 text-green-700'
                      : 'bg-yellow-100 text-yellow-700'
                  }`}
                >
                  {pallet.status}
                </span>
              </div>
            </div>
          </>
        ) : (
          <div className="text-center text-sm text-gray-500 my-4">
            <p>{t(language, 'lpn.notFound')}</p>
            <p className="text-xs mt-1" dir="ltr">{t(language, 'lpn.lpnLabel', { lpn })}</p>
          </div>
        )}

        {/* QR Code */}
        <div className="flex flex-col items-center border-t-2 border-gray-800 pt-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={qrUrl}
            alt={`QR code for pallet ${lpn}`}
            width={160}
            height={160}
            className="rounded"
          />
          {signature && (
            <p className="text-[11px] font-mono font-bold text-gray-700 mt-1 tracking-wide" dir="ltr">
              {signature}
            </p>
          )}
          <p className="text-[9px] text-gray-400 mt-1 text-center break-all" dir="ltr">{palletUrl}</p>
        </div>
      </div>

      {/* Print CSS */}
      <style>{`
        @media print {
          .no-print { display: none !important; }
          /* The on-screen chrome is dark; the printed label must stay white
             ink-on-paper. Force white on body AND the page wrapper so the
             dark canvas background can never bleed onto the physical label. */
          html, body { background: white !important; }
          #pallet-page { background: white !important; }
          #pallet-sticker { width: 90mm; margin: 0 auto; page-break-inside: avoid; background: white !important; }
        }
      `}</style>
    </div>
  );
}
