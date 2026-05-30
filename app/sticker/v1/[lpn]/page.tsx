/**
 * Alias route — `/sticker/v1/{lpn}` resolves to the same print page as
 * `/pallet/{lpn}`. This is the URL embedded in new printed-sticker QR
 * payloads (post LPN_SECRET rollout). The legacy `/pallet/{lpn}` route
 * stays alive so old physical stickers still scan to a working page.
 *
 * Re-exports the existing component as-is — no duplication of fetch /
 * render logic.
 */
export { default, generateMetadata } from '../../../pallet/[lpn]/page';
