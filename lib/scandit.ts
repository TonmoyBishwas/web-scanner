/**
 * Scandit Web Data Capture SDK initialization and utilities
 *
 * This module provides a wrapper around the Scandit SDK for barcode scanning.
 * The SDK is loaded dynamically to avoid SSR issues.
 */

import * as BarcodeModule from '@scandit/web-datacapture-barcode';
import * as CoreModule from '@scandit/web-datacapture-core';

export type ScanditSDK = {
  BarcodeCapture: any;
  BarcodeCaptureSettings: any;
  BarcodeCaptureOverlay: any;
  DataCaptureContext: any;
  DataCaptureView: any;
  Camera: any;
  FrameSourceState: any;
  Symbology: any;
  RectangularViewfinder: any;
  RectangularViewfinderStyle: any;
};

let scanditSDK: ScanditSDK | null = null;
let loadPromise: Promise<ScanditSDK> | null = null;

/**
 * Dynamically load the Scandit SDK
 */
export async function loadScanditSDK(): Promise<ScanditSDK> {
  if (scanditSDK) {
    return scanditSDK;
  }

  if (loadPromise) {
    return loadPromise;
  }

  loadPromise = (async () => {
    // Use the pre-imported modules
    scanditSDK = {
      BarcodeCapture: BarcodeModule.BarcodeCapture,
      BarcodeCaptureSettings: BarcodeModule.BarcodeCaptureSettings,
      BarcodeCaptureOverlay: BarcodeModule.BarcodeCaptureOverlay,
      DataCaptureContext: CoreModule.DataCaptureContext,
      DataCaptureView: CoreModule.DataCaptureView,
      Camera: CoreModule.Camera,
      FrameSourceState: CoreModule.FrameSourceState,
      Symbology: BarcodeModule.Symbology,
      RectangularViewfinder: CoreModule.RectangularViewfinder,
      RectangularViewfinderStyle: CoreModule.RectangularViewfinderStyle
    };

    return scanditSDK;
  })();

  return loadPromise;
}

/**
 * Get the Scandit license key from environment
 */
export function getScanditLicenseKey(): string {
  const key = process.env.NEXT_PUBLIC_SCANDIT_LICENSE_KEY;
  if (!key) {
    throw new Error('Scandit license key not configured');
  }
  return key;
}

/**
 * Initialize Scandit DataCaptureContext
 */
export async function initDataCaptureContext(licenseKey: string) {
  const { DataCaptureContext } = await loadScanditSDK();
  // In Scandit 8.x, use create() method
  return DataCaptureContext.create(licenseKey);
}

/**
 * Create barcode capture settings optimized for Israeli GS1-128 labels
 */
export async function createBarcodeCaptureSettings() {
  const { BarcodeCaptureSettings, Symbology } = await loadScanditSDK();

  const settings = new BarcodeCaptureSettings();

  // Enable symbologies for Israeli meat labels
  const symbologies = [
    Symbology.Code128,    // GS1-128 - Main format for brown boxes
    Symbology.Code39,     // Alternative format
    Symbology.EAN13,      // Standard retail barcodes
    Symbology.EAN8,       // Short retail barcodes
    Symbology.Upca,       // UPC-A
    Symbology.DataMatrix, // 2D barcodes
    Symbology.QR          // QR codes
  ];

  for (const symbology of symbologies) {
    settings.enableSymbology(symbology, true);
  }

  // Continuous scanning - no trigger needed
  // This allows the scanner to detect barcodes automatically
  settings.codeDuplicateFilter = 1000; // 1 second between duplicate scans

  return settings;
}

/**
 * Check if device supports camera access
 */
export function checkCameraSupport(): { supported: boolean; error?: string } {
  if (typeof navigator === 'undefined') {
    return { supported: false, error: 'Navigator not available' };
  }

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return { supported: false, error: 'Camera access not supported' };
  }

  return { supported: true };
}

/**
 * Request camera permissions
 */
export async function requestCameraPermission(): Promise<boolean> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    // Stop the stream immediately - we just needed permission
    stream.getTracks().forEach((track) => track.stop());
    return true;
  } catch (error) {
    console.error('Camera permission error:', error);
    return false;
  }
}
