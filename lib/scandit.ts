/**
 * Scandit Web Data Capture SDK initialization and utilities
 *
 * Using npm packages with proper sdc-lib hosting
 */

import {
  DataCaptureContext,
  Camera,
  FrameSourceState,
  DataCaptureView,
} from "@scandit/web-datacapture-core";
import {
  BarcodeCapture,
  BarcodeCaptureSettings,
  barcodeCaptureLoader,
  BarcodeCaptureOverlay,
  Symbology,
} from "@scandit/web-datacapture-barcode";

export type {
  BarcodeCapture,
  BarcodeCaptureSettings,
  DataCaptureContext,
  DataCaptureView,
  Camera,
  FrameSourceState,
  Symbology,
  BarcodeCaptureOverlay,
};

/**
 * Check if running in a restricted browser environment
 */
export function checkBrowserCompatibility(): { compatible: boolean; reason?: string } {
  if (typeof window === 'undefined') {
    return { compatible: false, reason: 'Not running in browser' };
  }

  const ua = navigator.userAgent || '';

  // Check for Telegram in-app browser
  if (ua.includes('Telegram') || ua.includes('TelegramBot')) {
    return { compatible: false, reason: 'Telegram in-app browser does not support camera access. Please open this link in a regular browser (Chrome, Safari, Firefox).' };
  }

  // Check for WeChat
  if (ua.includes('MicroMessenger')) {
    return { compatible: false, reason: 'WeChat in-app browser does not support camera access. Please open this link in a regular browser.' };
  }

  // Check for Facebook in-app browser
  if (ua.includes('FBAN') || ua.includes('FBAV')) {
    return { compatible: false, reason: 'Facebook in-app browser may have camera restrictions. Please open in a regular browser.' };
  }

  // Check for Instagram
  if (ua.includes('Instagram')) {
    return { compatible: false, reason: 'Instagram in-app browser may have camera restrictions. Please open in a regular browser.' };
  }

  // Check for HTTPS
  if (window.location.protocol !== 'https:' && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
    return { compatible: false, reason: 'Camera access requires HTTPS. Please access this page via HTTPS.' };
  }

  return { compatible: true };
}

/**
 * Get the Scandit license key from environment
 */
export function getScanditLicenseKey(): string {
  if (typeof window !== 'undefined') {
    const key = (window as any).NEXT_PUBLIC_SCANDIT_LICENSE_KEY;
    if (!key) {
      throw new Error('Scandit license key not configured');
    }
    return key;
  }
  // Fallback for server-side
  const key = process.env.NEXT_PUBLIC_SCANDIT_LICENSE_KEY;
  if (!key) {
    throw new Error('Scandit license key not configured');
  }
  return key;
}

/**
 * Initialize Scandit DataCaptureContext with proper configuration
 * Uses the forLicenseKey API as per Scandit documentation
 */
export async function initDataCaptureContext(licenseKey: string): Promise<DataCaptureContext> {
  // Check if running in browser
  if (typeof window === 'undefined') {
    throw new Error('Scandit SDK can only be initialized in the browser');
  }

  // Initialize context using the documented API
  // libraryLocation points to the sdc-lib folder (served from public/sdc-lib)
  console.log('[Scandit] Initializing context with libraryLocation:', new URL('sdc-lib/', window.location.origin).toString());

  const context = await DataCaptureContext.forLicenseKey(licenseKey, {
    libraryLocation: new URL('sdc-lib/', window.location.origin).toString(),
    moduleLoaders: [barcodeCaptureLoader()],
  });

  console.log('[Scandit] Context initialized successfully');
  return context;
}

/**
 * Create barcode capture settings optimized for Israeli GS1-128 labels
 */
export function createBarcodeCaptureSettings(): BarcodeCaptureSettings {
  const settings = new BarcodeCaptureSettings();

  // Enable symbologies for Israeli meat labels
  const symbologies = [
    Symbology.Code128,    // GS1-128 - Main format for brown boxes
    Symbology.Code39,     // Alternative format
    Symbology.EAN13UPCA,  // Standard retail barcodes (EAN13 + UPC-A combined)
    Symbology.EAN8,       // Short retail barcodes
    Symbology.UPCE,       // UPC-E
    Symbology.DataMatrix, // 2D barcodes
    Symbology.QR          // QR codes
  ];

  settings.enableSymbologies(symbologies);

  // Continuous scanning - no trigger needed
  // This allows the scanner to detect barcodes automatically
  settings.codeDuplicateFilter = 1000; // 1 second between duplicate scans

  return settings;
}

