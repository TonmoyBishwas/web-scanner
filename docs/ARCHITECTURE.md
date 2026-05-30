# Web Scanner Architecture

## Overview
The Web Scanner is a Next.js 16 application designed to provide a high-performance, mobile-first barcode scanning interface for the warehouse management system. It serves three flows: carton inbound (RECEIVE), carton outbound (ISSUE), and pallet inbound (PALLET VERIFY — including loose box scanning).

## Branch & Deployment

- **Active branch**: `pallet-flow` (off `main`)
- **Vercel deploys from**: `pallet-flow`
- Production URL served from Vercel (automatic on push to `pallet-flow`)

## Tech Stack
- **Framework**: Next.js 16 (App Router)
- **Language**: TypeScript
- **Styling**: Tailwind CSS (via `globals.css`)
- **State Management**: React Hooks (`useState`, `useReducer`, `useRef`) + URL State
- **Database/Cache**: Redis (Upstash) for session management
- **Scanning Library**: Native BarcodeDetector API (hardware-accelerated); fallback: html5-qrcode (@zxing/browser)
- **Image Storage**: Cloudinary (via API proxy)

## Core Components

### 1. `app/scan/[token]/page.tsx`
The heart of the carton scanning workflow.
- **State Machine**: Manages phases: `scanning` -> `processing` -> `issues` -> `ready_confirm` -> `complete`.
- **Hardware Access**: Manages camera permissions and stream.
- **Optimistic UI**: Updates counts and lists immediately while syncing with the server in the background.
- **Polling**: Periodically fetches session status from `/api/session` to sync with backend OCR processes.

### 2. `components/scanner/SmartScanner.tsx`
A wrapper around the native BarcodeDetector API that handles:
- Camera enumeration and selection (back camera preferred by label detection).
- Camera switching for devices with multiple cameras.
- Multi-read validation: requires 3 consecutive identical reads within 2 seconds before confirming a barcode.
- GS1-128 format validation (25 or 31 digit barcodes).
- A 3-second cooldown after each confirmed scan.
- Duplicate detection and visual feedback.
- `onBarcodeDetected(barcode, parsedData, imageData)` — 3rd arg is `canvas.toDataURL('image/jpeg', 0.8)` captured at detection time. Used for immediate OCR without separate photo step.

**`key` prop is REQUIRED across phase transitions.** SmartScanner caches
`onBarcodeDetected` inside its `scanContinuously` closure via a useEffect
whose deps are `[isSupported, currentCameraIndex, cameras.length]`. If a
parent component renders `<SmartScanner />` in two different render branches
at the same JSX position (e.g. `phase === 'scanning'` vs `phase === 'loose_scanning'`)
without distinct `key` props, React reuses the same component instance and
the running `detect()` loop keeps calling the **stale** callback. Pallet-verify
uses `key="pallet-scanner-${currentPallet}"` for the default scanning view
and `key="loose-scanner"` for the loose phase to force fresh mounts.

**Diagnostic overlay**: when the scanner can't access the camera (no support,
no devices, or `getUserMedia` error), a black overlay covers the viewport
with one of three states — `init` ("Requesting camera permission…"),
`no_cameras` ("No cameras detected" + Retry button), or `error: <message>`
(the actual error string from the browser + Retry). This replaces the
previous behaviour of failing silently to a black screen.

**`isMountedRef` re-arm**: the mount effect now sets `isMountedRef.current = true`
before kicking off camera init. Without that, a key-driven remount could
inherit the previous instance's cleanup state (`false`) and `scanContinuously`
would bail out of every frame.

#### Scanner Visual States (3-state system)

The scanner viewport is a 240x240px target box. It renders one of three mutually exclusive visual states at all times.

**State 1: Idle / Capturing (green SVG trail)**

Active when the scanner is ready or actively accumulating reads toward a confirmation (`!isInCooldown && !isDuplicate`).

