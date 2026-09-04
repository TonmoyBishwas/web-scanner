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
- **Scanning Library**: Native BarcodeDetector API (hardware-accelerated); fallback: html5-qrcode (@zxing/browser)
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
| `BottomSheet` | The floating sheet. 3 snaps, drag handle, `toolbar` + scrolling children + `footer`. Exposes `snapTo(i)` via ref |
| `ToolDock` | The chip row inside the sheet's toolbar (share / delete / pallets / locked stubs) |
| `ActiveScanCard` | The newest scan — live status dot, big mono weight, details expander, and its actions (edit / delete / retry / view frame) |
| `HistoryRow` | One older scan; tap to expand its action row |
| `EditPanel` | In-sheet edit of a scan (see below) — value tabs, sticker photo, keypad / item chips / calendar |
| `Keypad`, `CalendarPicker` | Context inputs for the edit panel |
| `DoneOverlay`, `SwipeConfirm` (in `shared/`) | Pallet-done stats + RTL swipe-to-confirm actions |
| `SideDrawer`, `DrawerHost`, `ScreenOverlay`, `LockedScreen` | Hamburger drawer, overlay host, "not built yet" screens |
| `PalletsBrowser`, `DocumentsBrowser` | Unlocked drawer features: floor pallet lookup, completed-delivery archive |
| `SplitJobScreen`, `SplitPlanner`, `SplitBoard` | Split-assignment worker/manager UI (`SPLIT_ASSIGNMENT_ENABLED`) |
| `MI` | Material Icons Round ligature wrapper |

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

**27 routes total.** See [API_REFERENCE.md](API_REFERENCE.md) for full request/response docs.

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
| `POST /api/multi-pallet-complete` | Confirm one pallet of a multi-pallet session — classifies single/mix server-side (`detectPalletType`), applies `uniform_groups` overrides, emits the bot webhook |
| `POST /api/multi-pallet-loose-complete` | Submit loose box scans → call bot `/webhook/loose-boxes-complete` (now under `withLock`) |
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
- `scanning` → `confirming` (canConfirm and swipe-confirm completed)
- `confirming` → `pallet_done` (pallet-complete call succeeded)
- `pallet_done` → `scanning` (next pallet, via swipe) OR `loose_scanning` (all pallets done, loose_box_count > 0) OR `all_done` (all done, loose_box_count == 0)
- `loose_scanning` → `loose_confirming` (all loose boxes scanned, confirm tapped)
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
| **מחק / Delete** | `rescanPalletBox` — drops the box and clears `processedRef` for that barcode so the worker can physically rescan. If removing it leaves a locked uniform group with <2 samples, the lock is cleared too |
| **נסה שוב / Retry** *(failed OCR only)* | Re-runs `/api/multi-pallet-ocr` against the stored `image_data` — for transient failures (timeout, server hiccup) |
| **צפה / View** *(failed OCR only)* | Full-screen image modal (`viewingImage`) of the captured frame, so the worker can see whether the photo is genuinely bad |

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

## Edit panel (`components/terminal/EditPanel.tsx`)

Rendered **inside** the bottom sheet in place of the scan list while `editForm`
is set (the sheet's footer is suppressed); `openEdit()` also calls `snapTo(2)`.

The layout is driven by one fact: **the worker is editing because OCR misread the
sticker**, so the sticker photo has to sit next to whatever they are typing into.

```
top bar        ‹ back · קרטון #N · שמור
tab strip      משקל נטו | שם הפריט | ת. תפוגה   ← every value, tap to switch field
context input  [sticker photo] + readout/chips/calendar
               keypad (weight mode)
barcode        read-only — it is the row's identity/dedup key
```

- The photo is 112×86 beside the weight readout, or full-width 104px above the
  name chips (no keypad in that mode, so there is room). Tap it for the
  full-screen viewer. It was previously a 36px thumbnail **below the keypad**
  that had to be tapped open, making "read the sticker" and "correct the value"
  two alternating steps.
- The tab strip replaces the old tall "נתוני המוצר" field boxes, which sat below
  the keypad and were mostly off-screen.
- A restored-from-cache box has no `image_data`, so the panel simply renders
  without a photo.

## All-done view — pallet sticker list

After every pallet is confirmed (and any loose boxes finalised), `phase === 'all_done'` renders a list of every confirmed pallet as a tappable card showing `LPN`, pallet number, declared box count, and `pallet_type`. Each card is `<a href="/pallet/{lpn}?token={session_token}" target="_blank">` so it opens in a new tab without disturbing the scanner. Loose-box count is displayed in a separate orange info card noting that no physical sticker is needed for loose pallets.

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

**Last Updated**: 2026-08-14 (terminal design kit, scan-list actions, edit panel, single-item shortcut at 2 samples, route inventory) | Working branch: `preview` | Production branch: `main`