/**
 * Create BarcodeCapture instance with context and settings
 * Uses the forContext API as per Scandit documentation
 */
export async function createBarcodeCapture(
  context: DataCaptureContext,
  settings: BarcodeCaptureSettings
): Promise<BarcodeCapture> {
  return await BarcodeCapture.forContext(context, settings);
}

/**
 * Get recommended camera settings for barcode capture
 */
export function getRecommendedCameraSettings() {
  return BarcodeCapture.recommendedCameraSettings;
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

/**
 * Create and configure DataCaptureView
 * Note: connectToElement is synchronous and needs to happen before setContext
 */
export function createDataCaptureView(
  containerElement: HTMLElement
): DataCaptureView {
  console.log('[Scandit] Creating DataCaptureView');
  console.log('[Scandit] Container element size:', containerElement.offsetWidth, 'x', containerElement.offsetHeight);
  const view = new DataCaptureView();
  console.log('[Scandit] Connecting view to element:', containerElement);
  view.connectToElement(containerElement);
  console.log('[Scandit] View connected to element');
  return view;
}

/**
 * Set context on an existing view
 */
export async function setViewContext(
  view: DataCaptureView,
  context: DataCaptureContext
): Promise<void> {
  console.log('[Scandit] Setting context on view');
  await view.setContext(context);
  console.log('[Scandit] View context set successfully');
}

/**
 * Create overlay for barcode capture visualization
 */
export async function createBarcodeCaptureOverlay(
  barcodeCapture: BarcodeCapture,
  view: DataCaptureView
): Promise<BarcodeCaptureOverlay> {
  console.log('[Scandit] Creating barcode capture overlay');
  const overlay = await BarcodeCaptureOverlay.withBarcodeCaptureForView(barcodeCapture, view);
  console.log('[Scandit] Overlay created successfully');
  return overlay;
}

/**
 * Pick the best available camera
 */
export function pickCamera(): Camera {
  console.log('[Scandit] Picking best camera');
  const camera = Camera.pickBestGuess();
  console.log('[Scandit] Camera picked, type:', (camera as any).type);
  console.log('[Scandit] Camera object:', camera);
  return camera;
}

/**
 * Test direct camera access (bypassing Scandit)
 */
export async function testDirectCameraAccess(): Promise<{ success: boolean; error?: string }> {
  console.log('[Scandit] Testing direct camera access...');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    console.log('[Scandit] Direct camera access SUCCESS!', stream);
    // Stop the test stream
    stream.getTracks().forEach(track => track.stop());
    return { success: true };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error('[Scandit] Direct camera access FAILED:', errorMsg);
    return { success: false, error: errorMsg };
  }
}

/**
 * Start the camera with detailed error handling
 */
export async function startCamera(context: DataCaptureContext): Promise<void> {
  console.log('[Scandit] Starting camera...');

  // First, test if browser allows camera access at all
  const testResult = await testDirectCameraAccess();
  if (!testResult.success) {
    throw new Error(`Browser camera access failed: ${testResult.error}. Please check camera permissions.`);
  }

  const frameSource = context.frameSource;
  console.log('[Scandit] Frame source:', frameSource ? 'found' : 'null');

  if (!frameSource) {
    throw new Error('Frame source is null. Camera may not be properly set.');
  }

  // Check if it's actually a camera frame source
  if ((frameSource as any).type !== 'camera') {
    console.error('[Scandit] Frame source type:', (frameSource as any).type);
    throw new Error('Frame source is not a camera type');
  }

  // Add listener to detect state changes
  const stateListener = {
    didChangeState: (frameSource: any, newState: FrameSourceState) => {
      console.log('[Scandit] Camera state changed to:', newState);
    }
  };

  frameSource.addListener(stateListener);

  try {
    console.log('[Scandit] Switching camera On...');
    const currentState = frameSource.getCurrentState();
    console.log('[Scandit] Current camera state before switch:', currentState);

    await frameSource.switchToDesiredState('On' as FrameSourceState);
    console.log('[Scandit] Camera switched to On successfully (promise resolved)');

    // Wait and check the state
    await new Promise(resolve => setTimeout(resolve, 1000));
    const newState = frameSource.getCurrentState();
    console.log('[Scandit] Camera state after start:', newState);

    if (newState === 'off') {
      throw new Error(`Camera failed to start. State is still '${newState}' after calling switchToDesiredState('On'). This may indicate a browser compatibility issue or missing permissions.`);
    }
  } catch (error) {
    console.error('[Scandit] Failed to switch camera On:', error);
    throw error;
  }
}
