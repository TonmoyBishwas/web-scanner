# Pallets Browser (משטחים) — Design Spec

**Date**: 2026-08-04 · **Status**: Approved by user · **Scope**: web-scanner only (no bot changes, no schema changes)

Unlocks the משטחים tool-dock chip on all three scanner pages. Primary job: **floor lookup** —
a worker checks what's on a pallet / how many boxes remain before walking to it.

## UI

### Entry
- The משטחים chip (currently `locked: true` on `scan/[token]`, `issue/[token]`, `pallet-verify/[token]`)
  opens a full-screen `PalletsBrowser` overlay (`ScreenOverlay` chrome, z-90), same pattern as
  Settings/Documents. No new route.

### List screen
- Pallet cards newest-first, 30/page + "load more".
- Card: LPN (mono, LTR), status chip (Receiving/In Stock/Partially Issued/Empty, color-coded),
  type badge (Single/Mix/Loose/NM), item name ("Mix — N items" for mixes), remaining/expected
  boxes, total weight kg, received date, document number.
- Default filter: **active only** (Receiving + In Stock + Partially Issued), all categories
  (meat, non-meat, Loose). Filter chips: Active / In Stock / Partially Issued / Empty / All.
- Search: debounced text matching LPN, Hebrew/English item name, document number.
- **Scan-to-find**: camera button in the search bar opens SmartScanner in a modal
  (empty scannedBarcodes/ocrResults maps). Decoded payload:
  - contains `/sticker/v1/{lpn}` or matches `(NM-)?LPN-…` / `LOOSE-…` → open that pallet's detail.
  - ≥13-digit numeric → look up `box_inventory.box_sku` → open owning pallet's detail.
  - otherwise → "not found" toast.

### Detail screen
- Header: LPN, status, type, document number, received date, total weight.
- Per-item rows: Hebrew name (EN fallback), **remaining/expected boxes**, avg box weight,
  total kg, earliest real `box_expiry` where present.
- Remaining logic mirrors the bot:
  - uniform items → `expected_box_count − issued box rows` (never the 2 stored samples);
  - non-uniform → count of `box_inventory` rows with status `Available`;
  - NM pallets → `non_meat_inventory` rows by `pallet_id` (`remaining_box_count`, `remaining_quantity`).
- Action: "פתח מדבקה" opens `/sticker/v1/{lpn}` in a new tab. Everything else read-only.

## API (2 new routes, service-role, server-side)

- `GET /api/pallets?token&q&status&barcode&page`
  - `status`: `active` (default) | `in_stock` | `partial` | `empty` | `all`.
  - `barcode`: box_sku lookup path; returns the owning pallet (list of 1) or empty.
  - Returns `{ pallets: [...card fields...], hasMore }`.
- `GET /api/pallets/detail?token&id`
  - Returns pallet header + per-item rows with the aggregates above (NM/Loose branches).
- **Auth**: both require `token` to match an unexpired `scan_sessions` row (any kind) via a
  shared `assertValidSession(token)` helper. Invalid/expired → 401 → UI shows session-expired.

## Error handling
- API/network failure → toast + retry stays possible (list keeps last data).
- 401 → localized "session expired" message inside the overlay.
- Camera failure in scan modal → error text, worker can still type-search.

## Out of scope (phase 1)
- No issuing/editing from this screen; outbound stays in the WhatsApp bot.
- No issue history on Empty pallets, no print pipeline beyond the sticker page.
- No standalone `/pallets` route (can wrap the component later if needed).

## Testing / shipping
- `npm run lint` + `npm run build` locally; visual verification on a Vercel preview deploy.
- Work lands on `preview` only. Production ship = explicit user decision
  (graph-mirror merge to `main` deploys Vercel prod).
