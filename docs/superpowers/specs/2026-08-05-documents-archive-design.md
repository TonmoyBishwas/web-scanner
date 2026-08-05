# Documents Archive (מסמכים) — Design Spec

**Date**: 2026-08-05 · **Status**: Approved by user · **Scope**: web-scanner only (no bot changes, no schema changes)

Unlocks the מסמכים side-drawer screen on all three scanner pages (#2 in the locked-features
queue, after the Pallets browser). Primary job: **browse completed delivery documents** —
invoice photo, parsed lines, and what actually happened (pallets, discrepancies).

## What counts as a document

**Completed deliveries only** (user decision — no abandoned/retried OCR noise):
- **Meat**: one document per `deliveries` row.
- **Non-meat**: one document per distinct `non_meat_inventory.session_id` (Type A and Type B).
- `invoice_ocr_results` is used ONLY as a photo fallback (via `delivery_id`) for old meat
  deliveries missing `invoice_image_url`. Unlinked OCR attempts never appear.
- Type B voice delivery notes are NOT standalone documents — they render inside their
  non-meat document's detail (🎤 marker on the card).

## UI

### Entry
- The מסמכים item in the side drawer (`DrawerHost`, all 3 scanner pages) opens a full-screen
  `DocumentsBrowser` overlay (`ScreenOverlay` chrome), replacing `DocsScreenLocked`.
  No new route. `DocsScreenLocked.tsx` is deleted.

### List screen (keeps the locked mock's layout)
- Header: search field + calendar button + filter chips **הכל / בשר / לא-בשר** (All/Meat/Non-meat).
- Search (debounced) matches document number, supplier Hebrew/English, and item names.
- Calendar button opens a **month picker** — only months that actually have documents;
  tap to filter, tap again (or "clear") to remove.
- Cards newest-first (received date), 30/page + "load more":
  - Thumbnail 46×58: real invoice photo (`object-cover`) when `invoice_image_url` exists,
    else the mock's paper `DocThumb`.
  - Category badge: meat (blue) / non-meat (green); doc number (mono, LTR); supplier
    (Hebrew, EN fallback); date; line count; 🎤 marker when a voice note is attached.

### Detail screen
- Header: doc number, category badge, supplier, invoice date, received date.
- **Photo**: invoice image inline (fit-width); tap opens full-size in a new tab.
- **Lines**: Hebrew name (EN fallback), invoice qty (kg or units). Meat lines with
  discrepancy data show received vs invoice + amber "פער" chip when `discrepancy_status`
  is Short/Over. Non-meat lines show `has_discrepancy`/reason.
- **Outcome**: pallets created for this delivery as tappable rows (LPN, type, box count,
  status) — each opens that pallet in the existing **PalletsBrowser detail**
  (reuses `/api/pallets/detail`).
- **Voice note** (Type B only): collapsed section with transcript, understood counts
  (pallets/boxes/solo), discrepancy notes.

## API (2 new routes, service-role, server-side, in `lib/documents.ts` + `app/api/documents/`)

Both guarded by the existing `assertValidSession(token)` (`lib/session-guard.ts` — any live
`scan_sessions` token). Invalid/expired → 401 → localized session-expired message in the overlay.

- `GET /api/documents?token&q&category&month&page`
  - Sources fetched per request and normalized to one card shape:
    - Meat: `deliveries` + line count/names from `delivery_items` (`receipt_id`), photo
      fallback from `invoice_ocr_results.invoice_image_url` (`delivery_id`).
    - Non-meat: `non_meat_inventory` grouped by `session_id` (supplier, invoice number/date,
      image, line names from the rows) + `voice_note_id IS NOT NULL` → 🎤 flag.
  - `category`: `all` (default) | `meat` | `non_meat`. `month`: `YYYY-MM`.
  - Filtering/search/month in JS in the route (archive is ~40 docs today); response is still
    paginated: `{ documents, months, hasMore }` (`months` = distinct YYYY-MM list for the picker).
  - Document identity: `{ source: 'meat' | 'non_meat', id }` — delivery uuid or NM `session_id`.
- `GET /api/documents/detail?token&source&id`
  - Meat: delivery header + `delivery_items` (invoice vs received qty/boxes,
    `discrepancy_status`/`discrepancy_note`) + `pallets` by `receipt_id`.
  - Non-meat: session header + `non_meat_inventory` lines + pallets via the rows'
    `pallet_id`s + linked `nonmeat_delivery_notes` row (transcript, counts) when present.
  - Pallet rows include the pallet `id` for the PalletsBrowser hand-off.

## Error handling
- API/network failure → toast; list keeps last data, retry possible.
- 401 → localized "session expired" inside the overlay.
- Missing/broken image URL → paper-thumb fallback on the card; image block hidden in detail.

## Out of scope (phase 1)
- No editing/deleting documents, no upload from the scanner.
- No PDF export or share.
- No abandoned-OCR "drafts" view (explicit user decision).
- No standalone `/documents` route.

## Testing / shipping
- `npm run lint` + `npm run build`; visual verification on a Vercel preview against live DB
  (seeded `scan_sessions` token + per-deployment share-link recipe from the pallets-browser work).
- Lands on `preview` only. Production ship = explicit user decision
  (graph-mirror merge to `main` deploys Vercel prod).
