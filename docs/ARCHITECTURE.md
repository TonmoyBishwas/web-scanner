# Web Scanner Architecture

## Overview
The Web Scanner is a Next.js 15 application designed to provide a high-performance, mobile-first barcode scanning interface for the warehouse management system. It replaces the previous Telegram-based scanning flow to offer faster scanning, better OCR feedback, and a more robust user experience.

## Tech Stack
- **Framework**: Next.js 15 (App Router)
- **Language**: TypeScript
- **Styling**: Tailwind CSS (via `globals.css`)
- **State Management**: React Hooks (`useState`, `useReducer`, `useRef`) + URL State
- **Database/Cache**: Redis (Upstash) for session management
- **Scanning Library**: `html5-qrcode` (optimized for mobile web)
- **Image Storage**: Cloudinary (via API proxy)

## Core Components

### 1. `app/scan/[token]/page.tsx`
The heart of the application. This single page handles the entire scanning workflow.
- **State Machine**: Manages phases: `scanning` -> `processing` -> `issues` -> `ready_confirm` -> `complete`.
- **Hardware Access**: Manages camera permissions and stream.
- **Optimistic UI**: Updates counts and lists immediately while syncing with the server in the background.
- **Polling**: Periodically fetches session status from `/api/session` to sync with backend OCR processes.

### 2. `components/scanner/SmartScanner.tsx`
A wrapper around `html5-qrcode` that handles:
- Camera selection (environment facing).
- scan region definitions.
- Debouncing detailed scans.
- Handling "duplicate scan" logic locally to prevent API spam.

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
