export type { PalletSlot, RosterEntry, LooseTask, SlotStatus } from '@/lib/pallet-slots';
import type { PalletSlot, RosterEntry, LooseTask } from '@/lib/pallet-slots';

// Barcode Data Types
export interface ParsedBarcode {
  type: 'id-only' | '31-digit' | '25-digit' | 'short' | 'unknown';
  sku: string;  // Just the ID - barcode is identifier only
  weight: number;  // Always 0 - comes from OCR only
  expiry: string;  // Always empty - comes from OCR only
  raw_barcode: string;
  expiry_source: 'ocr_required';  // Always requires OCR
}

// OCR result from box sticker (new Gemini format)
export interface BoxStickerOCR {
  product_name?: string | null;           // DEPRECATED: Legacy field for backwards compatibility
  product_name_hebrew?: string | null;    // Hebrew product name (primary)
  product_name_english?: string | null;   // English product name (for matching fallback)
  weight_kg: number | null;              // Net weight in KG
  production_date: string | null;        // YYYY-MM-DD
  expiry_date: string | null;            // YYYY-MM-DD
  barcode_digits: string | null;         // Barcode digits from image
}

// Session Data Types
export interface InvoiceItem {
  item_index: number;
  item_code: string;
  item_name_english: string;
  item_name_hebrew: string;
  quantity_kg: number;
  expected_boxes: number;
}

export interface ScanEntry {
  // Barcode is JUST an identifier for deduplication
  barcode: string;

  // Timestamp
  scanned_at: string;

  // Image storage (REQUIRED for all scans)
  image_url: string;            // Cloudinary URL (required)
  image_public_id: string;      // Cloudinary public ID

  // OCR results (primary data source)
  ocr_data?: BoxStickerOCR;
  ocr_processed_at?: string;
  ocr_status: 'pending' | 'complete' | 'failed' | 'manual';

  // Manual entry fallback
  manual_entry?: {
    item_name: string;
    weight: number;
    expiry: string;
    notes?: string;
  };

  // Resolved by user (when OCR fails)
  resolved_item_name?: string;
  resolved_weight?: number;
  resolved_expiry?: string;

  // Smart inference
  inferred_weight?: number;

  // Metadata
  scan_method: 'barcode' | 'manual_capture' | 'force_confirm';
}

export interface ScannedItem {
  item_index: number;
  item_name: string;
  scanned_count: number;
  scanned_weight: number;
  expected_weight: number;
  expected_boxes: number;
}

export type Language = 'English' | 'Hebrew';

export interface ScanSession {
  token: string;
  chat_id: string;
  operation_type: string;
  document_number: string;
  invoice_items: InvoiceItem[];
  scanned_barcodes: ScanEntry[];
  scanned_items: Record<string, ScannedItem>;
  created_at: string;
  expires_at: string;
  status: 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
  completed_at?: string;
  webhook_sent?: boolean;
  invoice_image_url?: string;
  issued_boxes?: IssuedBox[];
  user_info?: {
    chat_id: string;
    nickname: string;
    role: string;
    phone?: string;
  };
  /** User's preferred language ("English" / "Hebrew"). Set by the bot
   *  when creating the session; the page reads it on mount and renders
   *  its UI in this language. Defaults to "English" if missing. */
  language?: Language;
}

export interface SessionResponse {
  token: string;
  scan_url: string;
  expires_at: string;
}

export interface ScanRequest {
  token: string;
  barcode: string;
  parsed_data?: ParsedBarcode;
  image_url?: string;
  image_public_id?: string;
  detected_at: string;
  document_number?: string;
  scan_method?: 'barcode' | 'manual_capture' | 'force_confirm';
}

// Manual Entry Data
export interface ManualEntryData {
  token: string;
  item_name: string;
  weight: number;
  expiry: string;
  notes?: string;
  image_url?: string;
  image_public_id?: string;
  document_number?: string;
}

export interface ScanResponse {
  success: boolean;
  is_duplicate: boolean;
  matched_item?: ScannedItem;
  overall_progress?: {
    total_items: number;
    total_weight_scanned: number;
    total_weight_expected: number;
    completion_rate: number;
    total_boxes_scanned: number;
    total_boxes_expected: number;
  };
  error?: string;
  message?: string;
}

export interface CompleteRequest {
  token: string;
}

export interface CompleteResponse {
  success: boolean;
  summary: Record<string, ScannedItem>;
  scanned_barcodes: ScanEntry[];
  error?: string;
}

// OCR API types
export interface OCRRequest {
  token: string;
  image?: string;      // base64 image (deprecated)
  image_url?: string;  // Cloudinary URL (preferred)
  barcode: string;
}

export interface OCRResponse {
  success: boolean;
  ocr_data?: BoxStickerOCR;
  error?: string;
}

// Issue types for OCR resolution
export interface OCRIssue {
  barcode: string;
  image_url: string;
  type: 'missing_name' | 'missing_weight' | 'missing_both';
  inferred_weight?: number;
  ocr_data?: BoxStickerOCR;
}

// Issue (Issue to Production) types
export interface IssuedBox {
  barcode: string;
  sku: string;
  item_name: string;
  weight: number;
  expiry: string;
  supplier: string;
  invoice_number: string;
  box_record_id: string;
  batch_id: string;
  transaction_id: string;
  issued_at: string;
}

export interface BoxLookupResult {
  found: boolean;
  box?: {
    record_id: string;
    barcode: string;
    sku: string;
    weight: number;
    expiry: string;
    status: string;
    batch_id: string;
    item_name: string;
    supplier: string;
    invoice_number: string;
    received_date: string;
    production_date?: string;
  };
  error?: 'not_found' | 'already_issued' | 'error';
  message?: string;
}

