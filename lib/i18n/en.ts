/**
 * English translations — canonical source.
 *
 * Add a new key here AND in he.ts (TypeScript will fail the build if
 * he.ts is missing one). Format placeholders use the `{name}` syntax
 * — values like `{count}`, `{kg}`, `{lpn}`, item names from OCR, and
 * supplier names stay in source form across languages.
 */
export const en = {
  // ── Common ────────────────────────────────────────────────────────
  'common.loading': 'Loading…',
  'common.error': 'Error',
  'common.cancel': 'Cancel',
  'common.confirm': 'Confirm',
  'common.continue': 'Continue',
  'common.back': 'Back',
  'common.retry': 'Retry',
  'common.done': 'Done',
  'common.close': 'Close',
  'common.boxes': 'boxes',
  'common.box': 'box',
  'common.kg': 'kg',
  'common.unknown': 'Unknown',

  // ── Session / errors ──────────────────────────────────────────────
  'session.notFound': 'Session not found or expired.',
  'session.expired': 'This scan session has expired.',
  'session.loadError': 'Failed to load session. Please try refreshing.',
  'errors.boxNotFound': 'Box not found in inventory.',
  'errors.boxAlreadyIssued': 'This box has already been issued.',
  'errors.boxUnavailable': 'Box is no longer available.',
  'errors.serverError': 'Internal server error.',
  'errors.networkError': 'Network error. Check your connection.',
  'errors.missingFields': 'Missing required fields.',

  // ── Scanner UI (SmartScanner.tsx + scan pages) ────────────────────
  'scanner.cameraInit': 'Camera initializing…',
  'scanner.noCameras': 'No cameras detected.',
  'scanner.unsupportedBrowser': 'Unsupported browser. Please open this link in Chrome.',
  'scanner.requestingPermission': 'Requesting camera permission…',
  'scanner.permissionDenied': 'Camera permission denied. Tap allow and try again.',
  'scanner.starting': 'Starting camera…',
  'scanner.processingOcr': 'Reading box label…',
  'scanner.scanComplete': 'Scan complete',
  'scanner.scanned': 'Scanned',
  'scanner.scanningAs': 'Scanning as:',
  'scanner.switchCamera': 'Switch camera',
  'scanner.tapToScan': 'Tap to scan',
  'scanner.holdSteady': 'Hold steady — barcode detected',

  // ── Pallet Verify (heaviest page) ─────────────────────────────────
  'pallet.title': 'Pallet Verification',
  'pallet.palletNumber': 'Pallet {current} of {total}',
  'pallet.boxCount.prompt': 'How many boxes on this pallet?',
  'pallet.boxCount.placeholder': 'Box count',
  'pallet.boxCount.confirm': 'Confirm count',
  'pallet.boxCount.invalidNumber': 'Please enter a valid number.',
  'pallet.scanInstructions': 'Scan each box on the pallet.',
  'pallet.boxesScanned': '{scanned} of {expected} boxes scanned',
  'pallet.alreadyScanned': 'This box was already scanned.',
  'pallet.uniformPair.title': 'Uniform-weight pair detected',
  'pallet.uniformPair.message': 'Two boxes of {item} have the same weight ({weight} kg). What kind of pallet is this?',
  'pallet.uniformPair.same': 'Complete as single-item ({count} boxes)',
  'pallet.uniformPair.mix': 'Continue scanning (mix pallet)',
  'pallet.uniformPair.countPrompt': 'How many boxes of {item}?',
  'pallet.uniformPair.maxBoxes': 'Maximum {max} boxes allowed.',
  'pallet.confirm.title': 'Confirm pallet',
  'pallet.confirm.totalBoxes': 'Total boxes: {count}',
  'pallet.confirm.totalWeight': 'Total weight: {weight} kg',
  'pallet.confirm.button': 'Confirm pallet',
  'pallet.confirm.confirming': 'Confirming…',
  'pallet.complete.summary': 'Pallet {n} complete — {boxes} boxes',
  'pallet.complete.next': 'Next pallet',
  'pallet.complete.allDone': 'All pallets complete!',
  'pallet.complete.lpnReady': 'LPN sticker ready',
  'pallet.complete.printLpn': 'Print LPN sticker',
  'pallet.complete.continueLoose': 'Continue to loose boxes',

  // ── OCR retry / failed UI ─────────────────────────────────────────
  'ocr.analyzing': 'Analyzing…',
  'ocr.failed': 'OCR failed',
  'ocr.retry': 'Retry',
  'ocr.viewPhoto': 'View photo',
  'ocr.rescan': 'Rescan',
  'ocr.manualEntry': 'Manual entry',

  // ── Loose box phase ───────────────────────────────────────────────
  'loose.title': 'Loose boxes',
  'loose.instructions': 'Scan {count} loose box(es). Each box may be a different item.',
  'loose.scanned': 'Scanned {scanned} of {expected}',
  'loose.confirm': 'Confirm loose boxes',
  'loose.confirming': 'Confirming…',

  // ── Issue page ────────────────────────────────────────────────────
  'issue.title': 'Issue to Production',
  'issue.scanInstructions': 'Scan a box barcode to look it up.',
  'issue.lookingUp': 'Looking up box…',
  'issue.boxFound': 'Box found',
  'issue.itemLabel': 'Item:',
  'issue.weightLabel': 'Weight:',
  'issue.expiryLabel': 'Expiry:',
  'issue.batchLabel': 'Batch:',
  'issue.confirmIssue': 'Issue this box',
  'issue.cancelIssue': 'Cancel',
  'issue.issuing': 'Issuing…',
  'issue.issued': 'Box issued.',
  'issue.scanNext': 'Scan another box, or close when done.',
  'issue.allDone': 'Issue session complete',
  'issue.totalIssued': 'Total issued: {count} boxes, {weight} kg',
  'issue.undo': 'Undo',
  'issue.undoing': 'Undoing…',
  'issue.undone': 'Undone.',

  // ── Complete page ─────────────────────────────────────────────────
  'complete.title': 'Scan Complete',
  'complete.summary': 'Summary',
  'complete.totalBoxes': 'Total boxes: {count}',
  'complete.totalWeight': 'Total weight: {weight} kg',
  'complete.documentNumber': 'Document: {doc}',
  'complete.lpnList': 'LPN stickers',
  'complete.printAll': 'Print all',
  'complete.close': 'You can close this window.',

  // ── LPN sticker page ──────────────────────────────────────────────
  'lpn.title': 'Pallet LPN',
  'lpn.itemLabel': 'Item:',
  'lpn.boxesLabel': 'Boxes:',
  'lpn.weightLabel': 'Weight:',
  'lpn.dateLabel': 'Date:',
  'lpn.scanToIssue': 'Scan this code to issue boxes from this pallet.',
} as const;

export type TranslationKey = keyof typeof en;