- A dim green base border (`border-green-400/25`, 3px) is always visible as the unfilled background.
- An SVG `<rect>` overlay traces the same border in solid green (`rgb(74, 222, 128)`), using `strokeDashoffset` to show progress:
  - `captureCount === 0`: offset = `1` (fully hidden — empty border)
  - `captureCount === 1`: offset = `0.667` (one-third filled)
  - `captureCount === 2`: offset = `0.333` (two-thirds filled)
  - `captureCount === 3`: offset = `0` (fully filled — triggers confirmation)
- Transition: `0.25s ease-out` when `captureCount > 0`; instant snap (`none`) when `captureCount` resets to `0`.
- The center of the box is completely empty (no text, no dots).

**State 2: Cooldown (red)**

Active for 3 seconds after each successfully confirmed scan (`isInCooldown === true`).

- Solid red border (`border-red-500`, 3px).
- A large bold countdown number (`text-6xl font-bold text-red-400`) displayed in the center: counts 3 → 2 → 1.

**State 3: Duplicate (red)**

Active for 1 second when a barcode is detected that was already scanned in this session (`!isInCooldown && isDuplicate`).

- Solid red border (`border-red-500`, 3px).
- "Already scanned" text (`text-base font-semibold text-red-400`) displayed in the center.
- Cooldown state takes precedence if both flags are somehow active simultaneously.

#### Status Badge (top-left overlay)

A small pill badge in the top-left corner of the scanner viewport reflects the current state:

| Condition | Background | Dot | Label |
|---|---|---|---|
| `isInCooldown` | `bg-red-600/80` | `bg-red-300` (static) | `{cooldownTimeLeft}s` |
| `isDuplicate` | `bg-red-600/80` | `bg-red-300` (static) | "Duplicate" |
| Idle / Capturing | `bg-green-600/80` | `bg-green-300 animate-pulse` | ScanLine icon |

#### Green Full-Screen Flash on Success

When the 3rd read is confirmed (barcode accepted), a full-screen green overlay (`bg-green-400/70`) is rendered for 200ms via the `flashColor` state.

### 3. `components/progress/IssueResolution.tsx`
The UI for resolving OCR ambiguities (missing weight, missing product name).
- Displays the crop of the label (saved in Cloudinary).
- Provides a dropdown of products from the current invoice.
- Allows manual weight entry (with smart defaulting).

## Pages / Routes

| URL | Page | Purpose |
|-----|------|---------|
| `/scan/[token]` | `app/scan/[token]/page.tsx` | Carton scanning UI (RECEIVE or ISSUE) |
| `/complete/[token]` | `app/complete/[token]/page.tsx` | Post-scan summary |
| `/issue/[token]` | `app/issue/[token]/page.tsx` | Web scanner issue UI (outbound) |
| `/pallet-verify/[token]` | `app/pallet-verify/[token]/page.tsx` | Pallet verification UI (inbound) — includes loose box scanning phase |
| `/pallet/[lpn]` | `app/pallet/[lpn]/page.tsx` | LPN sticker page (QR code printout) |

## API Routes (`app/api/`)

**18 routes total.** See [API_REFERENCE.md](API_REFERENCE.md) for full request/response docs.

### Carton Scan (RECEIVE/ISSUE)
| Route | Purpose |
|-------|---------|
| `POST /api/session` | Create carton session |
| `GET /api/session` | Get carton session |
| `POST /api/scan` | Record barcode scan (uses `withLock`) |
| `POST /api/ocr` | Trigger box sticker OCR via bot webhook |
| `POST /api/resolve` | Save manual OCR corrections |
| `POST /api/manual-entry` | Manual box entry fallback |
| `POST /api/complete` | Finalize session → webhook to bot |
| `POST /api/cloudinary/upload` | Image upload proxy |

### Issue (Outbound)
| Route | Purpose |
|-------|---------|
| `POST /api/issue-lookup` | Find box by barcode; validate pallet restriction |
| `POST /api/issue-confirm` | Mark box Issued + create OUT transaction in Airtable |
| `POST /api/issue-complete` | Finalize issue session → webhook to bot |

