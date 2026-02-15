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

// UI State Types
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
