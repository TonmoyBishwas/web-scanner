'use client';

import { Html5QrcodeScanner } from './Html5QrcodeScanner';
import type { ParsedBarcode, BoxStickerOCR } from '@/types';

interface SmartScannerProps {
  onBarcodeDetected: (barcode: string, data: ParsedBarcode, imageData?: string) => void;
  onManualCapture?: (imageData: string) => void;
  scannedBarcodes: Map<string, ParsedBarcode>;
  ocrResults: Map<string, BoxStickerOCR>;
  onError?: (error: string) => void;
}

/**
 * SmartScanner - uses html5-qrcode for barcode scanning.
 * Barcode detection triggers immediate image capture.
 */
export function SmartScanner({
  onBarcodeDetected,
  onManualCapture,
  scannedBarcodes,
  ocrResults,
  onError
}: SmartScannerProps) {
  return (
    <Html5QrcodeScanner
      onBarcodeDetected={onBarcodeDetected}
      onManualCapture={onManualCapture}
      scannedBarcodes={scannedBarcodes}
      ocrResults={ocrResults}
      onError={onError}
    />
  );
}
