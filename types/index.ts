// Barcode Data Types
export interface ParsedBarcode {
  type: 'Standard' | 'Variable';
  sku: string;
  weight: number;
  expiry: string;
  raw_barcode: string;
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
  barcode: string;
  sku: string;
  weight: number;
  expiry: string;
  scanned_at: string;
  item_index: number;
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
  detected_at: string;
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
