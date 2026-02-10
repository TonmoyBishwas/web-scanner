export default function Home() {
  return (
    <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center p-4">
      <div className="max-w-md w-full text-center">
        <div className="text-6xl mb-6">📦</div>
        <h1 className="text-3xl font-bold mb-4">Warehouse Barcode Scanner</h1>
        <p className="text-gray-400 mb-8">
          Access this scanner through the Telegram bot to start scanning items.
        </p>
        <div className="bg-gray-800 rounded-lg p-6 text-left">
          <h2 className="font-medium mb-3">Features:</h2>
          <ul className="space-y-2 text-sm text-gray-300">
            <li>🔲 Scan items in any order</li>
            <li>📷 Automatic barcode detection</li>
            <li>📊 Real-time progress tracking</li>
            <li>⚡ Works offline</li>
          </ul>
        </div>
        <p className="mt-8 text-sm text-gray-500">
          Powered by html5-qrcode
        </p>
      </div>
    </div>
  );
}
