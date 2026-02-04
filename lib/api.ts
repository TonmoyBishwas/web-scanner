import type {
  ScanSession,
  SessionResponse,
  ScanRequest,
  ScanResponse,
  CompleteRequest,
  CompleteResponse,
  InvoiceItem,
  OCRRequest,
  OCRResponse
} from '@/types';

const API_BASE = process.env.NEXT_PUBLIC_APP_URL || '';

/**
 * API Client for communicating with the web scanner backend
 */
export class ScannerAPIClient {
  private baseUrl: string;

  constructor(baseUrl: string = API_BASE) {
    this.baseUrl = baseUrl;
  }

  /**
   * Create or get a scan session
   */
  async createSession(params: {
    chat_id: string;
    operation_type: string;
    invoice_items: InvoiceItem[];
    document_number: string;
  }): Promise<SessionResponse> {
    const response = await fetch(`${this.baseUrl}/api/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    });

    if (!response.ok) {
      throw new Error(`Failed to create session: ${response.statusText}`);
    }

    return response.json();
  }

  /**
   * Get session details
   */
  async getSession(token: string): Promise<ScanSession> {
    const response = await fetch(`${this.baseUrl}/api/session?token=${encodeURIComponent(token)}`);

    if (!response.ok) {
      throw new Error(`Failed to get session: ${response.statusText}`);
    }

    return response.json();
  }

  /**
   * Submit a scan
   */
  async submitScan(request: ScanRequest): Promise<ScanResponse> {
    const response = await fetch(`${this.baseUrl}/api/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request)
    });

    if (!response.ok) {
      throw new Error(`Failed to submit scan: ${response.statusText}`);
    }

    return response.json();
  }

  /**
   * Mark session as complete
   */
  async completeSession(request: CompleteRequest): Promise<CompleteResponse> {
    const response = await fetch(`${this.baseUrl}/api/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request)
    });

    if (!response.ok) {
      throw new Error(`Failed to complete session: ${response.statusText}`);
    }

    return response.json();
  }

  /**
   * Get invoice items for a session
   */
  async getInvoiceItems(token: string): Promise<InvoiceItem[]> {
    const session = await this.getSession(token);
    return session.invoice_items;
  }

  /**
   * Submit OCR image for processing
   */
  async submitOCR(request: OCRRequest): Promise<OCRResponse> {
    const response = await fetch(`${this.baseUrl}/api/ocr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request)
    });

    if (!response.ok) {
      throw new Error(`Failed to submit OCR: ${response.statusText}`);
    }

    return response.json();
  }
}

// Singleton instance
export const scannerAPI = new ScannerAPIClient();
