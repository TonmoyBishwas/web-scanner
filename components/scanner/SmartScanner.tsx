'use client';

import { useState } from 'react';
import { Html5QrcodeScanner } from './Html5QrcodeScanner';
import { ZXingScanner } from './ZXingScanner';
import type { ParsedBarcode, BoxStickerOCR } from '@/types';

interface SmartScannerProps {
  onBarcodeDetected: (barcode: string, data: ParsedBarcode, imageData?: string) => void;
  onManualCapture?: (imageData: string) => void;
  onImageCaptured?: (imageData: string, barcode: string) => void;  // Deprecated - use onBarcodeDetected
  scannedBarcodes: Map<string, ParsedBarcode>;
  ocrResults: Map<string, BoxStickerOCR>;
  onError?: (error: string) => void;
}

type ScannerType = 'html5-qrcode' | 'zxing';

/**
 * SmartScanner with fallback strategy:
 * 1. html5-qrcode (primary) - Best Chrome/Android WebView support
 * 2. zxing - Original implementation (fallback)
 *
 * NEW: Barcode detection now triggers immediate image capture
 */
export function SmartScanner({
  onBarcodeDetected,
  onManualCapture,
  onImageCaptured,
  scannedBarcodes,
  ocrResults,
  onError
}: SmartScannerProps) {
  const [scannerType, setScannerType] = useState<ScannerType>('html5-qrcode');

  const handleFallbackError = (error: string) => {
    console.error('[SmartScanner] Scanner error:', error);

    // Auto-fallback on certain errors
    const shouldFallback = error.includes('could not start video source') ||
                           error.includes('Camera') ||
                           error.includes('Permission') ||
                           error.includes('NotAllowedError');

    if (shouldFallback && scannerType === 'html5-qrcode') {
      console.log('[SmartScanner] Falling back to ZXing...');
      setScannerType('zxing');
      return;
    }

    onError?.(error);
  };

  switch (scannerType) {
    case 'html5-qrcode':
      return (
        <Html5QrcodeScanner
          onBarcodeDetected={onBarcodeDetected}
          onManualCapture={onManualCapture}
          onImageCaptured={onImageCaptured}
          scannedBarcodes={scannedBarcodes}
          ocrResults={ocrResults}
          onError={handleFallbackError}
        />
      );

    case 'zxing':
      return (
        <ZXingScanner
          onBarcodeDetected={onBarcodeDetected}
          onManualCapture={onManualCapture}
          scannedBarcodes={scannedBarcodes}
          onError={handleFallbackError}
        />
      );

    default:
      return (
        <Html5QrcodeScanner
          onBarcodeDetected={onBarcodeDetected}
          onManualCapture={onManualCapture}
          onImageCaptured={onImageCaptured}
          scannedBarcodes={scannedBarcodes}
          ocrResults={ocrResults}
          onError={handleFallbackError}
        />
      );
  }
}
