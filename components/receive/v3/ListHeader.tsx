'use client';

/**
 * Receive form v3, the list's top (5.4–5.6): header row 1 (supplier · note,
 * the note-photo icon, the pallets icon with its badge), the search field
 * (always shown; a count while searching) and the two-option toggle
 * [לא מולאו N | מולאו M]. `SearchField` is shared with the loose sub-screen
 * and the packaging list.
 */
import type { CSSProperties } from 'react';
import { V3Icon } from './icons';
import { BARE, I, P, font } from './tokens';
import type { Tr } from './texts';

export function HeaderRow({
  supplier,
  invoiceNumber,
  pallets,
  hasPhoto,
  tr,
  onNotePhoto,
  onPallets,
}: {
  supplier: string;
  invoiceNumber: string;
  pallets: number;
  hasPhoto: boolean;
  tr: Tr;
  onNotePhoto: () => void;
  onPallets: () => void;
}) {
  const btn: CSSProperties = {
    ...BARE,
    width: 40,
    height: 40,
    flex: 'none',
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
  };
  const palAria = pallets === 1 ? tr('receive.v3.palletsOne') : tr('receive.v3.palletsN', { n: I(pallets) });
  return (
    <div
      data-part="head"
      style={{ height: 52, flex: 'none', display: 'flex', alignItems: 'center', gap: 8, paddingInline: '16px 12px' }}
    >
      <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 6, whiteSpace: 'nowrap' }}>
        <span style={{ flex: 'none', font: font(600, 17), color: P.ink }}>{supplier}</span>
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', font: font(400, 15), color: P.ink2 }}>
          {tr('receive.v3.headNote', { n: I(invoiceNumber) })}
        </span>
      </div>
      <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 2, marginInlineEnd: -6 }}>
        {hasPhoto && (
          <button type="button" onClick={onNotePhoto} aria-label={tr('receive.v3.notePhoto')} title={tr('receive.v3.notePhoto')} style={btn}>
            <V3Icon name="description" size={22} />
          </button>
        )}
        <button type="button" onClick={onPallets} aria-label={palAria} title={palAria} style={btn}>
          <V3Icon name="inventory_2" size={22} />
          <span
            aria-hidden="true"
            style={{
              position: 'absolute',
              top: 3,
              insetInlineEnd: 2,
              minWidth: 16,
              height: 16,
              padding: '0 4px',
              borderRadius: 8,
              background: P.ink,
              color: P.bg,
              font: font(500, 11, 16),
              textAlign: 'center',
            }}
          >
            {pallets}
          </span>
        </button>
      </div>
    </div>
  );
}

/** The 48 px search field: icon, text input, clear × while not empty. */
export function SearchField({
  value,
  onChange,
  placeholder,
  ariaLabel,
  clearLabel,
  rtl,
  inputMode,
  onClear,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  ariaLabel?: string;
  /** Without it, no clear button (the packaging filter has none). */
  clearLabel?: string;
  rtl: boolean;
  inputMode?: 'text' | 'search';
  onClear?: () => void;
}) {
  return (
    <div
      role="search"
      style={{
        flex: 1,
        minWidth: 0,
        height: 48,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        paddingInline: '10px 2px',
        background: P.surf,
        border: `1px solid ${P.line2}`,
        borderRadius: 6,
      }}
    >
      <span style={{ color: P.ink2, display: 'flex' }}>
        <V3Icon name="search" size={22} />
      </span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        inputMode={inputMode}
        dir={rtl ? 'rtl' : 'ltr'}
        type="text"
        enterKeyHint="search"
        autoComplete="off"
        style={{
          flex: 1,
          minWidth: 0,
          height: '100%',
          background: 'none',
          border: 'none',
          outline: 'none',
          color: P.ink,
          font: font(400, 16),
          textAlign: 'start',
          padding: 0,
        }}
      />
      {clearLabel && value !== '' && (
        <button
          type="button"
          onClick={onClear ?? (() => onChange(''))}
          aria-label={clearLabel}
          title={clearLabel}
          style={{ ...BARE, width: 40, height: 44, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <V3Icon name="close" size={22} />
        </button>
      )}
    </div>
  );
}

/** Search row: the field, and `{n} מתוך {total}` while a search is on. */
export function SearchRow({
  query,
  onQuery,
  collapsed,
  shown,
  total,
  rtl,
  tr,
}: {
  query: string;
  onQuery: (q: string) => void;
  /** Header row 1 hidden (scrolled / keyboard): the row gets its own top padding. */
  collapsed: boolean;
  /** Lines found, or null when no search is on. */
  shown: number | null;
  total: number;
  rtl: boolean;
  tr: Tr;
}) {
  return (
    <div data-part="search" style={{ flex: 'none', padding: collapsed ? '8px 12px 8px' : '0 12px 8px', display: 'flex', gap: 8 }}>
      <SearchField
        value={query}
        onChange={onQuery}
        placeholder={tr('receive.v3.search')}
        clearLabel={tr('receive.v3.clear')}
        rtl={rtl}
      />
      {shown !== null && (
        <span
          style={{ height: 48, flex: 'none', display: 'flex', alignItems: 'center', padding: '0 4px', font: font(400, 15), color: P.ink2, whiteSpace: 'nowrap' }}
        >
          {tr('receive.v3.searchCount', { n: I(shown), total: I(total) })}
        </span>
      )}
    </div>
  );
}

/** The two-option toggle: `לא מולאו {k}` | `מולאו {m}`. */
export function TabToggle({
  tab,
  need,
  done,
  tr,
  onTab,
}: {
  tab: 'need' | 'done';
  need: number;
  done: number;
  tr: Tr;
  onTab: (t: 'need' | 'done') => void;
}) {
  const seg = (on: boolean, second: boolean): CSSProperties => ({
    flex: 1,
    height: '100%',
    padding: '0 10px',
    border: 'none',
    borderInlineStart: second ? `1px solid ${P.ink}` : 'none',
    background: on ? P.ink : P.bg,
    color: on ? P.bg : P.ink,
    font: font(500, 15),
    whiteSpace: 'nowrap',
    borderRadius: 0,
  });
  return (
    <div data-part="tabs" style={{ flex: 'none', padding: '0 12px 8px' }}>
      <div
        role="group"
        aria-label={tr('receive.v3.filter')}
        style={{ height: 42, display: 'flex', border: `1px solid ${P.ink}`, borderRadius: 6, overflow: 'hidden' }}
      >
        <button type="button" onClick={() => onTab('need')} aria-pressed={tab === 'need'} style={seg(tab === 'need', false)}>
          {tr('receive.v3.tabNeed', { n: I(need) })}
        </button>
        <button type="button" onClick={() => onTab('done')} aria-pressed={tab === 'done'} style={seg(tab === 'done', true)}>
          {tr('receive.v3.tabDone', { n: I(done) })}
        </button>
      </div>
    </div>
  );
}