### Pallet Verify (Inbound — pallets + loose boxes)
| Route | Purpose |
|-------|---------|
| `POST /api/multi-pallet-session` | Create multi-pallet session (includes `loose_box_count`) |
| `GET /api/multi-pallet-session` | Get multi-pallet session |
| `POST /api/pallet-scan` | Record box scan + auto-trigger OCR |
| `POST /api/multi-pallet-ocr` | Synchronous box sticker OCR (calls bot `/webhook/process-box-ocr`, returns OCR result) |
| `POST /api/pallet-manual` | Manual box entry for pallet |
| `POST /api/pallet-assign` | Manually assign box to mix pallet item |
| `POST /api/pallet-complete` | Generate LPN, call bot `/webhook/pallet-complete` |
| `POST /api/multi-pallet-loose-complete` | Submit loose box scans → call bot `/webhook/loose-boxes-complete` |

## Redis Key Patterns

| Key | TTL | Purpose |
|-----|-----|---------|
| `session:{token}` | 1h | Carton scan session |
| `pallet:{token}` | 2h | Pallet verification session |
| `pallet:multi:{token}` | 2h | Multi-pallet session (includes `loose_box_count`) |
| `lock:{token}` | 10s | Distributed lock for all mutations |

All mutation routes use `withLock(token, callback)` from `lib/redis.ts`. Lock TTL is 10s; max 20 retries × 250ms = 5s timeout.

## Workflow Data Flows

### Carton Inbound (RECEIVE)
```
1. Bot → POST /api/session (operation_type: RECEIVE) → returns {token, url}
2. Worker opens /scan/[token]
3. Scan → POST /api/scan + POST /api/ocr (async, bot OCR webhook)
4. Polls /api/session for OCR results
5. Resolves issues → POST /api/resolve
6. Worker taps Complete → POST /api/complete → POST /webhook/scan-complete (bot)
7. Bot saves Stock Batches + Box Inventory + Transactions
```

### Issue Outbound (via web scanner)
```
1. Bot → POST /api/session (operation_type: ISSUE) → returns {token, url}
   Optional: pallet_record_id for LPN-restricted sessions
2. Worker opens /issue/[token]
3. Scan box → POST /api/issue-lookup → shows box details
4. Worker confirms → POST /api/issue-confirm → Airtable write (immediate)
5. Repeat for more boxes
6. Worker taps Done → POST /api/issue-complete → POST /webhook/scan-complete (bot, ISSUE type)
7. Bot sends summary message + undo button
```

### Pallet Inbound (PALLET VERIFY — with optional loose boxes)
```
1. Bot → POST /api/multi-pallet-session (pallet_type, mix_items, receipt_id, loose_box_count, ...) → {token, url}
2. Worker opens /pallet-verify/[token]

For each pallet:
3. Scan box → POST /api/pallet-scan → POST /api/multi-pallet-ocr (sync bot OCR webhook)
4. Mix pallet: boxes auto-assigned by Hebrew name matching; manual via /api/pallet-assign
5. canComplete = true when:
   - Single: all expected boxes scanned (or uniform: ≥2 samples)
   - Mix: each item group has enough scans per its uniform_weight flag
6. Worker taps "Generate LPN" → POST /api/pallet-complete
   → generates LPN, POST /webhook/pallet-complete (bot)
7. Bot creates: Pallet, Pallet Items, Box Inventory rows, Stock Batches, IN Transaction
8. Bot sends LPN sticker link → worker prints

After last pallet:
9. If session.loose_box_count == 0: scanner shows all_done, delivery finalized
10. If session.loose_box_count > 0: scanner transitions to loose_scanning phase

Loose box phase:
11. Worker scans individual loose boxes (each box → POST /api/pallet-scan → OCR)
    - Loose boxes are NOT assigned to pallet items; each is independent
    - Progress: scanned / declared count shown in orange UI
12. Confirm → POST /api/multi-pallet-loose-complete → POST /webhook/loose-boxes-complete (bot)
13. Bot creates: Pallets(type=Loose) row, Box Inventory rows for each loose box
14. Bot finalizes delivery
```

