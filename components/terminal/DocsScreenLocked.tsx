'use client';

import { MI } from './MI';
import { LockedScreen } from './LockedScreen';
import { useT } from '@/lib/i18n';

// Sample docs straight from the design prototype (dimmed, non-interactive).
const SAMPLE_DOCS = [
  { type: 'invoice' as const, num: 'INV-4471', supplier: 'זוגלובק בע"מ', date: '14/05/2026', lines: 12 },
  { type: 'delivery' as const, num: 'DN-8823', supplier: 'טירת צבי', date: '13/05/2026', lines: 8 },
  { type: 'invoice' as const, num: 'INV-4468', supplier: 'מעדני מיקי', date: '12/05/2026', lines: 21 },
  { type: 'delivery' as const, num: 'DN-8817', supplier: 'נטו מלינדה', date: '11/05/2026', lines: 5 },
];

// Cream mini invoice thumbnail (46×58) — header bar, text rules, barcode.
function DocThumb() {
  return (
    <div className="flex-none w-[46px] h-[58px] rounded-[6px] bg-paper shadow-[0_3px_8px_rgba(0,0,0,.4)] relative overflow-hidden">
      <div className="absolute top-[6px] left-[5px] w-5 h-1 bg-[#b8b0a0] rounded-[1px]" />
      <div className="absolute top-[15px] left-[5px] right-[14px] h-[3px] bg-paper-line" />
      <div className="absolute top-[22px] left-[5px] right-[9px] h-[3px] bg-paper-line" />
      <div className="absolute top-[29px] left-[5px] right-[18px] h-[3px] bg-paper-line" />
      <div
        className="absolute bottom-[6px] left-[5px] right-[5px] h-[9px]"
        style={{ background: 'repeating-linear-gradient(90deg,#111 0 1.5px,transparent 1.5px 3px)' }}
      />
    </div>
  );
}

interface DocsScreenLockedProps {
  onBack: () => void;
}

// The design's מסמכים screen, rendered as a locked surface: full chrome
// (search field, filter buttons, chips) + the sample document cards dimmed
// behind a centered lock chip.
export function DocsScreenLocked({ onBack }: DocsScreenLockedProps) {
  const tr = useT();

  return (
    <LockedScreen title={tr('terminal.docsTitle')} onBack={onBack}>
      <div className="flex flex-col h-full">
        {/* Filter bar */}
        <div className="flex-none px-3 pt-3 pb-[10px] border-b border-[#101821] bg-header flex flex-col gap-[9px]">
          <div className="flex gap-2 items-center">
            <div className="flex-1 flex items-center gap-2 bg-search-bg border border-search-border rounded-[11px] px-3 h-[42px]">
              <MI name="search" size={19} className="text-search-ink" />
              <span className="flex-1 min-w-0 text-[13px] font-bold text-search-ink">{tr('terminal.docsSearch')}</span>
            </div>
            <span className="w-[42px] h-[42px] rounded-[11px] border border-line bg-tile flex items-center justify-center text-ink-inverse">
              <MI name="tune" size={20} />
            </span>
            <span className="w-[42px] h-[42px] rounded-[11px] border border-line bg-tile flex items-center justify-center text-ink-inverse">
              <MI name="calendar_month" size={20} />
            </span>
          </div>
          <div className="flex gap-[7px] flex-wrap">
            <span className="px-3 py-[6px] rounded-full text-[11px] font-extrabold border" style={{ background: 'rgba(19,164,236,.14)', borderColor: '#13a4ec', color: '#7cc9f2' }}>
              {tr('terminal.docsAll')}
            </span>
            <span className="px-3 py-[6px] rounded-full text-[11px] font-extrabold border border-line bg-tile text-ink-inverse">
              {tr('terminal.docsInvoices')}
            </span>
            <span className="px-3 py-[6px] rounded-full text-[11px] font-extrabold border border-line bg-tile text-ink-inverse">
              {tr('terminal.docsDeliveryNotes')}
            </span>
          </div>
        </div>

        {/* Sample document cards */}
        <div className="flex-1 min-h-0 overflow-hidden p-3 flex flex-col gap-[10px]">
          {SAMPLE_DOCS.map(doc => (
            <div key={doc.num} className="flex items-center gap-3 bg-raised border border-line rounded-[14px] p-[11px]">
              <DocThumb />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-[6px] mb-[3px]">
                  <span
                    className="px-2 py-[2px] rounded-full text-[9px] font-extrabold"
                    style={doc.type === 'invoice'
                      ? { background: 'rgba(19,164,236,.18)', color: '#7cc9f2' }
                      : { background: 'rgba(34,197,94,.16)', color: '#86efac' }}
                  >
                    {doc.type === 'invoice' ? tr('terminal.docsInvoiceBadge') : tr('terminal.docsDeliveryBadge')}
                  </span>
                  <span className="font-mono text-[10px] font-semibold text-[#cbd5e1]" dir="ltr">{doc.num}</span>
                </div>
                <div className="text-[14px] font-extrabold text-[#e8eef2] whitespace-nowrap overflow-hidden text-ellipsis">
                  {doc.supplier}
                </div>
                <div className="flex items-center gap-2 mt-[3px]">
                  <span className="text-[11px] font-semibold text-[#e8eef2]">{doc.date}</span>
                  <span className="text-[11px] font-semibold text-[#e8eef2]">· {tr('terminal.docsLines', { count: doc.lines })}</span>
                </div>
              </div>
              <MI name="chevron_left" size={20} className="flex-none text-[#cbd5e1]" />
            </div>
          ))}
        </div>
      </div>
    </LockedScreen>
  );
}
