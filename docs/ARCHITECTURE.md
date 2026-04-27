# Web Scanner Architecture

## Overview
The Web Scanner is a Next.js 15 application designed to provide a high-performance, mobile-first barcode scanning interface for the warehouse management system. It serves three flows: carton inbound (RECEIVE), carton outbound (ISSUE), and pallet inbound (PALLET VERIFY).

## Branch & Deployment

- **Active branch**: `pallet-flow` (off `main`)
- **Vercel deploys from**: `pallet-flow`
- Production URL served from Vercel (automatic on push to `pallet-flow`)

## Tech Stack
- **Framework**: Next.js 15 (App Router)
- **Language**: TypeScript
- **Styling**: Tailwind CSS (via `globals.css`)
- **State Management**: React Hooks (`useState`, `useReducer`, `useRef`) + URL State
- **Database/Cache**: Redis (Upstash) for session management
- **Scanning Library**: Native BarcodeDetector API (hardware-accelerated); unsupported browsers show an error message
- **Image Storage**: Cloudinary (via API proxy)

## Core Components

### 1. `app/scan/[token]/page.tsx`
The heart of the application. This single page handles the entire scanning workflow.
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

When the 3rd read is confirmed (barcode accepted), a full-screen green overlay (`bg-green-400/70`) is rendered for 200ms via the `flashColor` state. This is unchanged from the previous implementation and fires before the 3-second cooldown begins.

#### State Variables

| Variable | Type | Purpose |
|---|---|---|
| `captureCount` | `0 \| 1 \| 2 \| 3` | Number of reads accumulated for the current pending barcode |
| `isDuplicate` | `boolean` | True for 1 second when a duplicate barcode is detected |
| `duplicateTimerRef` | `React.MutableRefObject` | Ref holding the timeout that clears `isDuplicate` |
| `isInCooldown` | `boolean` | True for 3 seconds after a confirmed scan |
| `cooldownTimeLeft` | `number` | Countdown value displayed in the center during cooldown |
| `flashColor` | `'green' \| 'red' \| null` | Controls the full-screen flash overlay (green on success only) |

**Removed state variables** (from old 4-state system): `isValidating` (boolean), `validationProgress` (0–3 number).

#### `triggerRedFlash()` Function

Called by the parent page when a duplicate is detected at the API level. Sets `isDuplicate = true` and schedules a 1-second timeout to clear it. This replaced the previous behavior of setting `flashColor = 'red'` for a 300ms full-screen red flash.

#### Backend Logic (unchanged)

- 3-capture validation is unchanged.
- 3-second cooldown after each confirmed scan is unchanged.
- Duplicate prevention (both client-side Set and server-side Redis check) is unchanged.

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
| `/pallet-verify/[token]` | `app/pallet-verify/[token]/page.tsx` | Pallet verification UI (inbound) |
| `/pallet/[lpn]` | `app/pallet/[lpn]/page.tsx` | LPN sticker page (QR code printout) |

## API Routes (`app/api/`)

**16 routes total.** See [API_REFERENCE.md](API_REFERENCE.md) for full request/response docs.

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

### Pallet Verify (Inbound)
| Route | Purpose |
|-------|---------|
| `POST /api/pallet-session` | Create pallet session (`pallet:{token}`, 2h TTL) |
| `GET /api/pallet-session` | Get pallet session |
| `POST /api/pallet-scan` | Record box scan + auto-trigger OCR |
| `POST /api/pallet-ocr` | Update scan with OCR result |
| `POST /api/pallet-manual` | Manual box entry for pallet |
| `POST /api/pallet-assign` | Manually assign box to mix pallet item |
| `POST /api/pallet-complete` | Generate LPN, save Airtable, webhook to bot |

## Redis Key Patterns

| Key | TTL | Purpose |
|-----|-----|---------|
| `session:{token}` | 1h | Carton scan session |
| `pallet:{token}` | 2h | Pallet verification session |
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

### Pallet Inbound (PALLET VERIFY)
```
1. Bot → POST /api/pallet-session (pallet_type, mix_items, receipt_id, ...) → {token, url}
2. Worker opens /pallet-verify/[token]
3. Scan box → POST /api/pallet-scan → POST /api/pallet-ocr (async, bot OCR webhook)
4. Mix pallet: boxes auto-assigned by Hebrew name matching; manual via /api/pallet-assign
5. canComplete = true when:
   - Single: all expected boxes scanned (or uniform: ≥2 samples)
   - Mix: each item group has enough scans per its uniform_weight flag
6. Worker taps "Generate LPN" → POST /api/pallet-complete
   → generates LPN, saves to Airtable (Pallets table), POST /webhook/pallet-complete (bot)
7. Bot creates: Pallet, Pallet Items, Box Inventory rows, Stock Batches, IN Transaction
8. Bot sends LPN sticker link → worker prints and attaches to pallet
```

## Key TypeScript Types (`types/index.ts`)

```typescript
ScanSession        // Carton scan session (RECEIVE or ISSUE)
PalletSession      // Pallet verification session
MixItem            // One item on a mix pallet (has uniform_weight flag)
PalletBoxScan      // One scanned box in pallet flow
BoxLookupResult    // Response from /api/issue-lookup
IssuedBox          // Box that has been issued (in ScanSession.issued_boxes[])
ParsedBarcode      // Parsed barcode (sku only; weight/expiry come from OCR)
BoxStickerOCR      // OCR result (Hebrew + English name, weight, expiry)
```

## Important Implementation Notes

- **`Box SKU` ≠ `item_code`**: `Box SKU` in Airtable stores the full barcode string. Never use it as a product identifier. Use the `Pallet Item` record link for filtering in pallet context.
- **Pallet OCR item matching**: Hebrew-first matching using first significant Hebrew word (≥3 chars). Never use barcode string for item matching.
- **Uniform weight override**: If Airtable has `Uniform Weight = true` but actual Box Inventory rows show weight variance >0.5kg, the bot overrides to non-uniform at outbound time.
- **Synthetic Box Inventory rows**: For uniform pallets, inbound stores only 2 sample rows. Outbound creates synthetic rows for the shortfall before marking as Issued.

**Last Updated**: 2026-04-12 | Branch: `pallet-flow`