## Key TypeScript Types (`types/index.ts`)

```typescript
ScanSession            // Carton scan session (RECEIVE or ISSUE)
MultiPalletSession     // Multi-pallet verification session
  .loose_box_count     // Number of declared loose boxes (0 if none)
MixItem                // One item on a mix pallet (has uniform_weight flag)
PalletBoxScan          // One scanned box in pallet flow
MultiPalletBoxScan     // One scanned box in loose box phase {barcode, sku, item_name, weight, expiry, image_data}
BoxLookupResult        // Response from /api/issue-lookup
IssuedBox              // Box that has been issued (in ScanSession.issued_boxes[])
ParsedBarcode          // Parsed barcode (sku only; weight/expiry come from OCR — NOT from barcode)
BoxStickerOCR          // OCR result (Hebrew + English name, weight, expiry)
```

## Pallet Verify Page — Phase State Machine

```typescript
type Phase =
  | 'loading'
  | 'box_count'
  | 'scanning'
  | 'confirming'
  | 'pallet_done'
  | 'loose_scanning'     // loose box scanning (orange UI)
  | 'loose_confirming'   // submitting loose boxes
  | 'all_done'
  | 'error'
```

Phase transitions:
- `loading` → `box_count` (session loaded, first pallet)
- `loading` → `loose_scanning` (session loaded, `current_pallet > pallet_count` and `loose_box_count > 0` — i.e. user refreshed mid-loose-phase)
- `loading` → `all_done` (session loaded with `status: 'completed'`)
- `box_count` → `scanning` (box count set)
- `scanning` → `confirming` (canComplete and confirm tapped)
- `confirming` → `pallet_done` (pallet-complete call succeeded)
- `pallet_done` → `box_count` (next pallet) OR `loose_scanning` (all pallets done, loose_box_count > 0) OR `all_done` (all done, loose_box_count == 0)
- `loose_scanning` → `loose_confirming` (all loose boxes scanned, confirm tapped)
- `loose_confirming` → `all_done` (loose-complete call succeeded)

> The session's Redis `status` only flips to `completed` once **both** all pallets and all loose boxes are done. While loose boxes are pending the status stays `active` so a tab refresh restores `loose_scanning`.

## Uniform-pair detection (mix pallets)

When 2+ scans of the same SKU come back from OCR with weights within `UNIFORM_WEIGHT_TOLERANCE` (0.5 kg), the page assumes the rest of that SKU's boxes on this pallet are also same-weight (per the warehouse domain rule). It surfaces a prompt at the bottom of the page so the worker can either complete the pallet as single-item or report the real total count for that uniform sub-item.

State (`pallet-verify/[token]/page.tsx`):
- `uniformGroups: Map<sku, UniformGroup>` — locked groups; each has `{sku, item_name, item_name_hebrew, avg_weight, total_count, sample_barcodes}`.
- `pendingUniformPrompt: UniformPrompt | null` — a queued prompt; modes:
  - `'single_or_mix'` — only one SKU has been scanned and no groups are locked. Bottom shows two buttons: *Complete as single-item ({declared} boxes)* or *Continue scanning (this is mix)*.
  - `'mandatory_count'` — number input + Set button + overflow-validation error if `total_count + committed_other > declared`.
- Refs `uniformGroupsRef`, `pendingUniformPromptRef` mirror state so the trigger logic in `runOcr`'s success path always sees the latest values.

Trigger lives in `maybeTriggerUniformPrompt(latestBoxes, justFinishedBarcode)`:
- Skip if a prompt is already pending or this SKU is already locked.
- Look at all done-OCR scans of this SKU. If `len ≥ 2` and `max-min < 0.5`, decide mode based on `distinctSkus.size` and `uniformGroups.size`, then `setPendingUniformPrompt(...)`.

