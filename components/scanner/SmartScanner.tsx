'use client';

import { useEffect, useState, useRef } from 'react';
import { Html5QrcodeScanner } from './Html5QrcodeScanner';
import type { ParsedBarcode, BoxStickerOCR } from '@/types';
import { parseIsraeliBarcode } from '@/lib/barcode-parser';

interface SmartScannerProps {
  onBarcodeDetected: (barcode: string, data: ParsedBarcode, imageData?: string) => void;
  onManualCapture?: (imageData: string) => void;
  scannedBarcodes: Map<string, ParsedBarcode>;
  ocrResults: Map<string, BoxStickerOCR>;
  onError?: (error: string) => void;
  onScannerTypeDetected?: (type: 'native' | 'fallback') => void;
}

// Declare BarcodeDetector types
declare global {
  interface Window {
    BarcodeDetector: any;
  }
}

/**
 * SmartScanner - intelligently selects scanner:
 * 1. Try native BarcodeDetector API (hardware accelerated, instant like Play Store apps)
 * 2. Fall back to html5-qrcode (software, slower but works everywhere)
 */
export function SmartScanner({
  onBarcodeDetected,
  onManualCapture,
  scannedBarcodes,
  ocrResults,
  onError,
  onScannerTypeDetected
}: SmartScannerProps) {
  const [useNative, setUseNative] = useState<boolean | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animationFrameRef = useRef<number>(0);
  const lastScannedRef = useRef<string>('');
  const lastScanTimeRef = useRef<number>(0);
  const isMountedRef = useRef(true);

  useEffect(() => {
    // Check if native BarcodeDetector is available
    if (typeof window !== 'undefined' && 'BarcodeDetector' in window) {
      console.log('[SmartScanner] Native BarcodeDetector API available - using hardware scanner!');
      setUseNative(true);
      onScannerTypeDetected?.('native');
    } else {
      console.log('[SmartScanner] Native API not available - falling back to html5-qrcode');
      setUseNative(false);
      onScannerTypeDetected?.('fallback');
    }

    return () => {
      isMountedRef.current = false;
      stopNativeScanning();
    };
  }, []);

  const stopNativeScanning = () => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
  };

  const startNativeScanning = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });

      streamRef.current = stream;

      if (videoRef.current && isMountedRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        scanContinuously();
      }
    } catch (err) {
      console.error('[SmartScanner] Camera error:', err);
      onError?.(err instanceof Error ? err.message : String(err));
    }
  };

  const scanContinuously = async () => {
    if (!videoRef.current || !canvasRef.current || !isMountedRef.current) return;

    const video = videoRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Create BarcodeDetector instance
    const barcodeDetector = new window.BarcodeDetector({
      formats: [
        'code_128',
        'code_39',
        'ean_13',
        'ean_8',
        'upc_a',
        'upc_e',
        'qr_code',
        'data_matrix',
      ],
    });

    const detect = async () => {
      if (!isMountedRef.current) return;

      if (!video.readyState || video.readyState < 2) {
        animationFrameRef.current = requestAnimationFrame(detect);
        return;
      }

      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      try {
        const barcodes = await barcodeDetector.detect(canvas);

        if (barcodes.length > 0) {
          const barcode = barcodes[0].rawValue;
          const now = Date.now();

          // Debounce: same barcode within 2 seconds
          if (barcode !== lastScannedRef.current || now - lastScanTimeRef.current > 2000) {
            lastScannedRef.current = barcode;
            lastScanTimeRef.current = now;

            // Vibrate on detection
            if ('vibrate' in navigator) {
              navigator.vibrate(100);
            }

            // Parse barcode
            const parsedData = parseIsraeliBarcode(barcode) || {
              type: 'unknown',
              sku: barcode,
              weight: 0,
              expiry: '',
              raw_barcode: barcode,
              expiry_source: 'ocr_required' as const
            };

            // Capture image for OCR
            const imageData = canvas.toDataURL('image/jpeg', 0.8);
            onBarcodeDetected(barcode, parsedData, imageData);
          }
        }
      } catch (err) {
        console.error('[SmartScanner] Detection error:', err);
      }

      animationFrameRef.current = requestAnimationFrame(detect);
    };

    detect();
  };

  useEffect(() => {
    if (useNative === true) {
      startNativeScanning();
    }
  }, [useNative]);

  // Loading state
  if (useNative === null) {
    return (
      <div className="w-full aspect-square bg-gray-800 rounded-lg flex items-center justify-center">
        <p className="text-gray-400">Initializing scanner...</p>
      </div>
    );
  }

  // Use native scanner (hardware accelerated!)
  if (useNative) {
    console.log('🚀 [SmartScanner] USING NATIVE HARDWARE BARCODE SCANNER (60 FPS - like Play Store apps!)');
    return (
      <div className="relative w-full aspect-square bg-black rounded-lg overflow-hidden">
        <video
          ref={videoRef}
          className="absolute inset-0 w-full h-full object-cover"
          playsInline
          muted
        />
        <canvas ref={canvasRef} className="hidden" />

        {/* Minimal scanning indicator */}
        <div className="absolute inset-0 pointer-events-none">
          {/* Target box */}
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-72 h-72 border-4 border-green-400 rounded-lg animate-pulse" />
          </div>
          {/* Small indicator that native scanner is active */}
          <div className="absolute top-2 left-2">
            <div className="flex items-center gap-1 bg-green-600/80 px-2 py-1 rounded-full">
              <div className="w-2 h-2 bg-green-300 rounded-full animate-pulse"></div>
              <span className="text-white text-xs font-medium">⚡</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Fallback to html5-qrcode
  console.log('📱 [SmartScanner] Native scanner not available - using html5-qrcode fallback');
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

