/**
 * Shared LPN sticker constants. Mirror of
 * `telegram-warehouse-bot/bot/services/sticker_image_service.py`.
 *
 * The marker is the visual signal both the printed sticker and the
 * Gemini classifier rely on to disambiguate LPN stickers from invoices
 * — don't change it without updating the bot's classifier prompt
 * (`bot/services/ocr_service.classify_sticker_or_invoice`).
 */
export const LPN_STICKER_MARKER = '🏭 WAREHOUSE-LPN ⬢';

/** Prefix on the QR payload's `sig` query param. Visible sentinel — anyone
 *  reading the URL can recognise it as a "warehouse pallet" signature. */
export const LPN_SIGNATURE_PREFIX = 'WHPL-';
