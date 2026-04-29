import type { Metadata } from 'next';
import { PrintButton } from './PrintButton';

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
  const PALLETS_TABLE_ID = process.env.AIRTABLE_PALLETS_TABLE_ID;
  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;

  if (!PALLETS_TABLE_ID || !AIRTABLE_TOKEN || !AIRTABLE_BASE_ID) {
    return null;
  }

  try {
    const formula = encodeURIComponent(`{LPN}="${lpn}"`);
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${PALLETS_TABLE_ID}?filterByFormula=${formula}&maxRecords=1`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
      next: { revalidate: 60 },
    });

    if (!res.ok) return null;
    const data = await res.json();

    if (!data.records || data.records.length === 0) return null;

    const fields = data.records[0].fields;
    const createdTime = data.records[0].createdTime;

    return {
      lpn: fields['LPN'] || lpn,
      item_name: fields['Item Name'] || '',
      item_code: fields['Item Code'] || '',
      document_number: fields['Document Number'] || '',
      box_count: fields['Box Count'] || 0,
      ocr_box_weight: fields['OCR Box Weight (kg)'] || 0,
      calc_weight: fields['Calculated Total Weight (kg)'] || 0,
      scale_weight: fields['Scale Weight (kg)'] || 0,
      status: fields['Status'] || 'Unknown',
      created_at: createdTime || new Date().toISOString(),
    };
  } catch {
    return null;
  }
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
  searchParams: Promise<{ token?: string }>;
}) {
  const { lpn } = await params;
  const { token } = await searchParams;
  const pallet = await fetchPalletRecord(lpn);

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://scanner.vercel.app';
  const palletUrl = `${appUrl}/pallet/${encodeURIComponent(lpn)}`;
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(palletUrl)}`;
  // If reached from an active scanner session, "Back" returns there instead of the home page.
  const backHref = token ? `/pallet-verify/${encodeURIComponent(token)}` : '/';
  const backLabel = token ? '← Back to scanner' : '← Back';

  const displayDate = pallet
    ? new Date(pallet.created_at).toLocaleDateString('en-GB')
    : new Date().toLocaleDateString('en-GB');

  return (
    <div className="min-h-screen bg-gray-100 flex flex-col items-center justify-center p-4">
      {/* Print button (hidden when printing) */}
      <div className="no-print mb-6 flex gap-3">
        <PrintButton />
        <a
          href={backHref}
          className="bg-gray-200 text-gray-700 px-6 py-2.5 rounded-lg font-semibold hover:bg-gray-300 transition text-sm"
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
        {/* Header */}
        <div className="border-b-2 border-gray-800 pb-3 mb-3 text-center">
          <p className="text-xs text-gray-500 uppercase tracking-widest">🏭 Warehouse Pallet</p>
          <p className="text-xl font-bold text-gray-900 mt-1 tracking-wide">{lpn}</p>
        </div>

        {pallet ? (
          <>
            {/* Item info */}
            <div className="space-y-1.5 mb-4 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-500">Item</span>
                <span className="font-semibold text-gray-900 text-right max-w-[60%] leading-tight">
                  {pallet.item_name}
                </span>
              </div>
              {pallet.item_code && (
                <div className="flex justify-between">
                  <span className="text-gray-500">SKU</span>
                  <span className="font-mono text-xs text-gray-700">{pallet.item_code}</span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-gray-500">Boxes</span>
                <span className="font-bold text-gray-900">{pallet.box_count}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Weight</span>
                <span className="font-bold text-gray-900">{pallet.calc_weight} kg</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Scale</span>
                <span className="text-gray-700">{pallet.scale_weight} kg</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Doc</span>
                <span className="text-gray-700">{pallet.document_number}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Date</span>
                <span className="text-gray-700">{displayDate}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Status</span>
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
            <p>Pallet record not found in database.</p>
            <p className="text-xs mt-1">LPN: {lpn}</p>
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
          <p className="text-[9px] text-gray-400 mt-1 text-center break-all">{palletUrl}</p>
        </div>
      </div>

      {/* Print CSS */}
      <style>{`
        @media print {
          .no-print { display: none !important; }
          body { background: white; }
          #pallet-sticker { width: 90mm; margin: 0 auto; page-break-inside: avoid; }
        }
      `}</style>
    </div>
  );
}