Banner above the scanner lists locked groups (`✓ {item} — {N} boxes locked`) and the pending one (`⏳ {item} — awaiting count below`). Confirm button is gated:
```ts
committed = nonUniformIndividualScans + Σ(uniformGroups.total_count)
canConfirm = !pendingUniformPrompt && committed >= max(2, declaredBoxCount)
```

The locked groups are sent to the API as `uniform_groups: [{sku, total_count, avg_weight}]` so the backend can use the user-reported `total_count` for `Pallet Items.Expected Box Count` instead of the much smaller scanned-sample count.

## OCR retry / rescan / view actions

Every `BoxScan` retains the captured frame as `image_data` (base64 JPEG from `canvas.toDataURL`). When `ocr_status === 'failed'`, the box card surfaces three small buttons inline next to the red "OCR failed" text:

| Button | Behaviour |
|---|---|
| **View** | Opens a full-screen image modal (`viewingImage` state, `fixed inset-0 bg-black/90`) showing the captured frame. Tap outside or the Close button to dismiss. Lets the worker confirm the photo is genuinely bad before deciding what to do. |
| **Retry** | Re-runs `/api/multi-pallet-ocr` against the stored `image_data` (no rescan needed). Useful when the failure was transient (timeout, server hiccup). |
| **Rescan** | Drops the box from the local list and clears `processedRef` for that barcode so the worker can physically rescan. If the box belonged to a locked uniform group and removing it brings the group below 2 same-weight samples, the group lock is cleared too. |

The same three buttons appear in all three OCR-failure render sites: the single-item BoxCard, the mix-pallet grouped list, and the loose-box grouped list.

## All-done view — pallet sticker list

After every pallet is confirmed (and any loose boxes finalised), `phase === 'all_done'` renders a list of every confirmed pallet as a tappable card showing `LPN`, pallet number, declared box count, and `pallet_type`. Each card is `<a href="/pallet/{lpn}?token={session_token}" target="_blank">` so it opens in a new tab without disturbing the scanner. Loose-box count is displayed in a separate orange info card noting that no physical sticker is needed for loose pallets.

The list reads from `session.completed_pallets`. `handleConfirmPallet` mirrors each successful API confirm into local React state (the API persists to Redis but the page never refetches), so by the time the worker reaches `all_done` every pallet they confirmed in this session is in the list — even on a fresh-mount session that had completed_pallets prefilled from a mid-flow refresh.

## Pallet sticker page (`/pallet/[lpn]`)

Server component reads `searchParams.token`. If present, the "← Back" button routes to `/pallet-verify/{token}` (returning the worker to their active scanner session) instead of the homepage `/`. All sticker links generated by the scanner already include `?token=…` for this round-trip. Direct visits from WhatsApp's bot messages have no token and fall back to `/`.

## Important Implementation Notes

- **`Box SKU` ≠ `item_code`**: `Box SKU` in Airtable stores the full barcode string. Never use it as a product identifier. Use the `Pallet Item` record link for filtering in pallet context.
- **Barcodes are IDs only**: `parseIsraeliBarcode()` intentionally returns `weight: 0`. Weight/item data comes exclusively from OCR. Never assume barcode encodes product details.
- **Pallet OCR item matching**: Hebrew-first matching using first significant Hebrew word (≥3 chars). Never use barcode string for item matching.
- **Loose box OCR**: Uses same `/api/multi-pallet-ocr` (synchronous) as pallet box OCR. Each loose box fires OCR immediately on scan.
- **Uniform weight override**: If Airtable has `Uniform Weight = true` but actual Box Inventory rows show weight variance >0.5kg, the bot overrides to non-uniform at outbound time.
- **Synthetic Box Inventory rows**: For uniform pallets, inbound stores only 2 sample rows. Outbound creates synthetic rows for the shortfall before marking as Issued.
- **Loose pallet LPN**: `LOOSE-{YYYYMMDD}-{docShort}` — no physical sticker printed, system tracking only.

**Last Updated**: 2026-04-30 | Branch: `pallet-flow`
