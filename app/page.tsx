import { Package } from 'lucide-react';

export default function Home() {
  return (
    <div className="min-h-screen bg-canvas text-ink flex items-center justify-center p-6">
      <div className="max-w-md w-full bg-raised border border-line rounded-2xl p-8 text-center space-y-4 shadow-sm">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-brand-weak text-brand-weak-ink mb-2">
          <Package className="w-8 h-8" strokeWidth={2} />
        </div>
        <h1 className="text-2xl font-bold">Warehouse Scanner</h1>
        <p className="text-ink-muted">
          This scanner works through your Telegram bot. Please scan the QR code or open the link sent to you on Telegram.
        </p>
        <div className="bg-sunken rounded-xl p-4 text-sm text-ink-body">
          <p className="font-semibold mb-1">How to use:</p>
          <ol className="text-left space-y-1 list-decimal list-inside">
            <li>Open Telegram</li>
            <li>Start a receiving or issuing session</li>
            <li>Tap the scanner link</li>
            <li>Allow camera access</li>
            <li>Start scanning barcodes</li>
          </ol>
        </div>
      </div>
    </div>
  );
}
