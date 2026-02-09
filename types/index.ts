// Barcode Data Types
export interface ParsedBarcode {
  type: 'id-only' | '31-digit' | '25-digit' | 'short' | 'unknown';
  sku: string;  // Just the ID - barcode is identifier only
  weight: number;  // Always 0 - comes from OCR only
  expiry: string;  // Always empty - comes from OCR only
  raw_barcode: string;
  expiry_source: 'ocr_required';  // Always requires OCR
}

// OCR result from box sticker
export interface BoxStickerOCR {
  productNameHebrew: string;
  productNameEnglish: string;
  sku: string;
  netWeightKG: number;
  expiryDate: string;  // DD/MM/YYYY or empty
  productionDate?: string;
  barcode: string;
  storageTemperature?: string;
  supplier?: string;
  confidence: 'high' | 'medium' | 'low';
  weightMatch?: boolean;  // Does weight match barcode?
  expiryMatch?: boolean;  // Does expiry match barcode?
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
  // Barcode is JUST an identifier
  barcode: string;              // Raw barcode string (any length)

  // All data comes from OCR or manual entry
  scanned_at: string;
  item_index: number;

  // Image storage (REQUIRED for all scans)
  image_url: string;            // Cloudinary URL (required)
  image_public_id: string;      // Cloudinary public ID

  // OCR results (primary data source)
  ocr_data?: BoxStickerOCR;
  ocr_processed_at?: string;
  ocr_status: 'pending' | 'complete' | 'failed' | 'manual';

  // Manual entry fallback
  manual_entry?: {
    item_index: number;
    weight: number;
    expiry: string;
    notes?: string;
  };

  // Metadata
  scan_method: 'barcode' | 'manual_capture' | 'manual_entry';
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
  invoice_image_url?: string;  // URL of uploaded invoice image
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
  image_url?: string;  // Cloudinary URL (now required for all scans)
  image_public_id?: string;  // Cloudinary public ID
  detected_at: string;
  document_number?: string;  // Invoice document number for folder structure
  scan_method?: 'barcode' | 'manual_capture' | 'manual_entry';
}

// Manual Entry Data
export interface ManualEntryData {
  token: string;
  item_index: number;
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
  image?: string;  // base64 image (deprecated)
  image_url?: string;  // Cloudinary URL (preferred)
  barcode: string;
}

export interface OCRResponse {
  success: boolean;
  ocr_data?: BoxStickerOCR;
  error?: string;
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
