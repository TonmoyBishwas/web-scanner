'use client';

import { useState } from 'react';
import Image from 'next/image';
import { MI } from './MI';
import { Keypad } from './Keypad';
import { CalendarPicker } from './CalendarPicker';
import { useT } from '@/lib/i18n';

export interface EditItemChip {
  label: string;
  active: boolean;
  onPick: () => void;
}

interface EditPanelProps {
  cartonNumber: number | string;
  name: string;
  /** Weight as the raw editable string, e.g. "18.45" */
  weight: string;
  /** Expiry as free text (DD/MM/YYYY) */
  expiry: string;
  barcode: string;
  /** Invoice item chips for name snapping (design's iField) */
  itemChips?: EditItemChip[];
  imageData?: string;
  onViewImage?: () => void;
  onNameChange: (v: string) => void;
  onWeightChange: (v: string) => void;
  onExpiryChange: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
}

type Field = 'weight' | 'name' | 'expiry';

const ddmmyyyyToIso = (v: string): string => {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v.trim());
  if (!m) return '';
  return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
};
const isoToDdmmyyyy = (iso: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  return `${m[3]}/${m[2]}/${m[1]}`;
};

// Design in-sheet edit panel: blue-bordered card on #0a0f14 with a tinted
// top bar (back / "קרטון #N" / blue שמור pill), tappable field boxes
// ("נתוני המוצר"), and a context input footer that swaps per selected field —
// numeric keypad for weight, item chips + free text for the name, calendar
// for expiry. Barcode renders read-only (it is the dedup key).
export function EditPanel({
  cartonNumber, name, weight, expiry, barcode, itemChips,
  imageData, onViewImage,
  onNameChange, onWeightChange, onExpiryChange, onSave, onCancel,
}: EditPanelProps) {
  const tr = useT();
  const [field, setField] = useState<Field>('weight');
  const [calOpen, setCalOpen] = useState(false);

  const fieldBoxStyle = (sel: boolean): React.CSSProperties =>
    sel
      ? { background: 'rgba(19,164,236,.18)', border: '2px solid #13a4ec', boxShadow: '0 0 16px rgba(19,164,236,.5)' }
      : { background: 'rgba(19,164,236,.05)', border: '1.5px solid rgba(19,164,236,.32)' };

  const handleKey = (k: string) => {
    if (k === 'back') { onWeightChange(weight.slice(0, -1)); return; }
    if (k === '.' && weight.includes('.')) return;
    if (weight.replace('.', '').length >= 5) return;
    onWeightChange(weight + k);
  };

  return (
    <div className="border-2 border-brand rounded-[14px] overflow-hidden bg-header flex flex-col">
      {/* Top bar */}
      <div className="flex justify-between items-center gap-2 px-[13px] py-[11px] bg-brand-weak border-b border-[rgba(19,164,236,.2)]">
        <button onClick={onCancel} className="flex-none flex items-center p-1 text-ink-inverse" aria-label="back">
          <MI name="arrow_forward_ios" size={20} />
        </button>
        <div className="flex items-center gap-[7px] min-w-0 flex-1">
          <MI name="document_scanner" size={19} className="text-brand" />
          <div className="text-[12px] font-extrabold text-ink-inverse">
            {tr('terminal.editCarton', { n: cartonNumber })}
          </div>
        </div>
        <button
          onClick={onSave}
          className="flex-none flex items-center gap-[5px] text-[12px] font-extrabold text-ink-inverse bg-brand rounded-full px-[15px] py-[9px]"
        >
          <MI name="check" size={16} />
          {tr('terminal.save')}
        </button>
      </div>

      {/* Context input area (design places it above the field boxes) */}
      <div className="px-[13px] py-3 border-b border-line bg-header">
        {field === 'weight' && (
          <>
            <div className="flex items-baseline justify-end gap-[6px] bg-overlay-card border border-line rounded-[10px] px-[14px] py-[10px] mb-[10px]" dir="ltr">
              <span className="font-mono font-black text-[26px] text-ink-inverse">{weight || '0'}</span>
              <span className="text-[12px] font-extrabold text-brand-weak-ink">{tr('common.kg')}</span>
            </div>
            <Keypad onKey={handleKey} />
          </>
        )}
        {field === 'name' && (
          <div className="flex flex-col gap-2">
            {itemChips && itemChips.length > 0 && (
              <div className="flex flex-wrap gap-[7px]">
                {itemChips.map((chip, i) => (
                  <button
                    key={i}
                    onClick={chip.onPick}
                    className="px-3 py-2 rounded-[9px] text-[12px] font-bold border transition-colors"
                    style={chip.active
                      ? { background: 'rgba(19,164,236,.18)', borderColor: '#13a4ec', color: '#7cc9f2' }
                      : { background: '#101821', borderColor: '#1e2a35', color: '#e8eef2' }}
                  >
                    {chip.label}
                  </button>
                ))}
              </div>
            )}
            <input
              dir="rtl"
              type="text"
              value={name}
              onChange={e => onNameChange(e.target.value)}
              className="w-full box-border bg-line border-2 border-brand rounded-[10px] p-3 text-[13px] font-bold text-ink-inverse outline-none"
            />
          </div>
        )}
        {field === 'expiry' && (
          <button
            onClick={() => setCalOpen(true)}
            className="w-full box-border flex items-center gap-3 bg-line border-2 border-brand rounded-[12px] px-[13px] py-[11px] text-start"
          >
            <span className="flex-none w-[38px] h-[38px] rounded-[10px] bg-[rgba(19,164,236,.16)] flex items-center justify-center">
              <MI name="calendar_month" size={21} className="text-brand" />
            </span>
            <span className="flex-1 min-w-0">
              <span className="block text-[9px] font-bold text-[#e8eef2] tracking-[.5px]">{tr('terminal.expiryDate')}</span>
              <span className="block text-[15px] font-extrabold text-ink-inverse mt-[2px]" dir="ltr">
                {expiry || 'DD/MM/YYYY'}
              </span>
            </span>
            <span className="flex-none text-[11px] font-extrabold text-brand-weak-ink">{tr('terminal.openCalendar')}</span>
          </button>
        )}
      </div>

      {/* Field boxes */}
      <div className="px-[13px] py-4" style={{ background: 'linear-gradient(180deg,#0d171d,#0a1015)' }}>
        <div className="mb-[13px] flex items-center justify-between">
          <div className="text-[10px] font-black text-ink-inverse tracking-[.5px]">{tr('terminal.productData')}</div>
          {imageData && onViewImage && (
            <button onClick={onViewImage} className="relative w-9 h-9 rounded-[8px] overflow-hidden border border-line">
              <Image src={imageData} alt="" fill sizes="36px" className="object-cover" unoptimized />
            </button>
          )}
        </div>

        {/* Weight */}
        <button onClick={() => setField('weight')} className="w-full relative text-start rounded-[11px] px-3 py-[11px] transition-all" style={fieldBoxStyle(field === 'weight')}>
          <span className="absolute -top-2 left-[10px] bg-brand text-[#04222f] font-mono font-extrabold text-[7px] px-[6px] py-[2px] rounded-[4px] tracking-[.5px]">WT_DETECT</span>
          <div className="text-[8px] font-extrabold text-[#e8eef2] tracking-[.5px]">{tr('terminal.netWeight')}</div>
          <div className="font-mono font-black text-[27px] text-ink-inverse mt-[2px]" dir="ltr">
            {weight || '0'} <span className="text-[13px] text-brand-weak-ink">kg</span>
          </div>
        </button>

        {/* Name + expiry row */}
        <div className="flex gap-[9px] mt-[15px]">
          <button onClick={() => setField('name')} className="flex-1 min-w-0 relative text-start rounded-[11px] px-3 py-[11px] transition-all" style={fieldBoxStyle(field === 'name')}>
            <div className="text-[8px] font-extrabold text-[#e8eef2] tracking-[.5px]">{tr('terminal.itemName')}</div>
            <div className="text-[13px] font-bold text-ink-inverse mt-[3px] whitespace-nowrap overflow-hidden text-ellipsis">{name || '—'}</div>
          </button>
          <button onClick={() => setField('expiry')} className="flex-1 min-w-0 relative text-start rounded-[11px] px-3 py-[11px] transition-all" style={fieldBoxStyle(field === 'expiry')}>
            <div className="flex items-center justify-between">
              <span className="text-[8px] font-extrabold text-[#e8eef2] tracking-[.5px]">{tr('terminal.expiryDate')}</span>
              <MI name="calendar_month" size={14} className="text-brand" />
            </div>
            <div className="font-mono text-[13px] font-bold text-ink-inverse mt-[3px]" dir="ltr">{expiry || '—'}</div>
          </button>
        </div>

        {/* Barcode (read-only — it is the row's identity/dedup key) */}
        <div className="w-full relative rounded-[11px] px-3 py-[11px] mt-[15px]" style={fieldBoxStyle(false)}>
          <span className="absolute -top-2 left-[10px] bg-brand text-[#04222f] font-mono font-extrabold text-[7px] px-[6px] py-[2px] rounded-[4px] tracking-[.5px]">BC_SCAN</span>
          <div
            className="h-[34px] rounded-[2px] mt-[3px] mb-[6px]"
            style={{ background: 'repeating-linear-gradient(90deg,#e8edf2 0 2px,transparent 2px 4px,#e8edf2 4px 5px,transparent 5px 8px)' }}
          />
          <div className="font-mono text-[10px] font-bold text-ink-inverse text-center tracking-[2px]" dir="ltr">{barcode}</div>
        </div>
      </div>

      {calOpen && (
        <CalendarPicker
          value={ddmmyyyyToIso(expiry)}
          fieldTitle={tr('terminal.expiryDate')}
          onPick={iso => { onExpiryChange(isoToDdmmyyyy(iso)); setCalOpen(false); }}
          onClose={() => setCalOpen(false)}
        />
      )}
    </div>
  );
}
