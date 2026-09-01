# Web Scanner Documentation

Detailed documentation for the Web Scanner component of the warehouse system.

## Contents

- [**Architecture**](./ARCHITECTURE.md): the Next.js app, the terminal design kit, Supabase integration, page/API inventory, and the pallet-verify state machine.
- [**API Reference**](./API_REFERENCE.md): all 25 API routes with request/response shapes.
- [**Pallet Scenario Detection**](./PALLET_SCENARIO_DETECTION.md): how an inbound pallet is classified single-item vs mix, and why "same weight" means *exactly* equal.

Cross-project context (bot + scanner together) lives in the repo-root `CLAUDE.md`.

## Quick Start for Developers

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Environment variables** (`.env.local`):
   - `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` — the data layer (sessions, locks, records) **and** image uploads to Storage (bucket `warehouse-images`). Server-side only: the service-role key bypasses RLS and must never reach the browser.
   - `TELEGRAM_BOT_WEBHOOK_URL` — the Python bot's base URL (e.g. `https://web-production-f2759.up.railway.app`).
   - `NEXT_PUBLIC_APP_URL` — the public scanner URL.
   - `OPENROUTER_API_KEY` — LLM invoice matching / name consolidation.
   - `LPN_SECRET` — shared HMAC secret for LPN sticker QR signatures (must match the bot's).

   Removed in the 2026-06-30 migration: `REDIS_URL`, `KV_REST_API_*`, all `AIRTABLE_*`. Removed 2026-07-09: all `CLOUDINARY_*`.

3. **Run the dev server**:
   ```bash
   npm run dev      # http://localhost:3000
   npm run build
   npm run lint     # baseline is 615 problems / 63 errors — compare against that, not zero
   npm test         # vitest — pure logic only, no network or DB
   ```

4. **Simulate a session**: sessions are created by the bot. `POST /api/multi-pallet-session` mints one directly (inert — it creates a `scan_sessions` row and no delivery), then open `/pallet-verify/<token>`. ⚠️ The committed `.env.local` is stale and carries no `SUPABASE_*`, so a local server cannot mint or read sessions — verify against a deployed preview instead. See "Verifying UI changes" in [ARCHITECTURE.md](./ARCHITECTURE.md).

## Branch & Deployment

- **Working branch**: `preview`.
- **Vercel PRODUCTION branch: `main`.** Pushing `preview` (or the older `pallet-flow`) produces a **preview** deployment only.
- Shipping = a tree-identical "graph mirror" merge of `preview` into `main`, or promoting a ready build in the Vercel dashboard. **Pushing `main` deploys to the warehouse** — treat it as the deploy step, not as bookkeeping.
- **Redeploy IS required after changing Vercel env vars.**
- A READY build is not proof the code shipped: confirm which commit the production alias serves and grep the live chunk for a distinctive string.

*(The previous version of this file said Vercel deploys from `pallet-flow` and "don't push to `main`". Both were wrong and are the opposite of the truth.)*

---

**Last Updated**: 2026-08-14
