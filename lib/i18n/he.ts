/**
 * Hebrew translations.
 *
 * Must declare every key in `en.ts` — TypeScript's `Record<TranslationKey, string>`
 * constraint will fail the build if one is missing. Format placeholders
 * ({count}, {kg}, {lpn}, ...) MUST be preserved verbatim.
 *
 * Numbers, kg units, item names from OCR, supplier names, document
 * numbers, LPNs and barcodes stay in source form.
 */
import type { TranslationKey } from './en';

export const he: Record<TranslationKey, string> = {
  // ── Common ────────────────────────────────────────────────────────
  'common.loading': 'טוען…',
  'common.error': 'שגיאה',
  'common.cancel': 'ביטול',
  'common.confirm': 'אישור',
  'common.continue': 'המשך',
  'common.back': 'חזור',
  'common.retry': 'נסה שוב',
  'common.done': 'בוצע',
  'common.close': 'סגור',
  'common.boxes': 'קופסאות',
  'common.box': 'קופסה',
  'common.kg': 'kg',
  'common.unknown': 'לא ידוע',

  // ── Session / errors ──────────────────────────────────────────────
  'session.notFound': 'הסשן לא נמצא או פג תוקפו.',
  'session.expired': 'סשן הסריקה פג.',
  'session.loadError': 'טעינת הסשן נכשלה. רענן את הדף.',
  'errors.boxNotFound': 'הקופסה לא נמצאה במלאי.',
  'errors.boxAlreadyIssued': 'הקופסה הזו כבר הוצאה.',
  'errors.boxUnavailable': 'הקופסה כבר לא זמינה.',
  'errors.serverError': 'שגיאת שרת פנימית.',
  'errors.networkError': 'שגיאת רשת. בדוק את החיבור.',
  'errors.missingFields': 'חסרים שדות חובה.',

  // ── Scanner UI ────────────────────────────────────────────────────
  'scanner.cameraInit': 'מאתחל מצלמה…',
  'scanner.noCameras': 'לא זוהו מצלמות.',
  'scanner.unsupportedBrowser': 'דפדפן לא נתמך. פתח את הקישור ב-Chrome.',
  'scanner.requestingPermission': 'מבקש הרשאת מצלמה…',
  'scanner.permissionDenied': 'הרשאת מצלמה נדחתה. הקש אשר ונסה שוב.',
  'scanner.starting': 'מפעיל מצלמה…',
  'scanner.processingOcr': 'קורא תווית קופסה…',
  'scanner.scanComplete': 'הסריקה הושלמה',
  'scanner.scanned': 'נסרק',
  'scanner.scanningAs': 'סורק בתור:',
  'scanner.switchCamera': 'החלף מצלמה',
  'scanner.tapToScan': 'הקש לסריקה',
  'scanner.holdSteady': 'החזק יציב — הברקוד זוהה',

  // ── Pallet Verify ─────────────────────────────────────────────────
  'pallet.title': 'אימות משטח',
  'pallet.palletNumber': 'משטח {current} מתוך {total}',
  'pallet.boxCount.prompt': 'כמה קופסאות יש על המשטח?',
  'pallet.boxCount.placeholder': 'מספר קופסאות',
  'pallet.boxCount.confirm': 'אישור מספר',
  'pallet.boxCount.invalidNumber': 'הזן מספר תקין.',
  'pallet.scanInstructions': 'סרוק כל קופסה על המשטח.',
  'pallet.boxesScanned': '{scanned} מתוך {expected} קופסאות נסרקו',
  'pallet.alreadyScanned': 'הקופסה הזו כבר נסרקה.',
  'pallet.uniformPair.title': 'זוג קופסאות באותו משקל זוהה',
  'pallet.uniformPair.message': 'שתי קופסאות של {item} באותו משקל ({weight} kg). איזה סוג משטח זה?',
  'pallet.uniformPair.same': 'סיים כפריט-יחיד ({count} קופסאות)',
  'pallet.uniformPair.mix': 'המשך לסרוק (משטח מעורב)',
  'pallet.uniformPair.countPrompt': 'כמה קופסאות של {item}?',
  'pallet.uniformPair.maxBoxes': 'מקסימום {max} קופסאות.',
  'pallet.confirm.title': 'אישור משטח',
  'pallet.confirm.totalBoxes': 'סה״כ קופסאות: {count}',
  'pallet.confirm.totalWeight': 'משקל כולל: {weight} kg',
  'pallet.confirm.button': 'אשר משטח',
  'pallet.confirm.confirming': 'מאשר…',
  'pallet.complete.summary': 'משטח {n} הושלם — {boxes} קופסאות',
  'pallet.complete.next': 'משטח הבא',
  'pallet.complete.allDone': 'כל המשטחים הושלמו!',
  'pallet.complete.lpnReady': 'מדבקת LPN מוכנה',
  'pallet.complete.printLpn': 'הדפס מדבקת LPN',
  'pallet.complete.continueLoose': 'המשך לקופסאות בודדות',

  // ── OCR retry / failed UI ─────────────────────────────────────────
  'ocr.analyzing': 'מנתח…',
  'ocr.failed': 'OCR נכשל',
  'ocr.retry': 'נסה שוב',
  'ocr.viewPhoto': 'הצג תמונה',
  'ocr.rescan': 'סרוק שוב',
  'ocr.manualEntry': 'הזנה ידנית',

  // ── Loose box phase ───────────────────────────────────────────────
  'loose.title': 'קופסאות בודדות',
  'loose.instructions': 'סרוק {count} קופסאות בודדות. כל קופסה עשויה להיות פריט שונה.',
  'loose.scanned': 'נסרקו {scanned} מתוך {expected}',
  'loose.confirm': 'אישור קופסאות בודדות',
  'loose.confirming': 'מאשר…',

  // ── Issue page ────────────────────────────────────────────────────
  'issue.title': 'הוצאה לייצור',
  'issue.scanInstructions': 'סרוק ברקוד קופסה כדי לאתר אותה.',
  'issue.lookingUp': 'מאתר קופסה…',
  'issue.boxFound': 'הקופסה נמצאה',
  'issue.itemLabel': 'פריט:',
  'issue.weightLabel': 'משקל:',
  'issue.expiryLabel': 'תפוגה:',
  'issue.batchLabel': 'אצווה:',
  'issue.confirmIssue': 'הוצא קופסה',
  'issue.cancelIssue': 'ביטול',
  'issue.issuing': 'מוציא…',
  'issue.issued': 'הקופסה הוצאה.',
  'issue.scanNext': 'סרוק קופסה נוספת, או סגור בסיום.',
  'issue.allDone': 'סשן ההוצאה הושלם',
  'issue.totalIssued': 'סה״כ הוצאו: {count} קופסאות, {weight} kg',
  'issue.undo': 'בטל',
  'issue.undoing': 'מבטל…',
  'issue.undone': 'בוטל.',

  // ── Complete page ─────────────────────────────────────────────────
  'complete.title': 'הסריקה הושלמה',
  'complete.summary': 'סיכום',
  'complete.totalBoxes': 'סה״כ קופסאות: {count}',
  'complete.totalWeight': 'משקל כולל: {weight} kg',
  'complete.documentNumber': 'מסמך: {doc}',
  'complete.lpnList': 'מדבקות LPN',
  'complete.printAll': 'הדפס הכל',
  'complete.close': 'ניתן לסגור את החלון.',

  // ── LPN sticker page ──────────────────────────────────────────────
  'lpn.title': 'LPN למשטח',
  'lpn.itemLabel': 'פריט:',
  'lpn.boxesLabel': 'קופסאות:',
  'lpn.weightLabel': 'משקל:',
  'lpn.dateLabel': 'תאריך:',
  'lpn.scanToIssue': 'סרוק את הקוד כדי להוציא קופסאות מהמשטח הזה.',
};
