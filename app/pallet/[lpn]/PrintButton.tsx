'use client';

export function PrintButton() {
  return (
    <button
      onClick={() => window.print()}
      className="bg-blue-600 text-white px-6 py-2.5 rounded-lg font-semibold hover:bg-blue-700 transition text-sm"
    >
      🖨️ Print Sticker
    </button>
  );
}
