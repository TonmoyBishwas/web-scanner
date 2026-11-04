/** The pure part of scripts/replay-name-check.ts (imported by its test). */
import { matchInvoiceItem, type InvoiceItem } from '../lib/invoice-match';

export interface Sticker { ts?: string; seq?: number; he?: string | null; en?: string | null; weight?: string | null }
export interface SessionExport {
  token: string;
  doc?: string;
  ocr_before: InvoiceItem[];
  ocr_after: InvoiceItem[];
  stickers: Sticker[];
}
export interface StickerResult { sticker: Sticker; before: string | null; after: string | null }

export function replaySession(s: SessionExport): StickerResult[] {
  return s.stickers.map((sticker) => ({
    sticker,
    before: matchInvoiceItem(sticker.he ?? '', sticker.en ?? '', s.ocr_before)?.item_code ?? null,
    after: matchInvoiceItem(sticker.he ?? '', sticker.en ?? '', s.ocr_after)?.item_code ?? null,
  }));
}
