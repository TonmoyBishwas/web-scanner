# Web Scanner Architecture

## Overview
The Web Scanner is a Next.js 16 application designed to provide a high-performance, mobile-first barcode scanning interface for the warehouse management system. It serves three flows: carton inbound (RECEIVE), carton outbound (ISSUE), and pallet inbound (PALLET VERIFY — including loose box scanning).

## Branch & Deployment

- **Working branch**: `preview` (off `pallet-flow`)
- **Vercel PRODUCTION branch**: `main` (production domain `web-scanner-psi.vercel.app`)
- Pushing `pallet-flow` or `preview` produces a non-production **preview** deployment only. To ship to production the code must reach `main` (the team's tree-identical "graph mirror" merge into `main`), or a ready build must be promoted to production in the Vercel dashboard.
- **Redeploy IS required after changing Vercel env vars.**

## Tech Stack
- **Framework**: Next.js 16 (App Router)
- **Language**: TypeScript
- **Styling**: Tailwind CSS v4 + design tokens in `globals.css`. The UI is the
  dark, RTL/Hebrew-first **"WMS Receiving Terminal"** design (1:1 rebuild,
  2026-08-03). Fonts: Heebo (UI, `latin`+`hebrew` subsets) and Roboto Mono
  (numbers — disambiguates 0/O, 1/l/I, 5/S) via `next/font/google`; Material
  Icons Round via `next/font/local` from `app/fonts/` (`next/font/google`
  excludes icon fonts), rendered through the `<MI name="…"/>` ligature wrapper
  with `display: "block"` so raw ligature text never flashes.
- **i18n**: `lib/i18n/{en,he}.ts` — flat key→string maps read through `useT()`.
  **The two files must stay key-for-key identical**; a missing key renders the
  raw key on screen.
- **State Management**: React Hooks (`useState`, `useReducer`, `useRef`) + URL State
- **Database**: Supabase / Postgres via `@supabase/supabase-js` (service-role key, server-side only). Holds both the persistent records (box_inventory, stock_batches, transactions, pallets) and the scan sessions + distributed locks. Migrated 2026-06-30 from Airtable + Upstash Redis.
- **Scanning Library**: Native BarcodeDetector API when it genuinely works on the device, otherwise the pure-JS ZXing reader (`@zxing/browser`, lazy-loaded). `SmartScanner` picks the engine at mount (`pickDecodeEngine`: no `BarcodeDetector`, or `getSupportedFormats()` returning `[]`, → ZXing) and **swaps to ZXing mid-loop** when the native `detect()` rejects — `NotSupportedError` "Barcode detection service unavailable" is what Android tablets without the Play Services barcode module throw on every frame. Before 2026-09-13 there was no fallback at all: those devices either saw "Browser not supported" or a live camera that never decoded. (`html5-qrcode` is still in `package.json` but unused.)
- **Decode loop budget (2026-09-20, for 4 GB / Snapdragon-680-class phones)**: the loop no longer decodes on every animation frame. It runs at most every `NATIVE_MIN_INTERVAL_MS` (80 ms) for the native engine / 100 ms for ZXing, and skipped frames do no work at all. Pacing is **adaptive**: the pause is at least `DECODE_BACKOFF_FACTOR` (2×) the smoothed wall time of one decode attempt, capped at `DECODE_MAX_INTERVAL_MS` (400 ms) — a phone whose ML Kit needs 180 ms per frame gets ~2.7 attempts/s (verified: 384 ms gaps, 60 fps, a 1.2 s hold still confirms) instead of being fed frames back to back. While the sheet is being dragged (`--sheet-h-dur: 0s`) no decode attempt runs at all, so the drag has the whole main thread (no video readback, no canvas draw). It decodes only the **visible** strip of camera — the container minus the `--sheet-h` / `--sheet-w` the `BottomSheet` publishes (`decodeRegion`) — shrunk so the long edge is ≤ `DECODE_MAX_EDGE_PX` (1280). The native path hands the detector a cropped `ImageBitmap` straight from the `<video>` (`createImageBitmap`, GPU-side), so no 1080×1920 frame is ever copied to a CPU canvas while idle; ZXing keeps the canvas path, which is now resized only when the region changes (a canvas resize reallocates its backing store). `captureSharpestFrame` keeps the sharpest burst frame as pixels and JPEG-encodes **once** (it used to encode every candidate). The chips over the video lost `backdrop-blur` — a per-frame compositor readback on a weak GPU. Measured with the fake-camera harness at 4× CPU throttling: idle main-thread canvas work went from ~270 ms per second to 0, and decoder input from 28 Mpx/s to 17 Mpx/s at the mid snap. `BottomSheet` drags write the DOM directly and commit React state on release (`writeLiveHeight`), instead of re-rendering the sheet on every pointermove.
- **Image Storage**: Supabase Storage — public bucket `warehouse-images` (via the `/api/cloudinary/upload` proxy route; Cloudinary removed 2026-07-09)

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

#### Target frame — `frame` prop

`frame='square'` is the legacy centred 240×240 box described below.
`frame='corner'` is the terminal design's **320×196** corner frame — **all
three scanner pages use `corner`.** It is **centred in the strip of camera the
bottom sheet leaves visible**, not pinned near the top: `BottomSheet` publishes
its live height onto the camera region as the CSS variable `--sheet-h` (a
variable rather than a React prop — the height changes on every `pointermove`
of a drag, and re-rendering the live camera at that rate is not affordable),
and the frame's wrapper sits at
`bottom: min(var(--sheet-h, 0px), calc(100% - CORNER_BAND_PX))`. The `min()`
floor keeps `CORNER_BAND_PX` (240px) of room, so at the sheet's *tall* snap the
frame stays top-anchored instead of centring itself underneath the sheet.
`CORNER_BAND_PX` must stay ≤ `MIN_CAMERA_PX` — that is what guarantees the
frame fits at peek/mid.

In corner mode the capture-progress `<rect>` is stroked in the **frame's own
hue** (brand blue), not `--ok` green; stroking green over a blue frame is what
the floor reported as "the green mixes with the blue".

#### "Reading…" — the first of the two required reads (2026-09-22)

A decode needs **2 consecutive identical reads**. Between the first and the
second the only signal used to be that 3px stroke creeping half-way round the
frame — the floor reported it as "a tiny line, hard to see it filling". While
`captureCount > 0` the frame now **lights up**: the fill goes from 5% to 28%
brand blue with an outer glow, the trail stroke is 7px, a solid brand pill
`Reading barcode…` / `קורא ברקוד…` (+ `Hold still`) sits in the frame, and the
status chip turns solid blue with the same words. A first read that never gets
its second (barcode left the frame) drops back to idle after **1.5s** (a
`captureCount === 1` effect), so the loud state can't stay half-lit.

#### Post-scan hold — green "saved" vs red "rejected"

A confirmed decode starts a **3-second hold** in which further decodes are
ignored (the OCR frame is being captured). That hold used to be painted as an
error — red border, full-height red numeral, red status dot — which is exactly
how the *duplicate* state is painted. A good scan therefore read as 0.2s of
green flash followed by 3s of red, and only the sound told the two apart.

The hold is now coloured by `scanOutcome`:

| outcome | frame | label |
|---|---|---|
| `saved` | **6px** green border, 45% green fill + glow, white `Check`, **whole camera tinted `bg-ok/20`**, chip solid green `✓ 3s` | `Box N saved` (or `Captured`) in a solid green pill |
| `duplicate` | 6px red border, 45% red fill + glow, white `X`, whole camera tinted `bg-danger/20`, chip solid red `✕ 3s` | `Already scanned` (or `Rejected`) in a solid red pill |

(Rebuilt 2026-09-22: the 3px border + 10% tint of the first version was
invisible against a bright carton. The green camera flash now fades over its
full 420ms instead of snapping.)

Two props make that possible:

- **`isDuplicateBarcode(barcode) => boolean`** — asked *synchronously* the
  instant a barcode is confirmed. It has to be: the parent's own verdict only
  arrives after `captureSharpestFrame` (4 × 110ms ≈ 400ms+), far too late to be
  the thing that decides what to paint. Pages that cannot answer synchronously
  (`NonMeatTypeAFlow` dedupes by OCR'd *item*, not barcode) omit it and keep the
  parent-driven `onDuplicateFlash`, which now downgrades a hold it lands inside.
- **`holdClaim: 'saved' | 'captured'`** — `/issue` passes `'captured'`, because a
  scan there only starts a lookup that can still fail and the worker must confirm
  the box afterwards. Claiming "saved" there would be a lie.

Related fix: the duplicate frame used to be gated `!isInCooldown && isDuplicate`
and the parent always sets `isDuplicate` *during* the cooldown — so it never
actually rendered. Rejections now own the hold.

#### Scanner Visual States (3-state system)

The `square` viewport is a 240x240px target box. It renders one of three mutually exclusive visual states at all times.

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
- Displays the crop of the label (saved in Supabase Storage).
- Provides a dropdown of products from the current invoice.
- Allows manual weight entry (with smart defaulting).

### 4. `components/terminal/` — the shared design kit

Every scanner screen is the same shell: a live camera filling the area under
the header, with a draggable sheet floating over it.

| Component | Role |
|---|---|
| `DesignHeader` / `ProgressHeader` | Hamburger + optional `leading` slot, centred title/subtitle, optional `right` slot; progress bar with an **optional** caption row (omit `label` for a bare bar) |
| `BottomSheet` | The floating sheet. 3 snaps, drag handle, `toolbar` + scrolling children + `footer`. Exposes `snapTo(i)` via ref. **On a wide landscape host (≥ 720px and aspect ≥ 1.15 — a tablet on its side) it docks instead as a full-height side panel** at the inline end (`data-sheet-layout="side"`, width `clamp(340, 38%, 480)`): no handle, footer always shown, `--sheet-h` = 0 and `--sheet-w` = its width, so the scanner's overlays keep to the visible camera. Decided per measure, so rotation switches live |
| `ToolDock` | The chip row inside the sheet's toolbar (share / delete / pallets / locked stubs). Chips follow the page direction and the end edge fades as the "more chips" cue; a chip can carry an amber `badge` count (the Labels chip: saved labels not printed yet) |
| `ActiveScanCard` | The newest scan — live status dot, big mono weight; the whole summary line expands it; its actions are a `ScanActions` bar |
| `HistoryRow` | One older scan; tap to expand a `ScanActions` bar underneath it |
| `ScanActions` | The one per-scan action bar (2026-10-01): Edit (blue) · All boxes identical · Delete (red, last, two taps — the first arms it solid red "Tap again" for 3 s); View · Retry on their own line when OCR failed. 40 px buttons; lines wrap, so nothing runs off a 320 px phone |
| `EditPanel` | Full-screen carton editor (camera paused) — sticker photo on top, Item / Weight / Expiry tiles with one state each, the selected field's editor (see below) |
| `Keypad`, `CalendarPicker` | Context inputs for the edit panel (`CalendarPicker requirePick` — the default, so also in the identical form and New carton: no silent "today") |
| `DoneOverlay`, `SwipeConfirm` (in `shared/`) | Pallet-done stats + the one-tap **Scan pallet N of M**; slide-to-confirm only where stock is booked (pallet confirm, close-short, loose confirm) |
| `PriorityPushStatus` | The all-done card's status row for the automatic Priority push — not a button (2026-10-01) |
| `CartonCreator`, `IdenticalBoxesForm`, `LabelsBrowser` | New carton / All boxes identical **save** labels and return to the scanner; the Labels screen prints them, marks them printed, deletes them |
| `SideDrawer`, `DrawerHost`, `ScreenOverlay`, `LockedScreen` | Hamburger drawer, overlay host, "not built yet" screens |
| `PalletsBrowser`, `DocumentsBrowser` | Unlocked drawer features: floor pallet lookup, completed-delivery archive |
| `SplitJobScreen`, `SplitPlanner`, `SplitBoard` | Split-assignment worker/manager UI (`SPLIT_ASSIGNMENT_ENABLED`) |
| `MI` | Material Icons Round ligature wrapper |

**Tablets (2026-09-13).** Portrait tablets are just big phones and need nothing. Landscape is where the bottom-sheet geometry broke: on 1280×680 the mid snap left a 250px sheet showing one card, and the 347px camera strip above it had the corner frame, its label and the capture hint/button drawn over each other (at the tall snap the control was clamped into the frame's label). The side-panel mode above is the fix; `SmartScanner`'s overlay layer reads `--sheet-w` (`inset-inline-end`). `NonMeatTypeAFlow` (no sheet, plain scrolling column) bounds its camera to `min(48dvh, 440px)` instead of the default full-width square, which on a tablet pushed everything below it off screen. `body { touch-action: manipulation }` kills double-tap zoom, because Chrome on 10"+ tablets opens sites in desktop mode and ignores the viewport meta's zoom lock there.

**Two layout rules learned the hard way — both caused real breakage:**

1. **The camera wins over the sheet.** `BottomSheet` floors its peek snap at
   *base* chrome only (handle + dock + padding + border, **excluding** the
   footer), and caps mid/tall at `container − MIN_CAMERA_PX` (240px = the
   196px corner frame plus its label and padding, i.e. `CORNER_BAND_PX`). When the sheet is too short for the
   footer the footer is **hidden**, never allowed to overflow. Flooring every
   snap at chrome *including* a ~170px footer pinned peek/mid/tall to the same
   height and left 50px of camera — that was a production outage (2026-08-11).
2. **An `overflow-hidden` child of the sheet's scroll area needs `shrink-0`.**
   The scroll area is a column flex container; `overflow-hidden` (used for
   rounded corners) sets a flex item's automatic minimum size to **0**, so the
   child is squashed to the visible height and its content is **clipped rather
   than scrolled** — `scrollHeight === clientHeight`, content present but
   unreachable. This hid the bottom keypad rows of `EditPanel` (2026-08-14).

**Gesture state must live in a ref, not React state.** `BottomSheet`'s
`onPointerMove` originally gated on a `dragging` state flag React had not yet
committed, so the opening moves of every gesture were dropped and a fast tap
could be swallowed outright.

## Pages / Routes

| URL | Page | Purpose |
|-----|------|---------|
| `/` | `app/page.tsx` | Landing |
| `/scan/[token]` | `app/scan/[token]/page.tsx` | Carton scanning UI (RECEIVE or ISSUE) |
| `/complete/[token]` | `app/complete/[token]/page.tsx` | Post-scan summary |
| `/issue/[token]` | `app/issue/[token]/page.tsx` | Web scanner issue UI (outbound) |
| `/pallet-verify/[token]` | `app/pallet-verify/[token]/page.tsx` | Pallet verification UI (inbound) — pallets, loose-box phase, and the split-job slot screen |
| `/assign/[token]` | `app/assign/[token]/page.tsx` | Manager's split-assignment planner + live board |
| `/sticker/v1/[lpn]` | `app/sticker/v1/[lpn]/page.tsx` | LPN sticker page (QR code printout) |
| `/pallet/[lpn]` | `app/pallet/[lpn]/page.tsx` | Legacy sticker alias (still valid in old messages) |

## API Routes (`app/api/`)

**29 route files** (2026-10-01; `GET /api/priority-status` is the newest). See [API_REFERENCE.md](API_REFERENCE.md) for older request/response docs and `SCANNER_REFERENCE.md` for the current contracts.

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
| `POST /api/cloudinary/upload` | Image upload proxy → Supabase Storage (`warehouse-images`) |

### Issue (Outbound)
| Route | Purpose |
|-------|---------|
| `POST /api/issue-lookup` | Find box by barcode; validate pallet restriction (reads Supabase) |
| `POST /api/issue-confirm` | Mark box Issued + create OUT transaction in Supabase (under `withLock`) |
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
| `POST /api/pallet-complete` | Generate LPN, insert pallet into Supabase (`savePalletToSupabase`), call bot `/webhook/pallet-complete` |
| `POST /api/multi-pallet-complete` | Confirm one pallet of a multi-pallet session — classifies single/mix server-side (`detectPalletType`), applies `uniform_groups` overrides, emits the bot webhook (with `after()`). Normalises expiries to ISO; **409 `labels_not_printed`** while saved labels are unprinted (print gate) |
| `POST /api/multi-pallet-loose-complete` | Submit loose box scans → call bot `/webhook/loose-boxes-complete` (now under `withLock`; `after()`; same print gate and ISO expiries; records `loose_barcodes`) |
| `POST /api/consolidate-items` | AI name-consolidation — asks whether two OCR name groups are the same product |

### Split assignment (`SPLIT_ASSIGNMENT_ENABLED`)
| Route | Purpose |
|-------|---------|
| `POST /api/split-plan-session` | Create the manager's planning session |
| `POST /api/split-plan` | Save / update the pallet→worker plan |
| `POST /api/pallet-claim` | A worker claims, releases, or closes-short a slot (guards the session's completed state) |

### Drawer features (read-only, token-guarded by `lib/session-guard.ts`)
| Route | Purpose |
|-------|---------|
| `GET /api/pallets` | Pallet list / search / find-by-barcode / find-by-LPN (floor lookup) |
| `GET /api/pallets/detail` | One pallet with per-item remaining counts |
| `GET /api/documents` | Completed-delivery archive list |
| `GET /api/documents/detail` | One delivery: invoice photo, lines with gaps, pallets, Type B voice note |

### Carton labels (token-guarded, `lib/carton-labels.ts`)
| Route | Purpose |
|-------|---------|
| `GET /api/carton-labels` | Labels list — `scope=session\|all`, `status=created\|printed`; `status=created` also feeds the unprinted badge |
| `POST /api/carton-labels` | **Save** one label per carton — `origin` `new_carton` (label only) · `identical` · `receiving` (booked as stock); a client `batch_id` makes a retry return the same batch |
| `DELETE /api/carton-labels` | `?batch` — delete a batch (409 `labels_booked` once its cartons are booked on an LPN); `?barcode` — one unprinted identical / receiving label whose scan row was deleted |
| `GET /api/carton-labels/print` | The labels the print sheet renders |
| `POST /api/carton-labels/print` | Mark printed — `via:'sheet'` (the sheet, right before `window.print()`) or `via:'manual'` ("Mark as printed") |

### Priority status (read-only)
| Route | Purpose |
|-------|---------|
| `GET /api/priority-status` | Where this session's delivery stands with the automatic Priority push (all-done card). Reads our outbox/config and the client's `priority_goods_receipts` / `delivery_po_links`; sends nothing; never returns the webhook URL |

## Session Storage (Supabase / Postgres)

Sessions live in the Postgres `scan_sessions` table (`token` PK, `kind` enum, `data` jsonb, `expires_at`). The former Redis key namespaces map to `kind` values; TTL is enforced lazily on read (`expires_at > now()`), reproducing Redis `EX`.

| Old Redis key | `scan_sessions.kind` | TTL | Purpose |
|---------------|----------------------|-----|---------|
| `session:{token}` | `carton` | 1h (→ 24h on finalize) | Carton scan session |
| `pallet:{token}` | `pallet` | 2h | Legacy single-pallet verification session |
| `pallet:multi:{token}` | `multi_pallet` | 2h | Multi-pallet session (includes `loose_box_count`) |

`lib/redis.ts` keeps the same filename and exports (`sessionStorage`, `getRedisClient`, `palletKey`, `sessionKey`) but is now Supabase-backed, so route imports from `@/lib/redis` are unchanged. `lib/supabase.ts` is the lazily-constructed service-role client (build-safe Proxy) that re-implements every former `lib/airtable.ts` export with identical names + return shapes (`findBoxByBarcode`, `getInventoryRecord`, `issueBox`, `revertBoxIssue`, `createIssueTransaction`, `updateInventoryQuantity`); `lib/airtable.ts` was deleted.

**Distributed lock**: a Postgres `locks` table driven by the `acquire_lock` / `release_lock` SQL functions. `withLock(token, callback)` (on `sessionStorage`) calls `supabase.rpc('acquire_lock', …)` with a 10s TTL, max 20 retries × 250ms = 5s timeout, and a locker-id-guarded release — reproducing the old Redis `SET NX EX 10`. Locking was also added to the previously-unlocked `multi-pallet-complete`, `multi-pallet-loose-complete`, and `manual-entry` routes.

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
4. Worker confirms → POST /api/issue-confirm → Supabase write (immediate, under withLock)
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
6. Worker slides "Slide to confirm · Pallet N" → POST /api/multi-pallet-complete
   → (409 labels_not_printed while saved labels are unprinted — print them first)
   → generates LPN, POST /webhook/pallet-complete (bot, sent with after())
7. Bot creates: Pallet, Pallet Items, Box Inventory rows, Stock Batches, IN Transaction
8. Bot sends LPN sticker link → worker prints; the scanner's pallet_done card offers the
   same print link and a one-tap "Scan pallet N+1 of M" (no second slide)

After last pallet:
9. If session.loose_box_count == 0: scanner shows all_done, delivery finalized
   (deliveries.status → Complete / Has Discrepancy → automatic Priority push, once enabled;
   the all-done card shows its status)
10. If session.loose_box_count > 0: scanner transitions to loose_scanning phase

Loose box phase:
11. Worker scans individual loose boxes (each box → POST /api/pallet-scan → OCR)
    - Loose boxes are NOT assigned to pallet items; each is independent
    - Progress: scanned / declared count shown in orange UI
12. Slide confirm → POST /api/multi-pallet-loose-complete (same print gate) → POST /webhook/loose-boxes-complete (bot)
13. Bot creates: Pallets(type=Loose) row, Box Inventory rows for each loose box
14. Bot finalizes delivery (→ automatic Priority push, once enabled)
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
  | 'job'                // split assignment: pick/claim a slot before scanning
  | 'scanning'
  | 'confirming'
  | 'pallet_done'
  | 'loose_scanning'     // loose box scanning (orange UI)
  | 'loose_confirming'   // submitting loose boxes
  | 'all_done'
  | 'error'
```

### Header — one counter per corner

Both scanning phases put a single counter in each header corner and nothing
else: **pallet `x/n` at the start**, the document number centred, **cartons
`x/n` at the end** (the loose phase shows the word "loose boxes" at the start
instead, since it has no pallet index). `ProgressHeader` below it renders as a
**bare bar** — its `label` prop is omitted.

This replaced three readouts that all said the same thing: the header title
("Pallet 1 of 2"), a `TypeBadge` beside it ("Scan 2+ boxes to detect type" /
"Mix · scan all boxes"), and the progress row's own label + count ("Receiving ·
Pallet 1 of 2 … 1 Cartons"). Workers read the whole block as noise. The badge
is gone entirely — `detectedType` still drives the classification and the
single-vs-mix prompt, it is just no longer narrated in the header.

Numbers carry `dir="ltr"` so "1/2" does not reorder inside the RTL header; the
start/end sides mirror correctly in Hebrew.

> The old `box_count` phase is **gone**. The worker no longer declares the total
> before scanning: they scan first, and the total is asked for in the sheet
> footer only when it's actually needed (the single-item shortcut, or the
> "Done scanning?" exit). This is why the footer — not a separate screen — owns
> the count input.

Phase transitions:
- `loading` → `scanning` (session loaded, first pallet)
- `loading` → `job` (split session and this worker holds no slot yet)
- `loading` → `loose_scanning` (session loaded, `current_pallet > pallet_count` and `loose_box_count > 0` — i.e. user refreshed mid-loose-phase)
- `loading` → `all_done` (session loaded with `status: 'completed'`)
- `job` → `scanning` (slot claimed)
- `scanning` → `confirming` (canConfirm and the confirm slide completed — or the close-short slide, or the single-item count submit; refused while the print gate blocks)
- `confirming` → `scanning` (failure, or 409 `labels_not_printed` — the gate is shown, never a red error)
- `confirming` → `pallet_done` (pallet-complete call succeeded)
- `pallet_done` → `scanning` (next pallet, via a **tap** on "Scan pallet N of M" — armed 500 ms after the card appears; a 400 ms tap shield follows) — the last pallet skips `pallet_done` and goes from `confirming` straight to `loose_scanning` (loose_box_count > 0) or `all_done`
- `loose_scanning` → `loose_confirming` (all loose boxes scanned, the blue loose slide completed; refused while the print gate blocks)
- `loose_confirming` → `all_done` (loose-complete call succeeded)

**Reload safety**: in-progress scans are cached in `localStorage` under
`pv:{token}:p{n}` (and `pv:{token}:loose`) by `lib/pallet-scan-cache.ts`.
Base64 `image_data` is **stripped on save** (5 MB quota) but not on load — so a
restored box has no sticker photo, and the edit panel renders without one.

> The session's `status` (in `scan_sessions.data`) only flips to `completed` once **both** all pallets and all loose boxes are done. While loose boxes are pending the status stays `active` so a tab refresh restores `loose_scanning`.

## Single-item shortcut (uniform detection)

*Rewritten 2026-08-14. Superseded: the old 0.5 kg tolerance, the `sku` group key,
and the `mandatory_count` prompt mode — none of those exist any more.*

The point of the shortcut: on a pallet where every box is the **same product at
the identical printed weight**, scanning all 60 boxes is wasted work. Scan two,
declare the total, the system multiplies.

**"Same weight" is literal.** `UNIFORM_WEIGHT_TOLERANCE = 0.0001` kg (0.1 g) —
below the 1 g resolution printed on a label. It exists to absorb floating-point
noise, **not** as a grace band. Catch-weight meat (10.09 vs 10.08) is *different*
and every box must be scanned, because each box's own weight is what
`box_inventory` carries for FEFO at outbound. Mirrored by
`UNIFORM_WEIGHT_TOLERANCE_KG` in `app/api/multi-pallet-complete/route.ts` —
**keep the two in sync.**

State (`pallet-verify/[token]/page.tsx`):
- `UNIFORM_MIN_SAMPLES = 2` — the smallest number that can establish "same
  weight" at all. (Raised to 4 in May 2026 to stop prompts overlapping mid-OCR;
  lowered back to 2 in Aug 2026 — see the retraction rule below, which is what
  the 4-box gate was really standing in for.)
- `uniformGroups: Map<name_key, UniformGroup>` — locked groups, keyed by
  **normalized name** (`lib/group-key.ts`, e.g. `he:קציצותברטובאדום`), *never* by
  barcode/SKU. Each holds `{name_key, item_name, item_name_hebrew, avg_weight,
  total_count, sample_barcodes}`.
- `pendingUniformPrompt: UniformPrompt | null` — one mode only,
  `'single_or_mix'`: *Complete as single-item* / *Continue scanning (mix)*.
- Refs `uniformGroupsRef`, `pendingUniformPromptRef`, `forcedMixRef` mirror state
  so the trigger in `runOcr`'s success path always sees current values.

`uniformCandidateFrom(doneBoxes, merges)` is the shared predicate: ≥2 done boxes,
exactly one distinct group key, weight spread < tolerance. Two callers:

- `maybeTriggerUniformPrompt(latestBoxes, …)` — on each OCR success. Bails while
  any box is still `processing`. **If a prompt is already open and the candidate
  no longer holds, it retracts the prompt** (a second product arrived, or a
  differing weight). That self-retraction is why 2 samples is safe.
- `restoreUniformPrompt(cached)` — on cache restore after a reload. Reads the
  *cached* flags, because the refs aren't synced yet at that point. Without it a
  reload silently dropped the worker onto the mix path.

**Escape hatch**: 1–3 OCR'd boxes that aren't all one uniform item get a
full-width **"Done scanning? Enter the pallet total"** button in the footer
(`setForcedMix(true)`). It was a thin grey underline that workers missed; it now
carries the same weight as the other footer actions.

Confirm gating:
```ts
committed  = nonUniformIndividualScans + Σ(uniformGroups.total_count)
canConfirm = !pendingUniformPrompt && committed >= max(2, confirmedBoxCount)
```

Locked groups go to the API as `uniform_groups: [{name_key, total_count,
avg_weight}]` so the backend uses the worker-reported total for
`Pallet Items.Expected Box Count` rather than the sample count.

> ⚠️ **Never read the declared count out of state in a deferred callback.**
> `handlePalletCountSubmit` used to do `setConfirmedBoxCount(n); setUniformGroups(…);
> setTimeout(() => handleConfirmPallet(), 0)` — the scheduled callback captures
> *that* render's closure, so it posted `box_count: 0` with empty
> `uniform_groups`, and the server's `box_count || itemBoxes.length` fallback
> booked the pallet at the **sample** count (declare 40, get 4 — real stock
> corruption). The count and groups are now passed in explicitly:
> `handleConfirmPallet({ boxCount, groups })`.

The server re-classifies independently (`detectPalletType`), so a pallet that is
genuinely single+uniform is multiplied even when the client sent mix. That is why
a "discrepancy vs. delivery note" warning can appear on a pallet that in fact
books correctly.

## The scan list — per-scan actions

*Rewritten 2026-08-14.* The sheet shows the **newest scan as an `ActiveScanCard`**
and every older scan as a `HistoryRow`, newest first. Grouping still drives the
uniform logic; only the presentation is flat.

Every `BoxScan` retains the captured frame as `image_data` (base64 JPEG from
`canvas.toDataURL`), so every action below works without a rescan.

| Action | Behaviour |
|---|---|
| **ערוך / Edit** | Opens `EditPanel` in place of the list (see below) |
| **כל הקרטונים זהים / All boxes identical** | Opens `IdenticalBoxesForm` for this carton (see below). Not on `MANUAL-`/`NOBC-` rows, rows still in OCR, or minted rows |
| **מחק / Delete** | `rescanPalletBox` — drops the box and clears `processedRef` for that barcode so the worker can physically rescan. If removing it leaves a locked uniform group with <2 samples, the lock is cleared too. Deleting a row whose identical / receiving label is still unprinted also deletes that label (`DELETE /api/carton-labels?barcode`); deleting the last row of an identical batch frees the supplier barcode |
| **נסה שוב / Retry** *(failed OCR only)* | Re-runs `/api/multi-pallet-ocr` against the stored `image_data` — for transient failures (timeout, server hiccup) |
| **צפה / View** *(failed OCR only)* | Full-screen image modal (`viewingImage`) of the captured frame, so the worker can see whether the photo is genuinely bad |

Since 2026-10-01 both places render the same `ScanActions` bar — Edit (blue) · All boxes identical · Delete (red, last), each line wrapping — because on a 360 px phone the card's old non-wrapping row pushed "All boxes identical" off the screen, where it could not be reached.

Where they render:
- **`ActiveScanCard`** — actions are **props on the card** (`onEdit`, `onDelete`,
  `onRetry`, `onViewImage`), always visible. They used to be gated behind
  `selectedBarcode === activeBox.barcode`, which nothing ever set on the card:
  the newest scan — the one a worker realises they mis-scanned — was the only
  scan with **no reachable delete**. Fixed 2026-08-14.
- **`HistoryRow`** — tap the row to expand an `actions` row **underneath** it.
  They previously rendered inline beside the 17px weight, on the same line as a
  31-digit barcode; the barcode had no clamp, so the three collided. The barcode
  now ellipsises and the buttons get a full-width line of their own.

## "All boxes identical" → one printed label per carton (2026-09-22; save-now / print-later 2026-10-01)

Some products print **one barcode on every carton** (fixed-weight goods:
kebabonim, fish, produce cartons), and for those the name, weight and expiry
are the same on every carton too. The scanner dedupes on the barcode, so only
one of N could ever be booked — and on the way out N boxes sharing a code
cannot be told apart. Two automatic fixes were tried on 2026-09-17/20 (count
repeat reads; a ≤14-digit "shared-label" opt-in with a repeat gate) and both
were reverted on 2026-09-22: **the system never decides a product is
shared-label. The worker does.**

- On any captured row (the newest-scan card or a history row, pallet phase and
  loose phase alike) a third action **כל הקרטונים זהים / All boxes identical**
  opens `components/terminal/IdenticalBoxesForm.tsx`: count (required), weight
  per carton (required, prefilled from the OCR), production/expiry dates, a
  live `CartonSticker` preview. Hidden on `MANUAL-`/`NOBC-` rows, on rows still
  in OCR, and on rows that are themselves minted.
- **Save N labels** (HE `שמור N מדבקות`) → `POST /api/carton-labels` with
  `origin: 'identical'`, `source_barcode` (the supplier code off the sample),
  `pallet_number` (0 = loose) and a client `batch_id` (one per distinct save
  content, `batchIdForPayload` — a retry of the same save after a lost
  response returns the same batch; a save whose count, weight, dates or item
  changed gets its own, and the server answers with a stored batch only when
  it is the same save, `batchMatchesRequest`). The minting stack
  (`lib/carton-labels.ts`: `28` + YYMMDD + 8 random digits, unique index)
  returns N rows and the form closes **straight back to the scanner** with a
  toast "N labels saved · print them from Labels before closing the pallet".
  There is no print step here any more (until 2026-10-01 a second "created"
  screen offered Print N labels / Done). The labels are printed from the
  **Labels** chip whenever it suits — but **the pallet cannot get its LPN
  while they are unprinted** (the print gate, below).
- `lib/identical-boxes.ts` → `expandIdenticalBoxes(sample, labels, form)`
  replaces the sample row by N ordinary `BoxScan`s: `barcode` = minted code,
  `sku` = the sample's 13-digit prefix (`sourceSku`), weight/dates from the
  form, `minted: true`, `label_batch_id`, `source_barcode`; the sticker photo
  stays on the first row, `image_url` on all. The minted codes (and the
  supplier code) sit in the dedup set, so scanning a printed sticker back in is
  an "already counted" notice. A re-read of the supplier code points at the
  batch's first row. Deleting the batch's rows one by one frees the supplier
  code again (`releasedSources`), and a reload refills the dedup set with it
  (`dedupCodes`). The expiry is handed over as ISO `YYYY-MM-DD` (until
  `01a2ae5` this line wrote `DD/MM/YYYY`, which the bot stored as
  `box_expiry` NULL — 140 cartons).
- **"Different carton?"** (HE `קרטון אחר?`) on an already-counted notice
  opens this form as "Different carton, same label" with the counted carton
  as the sample and count 1: for a physically different carton whose label is
  byte-identical (a 31-digit catch-weight label carries no serial). It
  **adds** one row with a label of its own — the counted carton stays — and
  that label falls under the print gate. Explicit tap only; not offered for a
  warehouse `28…` label, a row still in OCR, or the supplier code of an
  identical batch (`isBatchStandIn`): every carton carrying it is already
  declared, so that read says "the N identical labels saved for this product
  cover it" and names no carton. The link is a full-width 40 px line; the
  notice stays 8 s and never times out while a finger is on it. The camera is
  paused while this form, New carton or Labels is open.
- **Booked directly.** The rows travel through `/api/multi-pallet-complete` /
  `/api/multi-pallet-loose-complete` unchanged and the bot writes one
  `box_inventory` row per minted barcode (`box_sku` = supplier prefix).
  Outbound photographs the printed sticker → `find_box_by_barcode` → that row.
- Minted rows never raise the single-item shortcut (`uniformCandidateFrom`
  returns null when any row is minted — their count is already exact), and
  the pallet-total input is prefilled with the list's count (still editable).
- `carton_labels` columns added: `origin`, `source_barcode`, `pallet_number`
  (`docs/migrations/2026-09-22-carton-labels-identical.sql`). Tests:
  `lib/identical-boxes.test.ts`; `lib/carton-barcode.ts` keeps only the SCN-13
  misread refusal (`classifyRead`).

## Labels: save now, print later, and the print gate (2026-10-01)

Floor request: save labels while scanning, keep scanning, print them all
whenever it suits — "but of course without printing he can't create the LPN or
go to the next pallet". Rules in `lib/label-batches.ts` and `lib/label-gate.ts`
(both tested).

- **Three ways to save a label**, all `POST /api/carton-labels`: New carton
  (`origin 'new_carton'`, label only — the carton is scanned in once the label
  is printed), All boxes identical (`'identical'`, booked) and the edit panel's
  "Create a barcode for this carton" (`'receiving'`, booked). Each records its
  pallet (0 = loose).
- **Seeing what is unprinted.** `useUnprintedLabels` reads
  `GET /api/carton-labels?scope=session&status=created` on mount, after every
  save / print / delete, and whenever the tab becomes visible or focused again
  (the worker coming back from the print tab). The Labels chip shows an amber
  count; each unprinted scan row an amber crossed-out printer.
- **"Printed" is set by the print sheet**, for exactly the labels it rendered,
  right before `window.print()` (`POST /api/carton-labels/print`,
  `via:'sheet'`, `keepalive`, once per page load). Not by the opener — "the
  tab opened" is not "the labels printed" — and never on `afterprint`, which
  Android Chrome may not fire. **Mark as printed** in Labels (`via:'manual'`,
  tap + confirm) is the fallback.
- **The gate.** An unprinted label blocks the list being booked when (i) its
  carton is on that list, or (ii) it is a New carton label anywhere in the
  session. Printed labels and orphans never block. On the page, the confirm
  slide (or the close-short button) is replaced by an amber hint, an amber
  one-tap **Print N labels first** (opens the sheet for exactly those batches,
  inside the click so pop-up blockers allow it) and a **Choose in Labels**
  link; the confirm handlers refuse too (slide, close-short modal, gap chip,
  single-item auto-confirm). On the server, both completion routes answer
  **409 `labels_not_printed`** before any write or webhook — so with unprinted
  labels the last pallet cannot close the delivery or start the Priority push.
  The `pallet_done` tap and the all-done card are not gated (the LPN exists).
- **Deleting.** A Labels batch delete warns what it removes from the open
  lists and is refused (409 `labels_booked`) once the cartons are booked on an
  LPN; deleting an identical / receiving row deletes its unprinted label.

## Scan notices — "already counted" is not an error (2026-10-01)

The page used to have one persistent red line for everything, so a carton read
a second time — the most common event on a pallet scanned in place (22 of 32
reads on IN264172698 pallet 3) — sat in red for minutes as "Already scanned —
this is carton #8 in the list (15:09)". Now (`lib/scan-notice.ts`):

| What happened | What the worker sees |
|---|---|
| A counted carton read again | **Blue** notice over the top of the camera, "Carton #N is already counted — scan the next carton.", 4 s (8 s, held while touched, when it offers "Different carton?"); for the supplier code of an All-boxes-identical batch it says the N saved labels cover it instead, and offers nothing; its row rings blue and scrolls into view; one soft 520 Hz tick, silent while the camera rests on the same sticker (15 s sliding window); the camera hold says **Already counted** in blue |
| A manual capture of a counted label | Blue "This label is carton #N — it is already counted." (was dropped silently) |
| A misread / too-short read | **Amber** notice, 4 s — scan it again |
| A failure (network, failed complete, session, split clash, save) | **Red**, persistent, with an icon and `role="alert"` — the only red |

The notice floats at the top of the camera, not in the sheet footer: on a
360×641 phone the count input plus one more footer line made `BottomSheet` hide
the whole footer and never bring it back. Progress reads "6 of 15 cartons left
to scan" with a pencil (or tap the CARTONS counter) to correct the total; a
pallet that arrived short closes with the outlined amber **Fewer cartons
arrived? Close with N** → modal "Close the pallet with missing cartons?" →
amber slide **Slide to close with N cartons**, which books exactly N.

## Priority push — automatic, a status row only (2026-10-01)

The all-done card's locked "Close & send to Priority" button is gone: nobody
in the warehouse sends anything. At the last LPN (or the last loose box) the bot
closes the delivery; the DB trigger queues it in `priority_push_outbox`; pg_cron
job 8 sends it to the client's Make scenario every minute; the scenario creates
the Priority **draft** and writes `priority_goods_receipts`, which makes the bot
send "✅ Priority received it" in WhatsApp. The card shows
`PriorityPushStatus` — a row that polls `GET /api/priority-status` (4 s for
3 min, then 30 s) and changes by itself: blue sending, green "In Priority as
draft GR…", amber waiting / unconfirmed (ask the office), red failed, grey
off / test / on hold.

**Status today:** the push is **off**. The enqueue trigger has never queued a
row (it reads a `deliveries.category` column that does not exist), and its fix
— `docs/migrations/2026-10-01-priority-push-autofire.sql` — is **not applied**;
Tonmoy applies it by hand. Even then nothing is sent until the client gives his
Make webhook URL and `priority_push_config` is set `url = …, enabled = true`.
Until then the row says "Automatic sending to Priority is off" (or "Test user —
not sent to Priority").

## Barcode cross-check (`lib/barcode-parser.ts`)

`parseIsraeliBarcode` still treats every barcode as an **ID only** — that rule
holds for the 25-digit format, which is 62 % of cartons and encodes nothing.

But a **31-digit** carton barcode does carry data (measured across all 264 live
`box_inventory` rows): weight at 1-based chars **14–19** ÷ 1000, and the expiry
as a trailing **`DDMMYYYY`**. Agreement with the OCR is 65/67 on weight and
64/67 on expiry — and in all three expiry disagreements the **barcode was right
and the OCR had misread a digit**.

`findBarcodeConflict(barcode, ocrWeight, ocrExpiry)` returns the disagreement, or
null. On a conflict `runOcr` (pallet **and** loose phases) stores
`BoxScan.barcode_conflict`, fires an amber toast naming both readings, and
`EditPanel` offers the barcode's value as a one-tap **Use**. `handleSaveEdit`
clears the flag — the worker has looked at both and chosen.

Three constraints, all deliberate:

- **Never `needs_review`.** That flag blocks the pallet from closing. A parser
  validated on 67 cartons from two suppliers must not be able to stop a delivery.
- **Never override, never fill a blank.** A missing value is `needs_review`'s
  job; filling it from the barcode is the authoritative behaviour being avoided.
- **50 g threshold** (`BARCODE_WEIGHT_TOLERANCE_KG`) — above label rounding,
  below both measured outliers. Expiry flags on any difference.

Server side, `box_inventory.barcode_expiry` / `.barcode_weight_kg` are
**`GENERATED ALWAYS … STORED`** over the same parse (`wb_barcode_expiry` /
`wb_barcode_weight_kg`), so they populate historical rows and cannot drift from
the barcode across the four insert paths.

---

## Edit panel (`components/terminal/EditPanel.tsx`)

*Rewritten 2026-10-01* (`d44d180`, `59fde78`). A **full-screen** editor
(`fixed inset-0 z-[80]`; the camera pauses while it is open), mounted in both
the pallet and the loose phase, remounted per carton.

The layout is driven by one fact: **the worker is editing because OCR misread
the sticker**, so the sticker photo fills the top of the screen and the
controls sit below it, both visible at once.

```
top bar        ‹ back · Carton #N · status line ("Missing: weight, expiry") · Save
photo          the sticker, as large as the room allows (tap → full screen)
tiles          [Item] [Weight] [Expiry] — each with one state badge
editor         the selected tile's editor, joined to it by a caret
batch          Supplier batch / lot · optional
barcode        Scanned barcode 🔒 — the row's identity/dedup key
```

Floor complaint: "which one is selected, which to edit, there is no edit sign".
One brand-blue border used to mean three things (the field being edited, the
chosen invoice line, an always-outlined text box), empty values were drawn as
data (`0 kg`, `—`) and Save never changed. Now one colour per meaning, each
with an icon (`lib/edit-panel-state.ts`):

| Tile state | Look |
|---|---|
| being edited | blue frame + blue pencil + a caret into the editor |
| missing | amber **dashed** frame, "!" , "Missing · tap to enter" |
| wrong (weight 0; expiry today or earlier) | red frame, "!" |
| changed and valid | green check |
| untouched | grey pencil |

- Opens on the first field that still needs the worker; picking an item or a
  date moves on to what is still missing.
- **Item**: a radio list with exactly one green row, item codes in mono,
  invoice lines with the same name merged; a name read off the sticker that is
  not on the invoice is the first row, amber; free text sits behind
  "Different name — type it". The name is `dir="auto"` and clamped to two
  lines so its first words show.
- **Weight**: a muted `—` when empty, a fixed hint line ("Weight must be more
  than 0" in red), a 50 px keypad.
- **Expiry**: "Pick the expiry date from the sticker" (amber) / "Change date";
  the calendar has no preselected day (`requirePick`, now the default for
  every form) — the old silent
  "today" is how 64 tilapia cartons got their receiving day as expiry. Stored
  as ISO `YYYY-MM-DD`, shown as `DD/MM/YYYY`.
- **Save**: grey and disabled with nothing to save; amber + warning when it
  saves but the carton keeps its warning; blue + check when complete. A
  flagged or barcode-conflict carton can always be saved, even untouched.
- Errors (typed barcode too short / duplicate, a failed mint) show in a red
  strip **inside** the panel; they never leak into the scan footer.
- **Batch is a row, not a fourth tab**: `supplier_batch` is filled by the OCR
  only when the label prints an explicit `מנה`/`אצווה`/`לוט`/`Batch`/`Lot`
  heading; blank is valid and nothing gates on it.
- A restored-from-cache box has no `image_data`; the panel shows "No photo for
  this carton".

## All-done view — pallet sticker list

After every pallet is confirmed (and any loose boxes finalised), `phase === 'all_done'` renders the "All pallets received" card: pallet and carton counts, then **`PriorityPushStatus`** right under the stats (so a long pallet list cannot push it off screen — see "Priority push" above), a list of every confirmed pallet as a tappable card (`LPN`, pallet number; `<a href="/pallet/{lpn}?token={session_token}" target="_blank">`, so it opens in a new tab without disturbing the scanner), a **Reprint labels** row that opens the Labels screen, and the loose-box note (no physical sticker is needed for loose pallets). There is no button to send anything.

The list reads from `session.completed_pallets`. `handleConfirmPallet` mirrors each successful API confirm into local React state (the API persists the session to Supabase but the page never refetches), so by the time the worker reaches `all_done` every pallet they confirmed in this session is in the list — even on a fresh-mount session that had completed_pallets prefilled from a mid-flow refresh.

## Pallet sticker page (`/sticker/v1/[lpn]`, legacy alias `/pallet/[lpn]`)

Server component that reads the pallet from Supabase (`from('pallets')`) and uses route-level ISR (`export const revalidate = 60`) instead of the former per-fetch `next: { revalidate: 60 }`. It also reads `searchParams.token`.

> **The sticker renders the denormalised display columns on the `pallets` row**
> (`item_name`, `box_count`, `document_number`, ocr/calc weights) — it does not
> aggregate `pallet_items`. `create_pallet_record` writes only lifecycle fields,
> so the bot must backfill those columns via
> `airtable_service.update_pallet_display_fields` on **every** pallet-creation
> path. Without the backfill every multi-pallet sticker printed
> `0 boxes / 0 kg / blank` (fixed 2026-07-09). A Mix pallet's item line reads
> "Mix — N items".
>
> QR payload is `{scanner}/sticker/v1/{lpn}?sig=WHPL-…`, where the signature is
> `sha256(LPN_SECRET + lpn)[:8]` — the **same `LPN_SECRET`** must be set on both
> Railway and Vercel. If present, the "← Back" button routes to `/pallet-verify/{token}` (returning the worker to their active scanner session) instead of the homepage `/`. All sticker links generated by the scanner already include `?token=…` for this round-trip. Direct visits from WhatsApp's bot messages have no token and fall back to `/`.

## Important Implementation Notes

- **`box_sku` ≠ `item_code`**: the `box_sku` column (surfaced to legacy code as the `Box SKU` field by `lib/supabase.ts`) stores the full barcode string. Never use it as a product identifier. Use the `Pallet Item` link for filtering in pallet context.
- **Barcodes are IDs only**: `parseIsraeliBarcode()` intentionally returns `weight: 0`. Weight/item data comes exclusively from OCR. Never assume barcode encodes product details.
- **Pallet OCR item matching**: Hebrew-first matching using first significant Hebrew word (≥3 chars). Never use barcode string for item matching.
- **Loose box OCR**: Uses same `/api/multi-pallet-ocr` (synchronous) as pallet box OCR. Each loose box fires OCR immediately on scan.
- **Uniform weight override**: If the stored data has `Uniform Weight = true` but actual Box Inventory rows show weight variance >0.5kg, the bot overrides to non-uniform at outbound time. (This 0.5 kg is the *bot's outbound sanity check* and is unrelated to the scanner's 0.0001 kg inbound rule — don't conflate them.)
- **Synthetic Box Inventory rows**: For uniform pallets, inbound stores only 2 sample rows. Outbound creates synthetic rows for the shortfall before marking as Issued.
- **Loose pallet LPN**: `LOOSE-{YYYYMMDD}-{docShort}` — no physical sticker printed, system tracking only.

## Verifying UI changes (no writes to the warehouse)

Local dev cannot mint a session — `.env.local` has no `SUPABASE_*`. Verify on a
**deployed** build instead:

1. `POST /api/multi-pallet-session` with a `UI-VERIFY-…` document number. This is
   inert: it creates a `scan_sessions` row and no delivery.
2. Seed `localStorage['pv:{token}:p{n}']` with a `PalletScanSnapshot`. `image_data`
   is stripped on save but **not** on load, so hand-seeding it is the only way to
   get a sticker photo into the edit panel without a camera.
3. Open `/pallet-verify/{token}`, hide the `.bg-cam-scrim` permission overlay, and
   measure real rects.
4. To exercise a confirm without writing: monkey-patch `window.fetch` to intercept
   only `/api/multi-pallet-complete` and assert on the captured body.
5. Afterwards `delete from scan_sessions where token = …` and check `pallets`
   gained nothing.

Gotchas: a **READY build is not proof the code shipped** — check which commit the
production alias serves, and grep the live chunk for a distinctive string. Chrome's
window will not go below **500px** wide, so `resize_page(400, …)` silently reports
success at 500. Each new preview deployment invalidates the Vercel SSO share
cookie. And a test harness must reproduce the **real** chrome of the screen under
test — a stub footer is what hid the sheet outage.

**Last Updated**: 2026-10-01 (floor-feedback release on `preview`: one-tap next pallet, save-now/print-later labels + the print gate, already-counted notices, the edit panel rewrite, ISO expiries, the automatic-Priority status row; the DB push migration is NOT applied and the push stays off) · previously 2026-09-04 (Priority capture fields, batch row, barcode-vs-OCR cross-check) | Working branch: `preview` | Production branch: `main`
