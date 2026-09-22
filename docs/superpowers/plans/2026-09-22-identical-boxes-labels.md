# Identical Boxes → Unique Printed Labels — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the automatic shared-label opt-in from the scanner and replace it with a worker-declared "all boxes identical" action that mints one unique printed barcode per carton and books N boxes directly.

**Architecture:** Three `git revert`s plus a hand-strip of the repeat half of `37ee47e` restore strict barcode dedupe (misread refusal and 0-pallets kept). A new overlay on pallet-verify reuses the existing `carton_labels` minting/printing stack; the N minted labels become ordinary `BoxScan` rows so the completion routes and the bot are untouched.

**Tech Stack:** Next.js 16 / React / TypeScript / Tailwind, vitest, Supabase (`carton_labels`), existing `CartonSticker` + `/labels/print`.

**Spec:** `docs/superpowers/specs/2026-09-22-identical-boxes-labels-design.md`

## Global Constraints

- Nothing in the system may trigger the identical-boxes path from the barcode's shape; only the worker's tap.
- Wire contracts of `/api/multi-pallet-complete` and `/api/multi-pallet-loose-complete` stay unchanged.
- Bot code unchanged (docs only).
- Hebrew copy first; Tonmoy does not read Hebrew — gloss every string in reports.
- Keep SCN-13 misread refusal (`classifyRead`) and BOT-30 (`pallet_count 0` + loose).
- Ship: backup ref `backup/main-pre-identical-2026-09-22`, then graph-mirror `preview` → `main`.

---

### Task 1: Revert the shared-label opt-in

**Files:**
- Modify: `app/pallet-verify/[token]/page.tsx`, `components/scanner/SmartScanner.tsx`, `lib/i18n/en.ts`, `lib/i18n/he.ts`, `lib/carton-barcode.ts`, `lib/carton-barcode.test.ts`, `docs/ARCHITECTURE.md`
- Delete: `lib/repeat-gate.ts`, `lib/repeat-gate.test.ts`

- [ ] `git revert --no-commit a3d978d 071248f 1288a96` (resolve conflicts against the perf commits; SmartScanner keeps the perf pacing, loses `allowRepeat`/`RepeatGate`).
- [ ] Hand-strip the repeat half of `37ee47e` in page.tsx: `processedRef.has(read)` → plain duplicate refusal in both phases; OCR-digit dedupe (`dup` → drop, no `repeatKey`); typed-barcode clash check unconditional; `isDuplicateBarcode` = `processedRef.has(b.trim())`; `stripProvisionalIds` no longer maps `baseBarcode`; `/api/multi-pallet-ocr` gets `lookupKey` directly. Remove the import of `baseBarcode/isPerCartonUnique/repeatKey/REPEAT_SUFFIX_RE`.
- [ ] Trim `lib/carton-barcode.ts` to `digitsOf`, `gtinCheckDigitValid`, `classifyRead`; rewrite header comment; trim the test file to those.
- [ ] `rm lib/repeat-gate.ts lib/repeat-gate.test.ts`; remove the `palletVerify.labelCount*` i18n keys.
- [ ] `npm test && npm run lint && npm run build` green. Commit: `revert(scanner): drop the shared-label opt-in and repeat gate; keep misread refusal + 0-pallet loose`.

### Task 2: `carton_labels` columns + API

**Files:**
- Create: `docs/migrations/2026-09-22-carton-labels-identical.sql`
- Modify: `types/index.ts` (CartonLabel), `lib/carton-labels.ts`, `app/api/carton-labels/route.ts`

**Produces:** `CreateCartonBatchInput.{origin?: 'new_carton'|'identical'; sourceBarcode?: string|null; palletNumber?: number|null}`; POST body fields `origin`, `source_barcode`, `pallet_number`; response `labels[]` include the new columns.

- [ ] Apply live via Supabase MCP and save the SQL:
```sql
alter table public.carton_labels
  add column if not exists origin text not null default 'new_carton',
  add column if not exists source_barcode text,
  add column if not exists pallet_number integer;
create index if not exists carton_labels_source_barcode_idx on public.carton_labels (source_barcode);
```
- [ ] Extend `COLUMNS`, the insert row, the type; validate in the route (`origin` ∈ {new_carton, identical}, `source_barcode` digits ≤ 40 chars, `pallet_number` int ≥ 0).
- [ ] Commit: `feat(scanner): carton_labels carries origin / source_barcode / pallet_number`.

### Task 3: Pure helper `lib/identical-boxes.ts` (TDD)

**Produces:**
```ts
export function sourceSku(barcode: string): string;            // 13-digit prefix of the digits, or the digits
export interface IdenticalForm { weight: number; expiry: string; production_date: string; }
export function expandIdenticalBoxes<T extends MultiPalletBoxScan & {image_data?: string}>(
  sample: T, labels: Array<{ barcode: string; batch_id: string }>, form: IdenticalForm): T[];
```
Rows: `barcode = label.barcode`, `sku = sourceSku(sample.barcode)`, `weight/expiry/production_date` from the form, `minted: true`, `label_batch_id`, `image_data` only on row 0, `image_url` on all, `scanned_at` now, `needs_review`/`barcode_conflict` cleared.

- [ ] Write `lib/identical-boxes.test.ts` (N rows, unique barcodes, sku, photo on first only, form values applied) → run, fail → implement → pass → commit.

### Task 4: `IdenticalBoxesForm` overlay

**Files:** Create `components/terminal/IdenticalBoxesForm.tsx`; i18n `identical.*` keys in en/he.

Props: `{ token, language, palletNumber: number, sample: { barcode, item_name, item_name_hebrew, weight, expiry, production_date, item_code? }, onBack, onCreated(labels, form) }`. Steps `form` → `created` (Print N labels: sync `window.open('/labels/print?token&batches&size=10x15&lang')` + POST `/api/carton-labels/print`; Done). Weight required > 0, count 1‥500, preview via `CartonSticker`.

- [ ] Build, `npm run lint`, commit.

### Task 5: Wire into pallet-verify (both phases)

- [ ] `BoxScan` gains `minted?: boolean; label_batch_id?: string`.
- [ ] State `identicalFor: { box: BoxScan; loose: boolean } | null`; row action "כל הקרטונים זהים" on non-processing, non-provisional rows (pallet + loose).
- [ ] `onCreated`: replace the sample row by `expandIdenticalBoxes(...)`; add minted barcodes to `processedRef`/`looseProcessedRef`; toast.
- [ ] `uniformCandidateFrom` ignores minted rows; the pallet-total input prefills with `committed` when any minted row exists and the input is empty.
- [ ] `npm test && npm run lint && npm run build`; commit.

### Task 6: Verify on the rendered page

- [ ] Fake-camera recipe (stub fetch + `window.__bc`) at 390×844: capture → action → form → N rows → confirm payload has N distinct `28…` barcodes with the sample sku; minted barcode re-scan refused; loose phase same. One live `POST /api/carton-labels` with `origin:'identical'`, then purge QA rows.

### Task 7: Docs + ship

- [ ] `docs/ARCHITECTURE.md`, `docs/SCANNER_REFERENCE.md`, root `CLAUDE.md`, bot `docs/HOW_IT_WORKS.md`; memory update.
- [ ] `git branch backup/main-pre-identical-2026-09-22 origin/main && git push origin backup/main-pre-identical-2026-09-22`; `./scripts/sync-contribution-graph.sh --ship-scanner`; confirm Vercel production deployment; report sha + rollback.
