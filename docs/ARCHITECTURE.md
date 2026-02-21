# Web Scanner Architecture

## Overview
The Web Scanner is a Next.js 15 application designed to provide a high-performance, mobile-first barcode scanning interface for the warehouse management system. It replaces the previous Telegram-based scanning flow to offer faster scanning, better OCR feedback, and a more robust user experience.

## Branch & Deployment

- **Active branch**: `main`
- **Vercel deploys from**: `main` (automatic on push)
- The `scanner-ui-v2` branch was merged (force-pushed) into `main` and is no longer a separate branch.

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

## API Routes (`app/api/`)

### 1. `/api/scan` (POST)
- **Purpose**: fast-path for recording a barcode scan.
- **Logic**:
    - Validates session token.
    - Locks session (Redis) to prevent race conditions.
    - Adds barcode to `scanned_barcodes` set.
    - Triggers implicit "Scanning..." status.
    - Returns updated count.

### 2. `/api/ocr` (POST)
- **Purpose**: Triggers the heavy AI processing.
- **Logic**:
    - Accepts image (base64 or URL).
    - Calls the **Telegram Bot Webhook** (`/webhook/process-box-ocr`) to reuse the Python-based Gemini OCR logic.
    - Updates session status to `pending`.
    - **CRITICAL**: Uses Redis locks to ensure it doesn't overwrite concurrent scans.

### 3. `/api/resolve` (POST)
- **Purpose**: Saves manual corrections.
- **Logic**:
    - Updates specific fields (weight, product_name) for a barcode.
    - Marks status as `manual` or `verified`.
    - Recalculates invoice totals.

### 4. `/api/session` (GET/PUT)
- **Purpose**: Syncs state between Client and Server.
- **GET**: Returns full session object (scanned items, issues, counts).
- **PUT**: Used for "keep-alive" or forcing status updates.

## Data Flow
1. **User Scans Barcode** -> Client checks local cache -> POST `/api/scan`.
2. **User Captures Image** -> Upload to Cloudinary -> POST `/api/ocr`.
3. **Server (Bot)** -> Processes Image (Gemini) -> Updates Redis Session.
4. **Client** -> Polls `/api/session` -> Sees result -> Updates UI (Green tick or Issue Red).
5. **User Resolves Issue** -> POST `/api/resolve` -> UI Updates.
6. **User Confirms** -> POST `/api/complete` -> Triggers webhook to save to Airtable.