// ─── Pallet types ─────────────────────────────────────────────────────────────

export interface PalletBoxScan {
  barcode: string;
  item_name: string;
  item_name_hebrew?: string;
  sku: string;
  weight: number;
  expiry: string;
  image_url: string;
  scanned_at: string;
}

export interface PalletSession {
  token: string;
  chat_id: string;
  pallet_number: number;
  pallet_count: number;
  scale_weight: number;
  expected_box_count: number;
  invoice_document_number: string;
  ocr_data: Array<{
    item_code: string;
    item_name_english: string;
    item_name_hebrew: string;
    quantity_kg: number;
  }>;
  scanned_boxes: PalletBoxScan[];
  status: 'active' | 'verified' | 'completed';
  created_at: string;
}

export interface PalletVerificationResult {
  verified: boolean;
  lpn: string;
  item_name: string;
  item_code: string;
  ocr_box_weight: number;
  /** ocr_box_weight × expected_box_count */
  calculated_total_weight: number;
  scale_weight: number;
  box_count: number;
  verified_scan_count: number;
  mismatches: string[];
}

// ─── Multi-Pallet Session ─────────────────────────────────────────────────────

export interface MultiPalletBoxScan {
  barcode: string;
  sku: string;
  item_name: string;
  item_name_hebrew?: string;
  weight: number;
  expiry: string;
  scanned_at: string;
}

export interface MultiPalletSession {
  token: string;
  chat_id: string;
  pallet_count: number;
  loose_box_count: number;
  current_pallet: number;
  current_box_count?: number;  // persisted so refresh doesn't lose the entered count
  document_number: string;
  ocr_data: Array<{
    item_code: string;
    item_name_english: string;
    item_name_hebrew: string;
    quantity_kg: number;
    /** Weight-based non-meat (Type A) only: invoice carton count and per-carton
     *  weight. The scanner scans one box per item and computes the total as
     *  unit_weight_kg × cartons. Absent/0 for meat and count-based non-meat. */
    box_count?: number;
    unit_weight_kg?: number;
    /** The specific supplier invoice this line came from. Present on a
     *  multi-invoice delivery (two same-supplier invoices merged onto one
     *  physical pallet); equals `document_number` for a normal delivery. Lets
     *  the pallet-complete webhook stamp each box with its true invoice number. */
    document_number?: string;
  }>;
  receipt_id?: string;
  completed_pallets: Array<{
    pallet_number: number;
    lpn: string;
    pallet_type: string;
    box_count: number;
    /** Every box barcode registered on this pallet. Feeds the cross-worker
     *  duplicate guard; meat only, where catch-weight barcodes are unique. */
    barcodes?: string[];
  }>;
  status: 'planning' | 'active' | 'completed';
  created_at: string;
  /** User's preferred language. Set by the bot when creating the session. */
  language?: Language;
  /**
   * 'meat' (default) or 'non_meat'. A non-meat session (weight-based Type A)
   * mints an `NM-`-prefixed LPN and echoes `nonmeat_meta` back to the bot so
   * the received stock lands in the non-meat ledger.
   */
  category?: 'meat' | 'non_meat';
  nonmeat_meta?: {
    supplier_he?: string;
    supplier_en?: string;
    invoice_number?: string;
    invoice_date?: string;
    invoice_url?: string | null;
    session_id?: string;
  } | null;
  /**
   * Type A only: cartons of each invoice item already committed across earlier
   * pallets, keyed by `item_code` (or `he:<normalized hebrew name>` when no
   * code). Drives the per-pallet count pre-fill (remaining = invoice count −
   * committed) so an item split across pallets is never double-counted.
   */
  nonmeat_committed?: Record<string, number>;
  /**
   * Meat short-shipment / damaged-sticker feature switch (bot config
   * MEAT_DISCREPANCY_ENABLED). When true the meat scanner enables the
   * "Stickers damaged — enter counts" declared-count mode and stops
   * hard-blocking on unreadable boxes. Off/undefined → the meat flow renders
   * exactly as before, so in-flight sessions keep the old behaviour.
   */
  meat_discrepancy?: boolean;
  /**
   * Meat equivalent of `nonmeat_committed`: boxes of each invoice item already
   * committed via the damaged-sticker declared-count mode on earlier pallets,
   * keyed by `nonMeatItemKey` (item_code or `he:<normalized>`). Drives the
   * per-pallet "remaining" pre-fill in the manual-count flow. Only manual
   * (damaged) pallets contribute — normally-scanned pallets do not.
   */
  meat_committed?: Record<string, number>;
  /**
   * 'single' (default, and the shape of every pre-split session) keeps the
   * `current_pallet` cursor. 'split' replaces it with the `pallets` slot array.
   * Absent means single, so in-flight sessions are unaffected.
   */
  mode?: 'single' | 'split';
  /** Split only: the manager who planned the job. Receives the delivery summary. */
  owner_chat_id?: string;
  /** Split only: who is on this job and how much capacity each reserved. */
  roster?: RosterEntry[];
  /** Split only: one entry per pallet. Replaces `current_pallet`. */
  pallets?: PalletSlot[];
  /** Split only: the loose-box task, or null when the delivery has none. */
  loose?: LooseTask | null;
}

// ─── UI State Types ────────────────────────────────────────────────────────────

export interface ScanStoreState {
  scannedBarcodes: Map<string, ParsedBarcode>;
  scannedItems: ScannedItem[];
  isScanning: boolean;
  error: string | null;

  // Actions
  addScan: (barcode: string, data: ParsedBarcode, matchedItem: ScannedItem) => void;
  isDuplicate: (barcode: string) => boolean;
  setScanning: (scanning: boolean) => void;
  setError: (error: string | null) => void;
  clear: () => void;
}
