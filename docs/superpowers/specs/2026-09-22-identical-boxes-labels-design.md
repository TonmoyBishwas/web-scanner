# Identical boxes → unique printed labels (replaces the shared-label opt-in)

**Date:** 2026-09-22 · **Status:** approved in chat (Tonmoy), building
**Scope:** web-scanner (`preview` → `main`), Supabase `carton_labels`, bot docs only

## 1. Problem

Some products print the **same barcode on every carton** (fixed-weight goods:
kebabonim, fish, produce cartons). For such an item the name, weight and expiry
are identical across the boxes too. The scanner dedupes on the barcode, so only
one of N cartons could ever be booked.

Two fixes were tried on 2026-09-17/20 and both are being withdrawn:

1. count repeat reads as new cartons (fragile — a phone left on one box);
2. the **shared-label opt-in** now on prod (`main` = `0013a70`): a barcode of
   ≤ 14 digits is *assumed* to be a product label, the footer asks "scan each
   box one by one?", and a `RepeatGate` lifts the duplicate refusal for that
   code. Tonmoy's floor test on 2026-09-22: it does not work well, and the
   system — not the worker — decides which items are "shared-label".

Outbound is the other half of the problem: N boxes that share one barcode
cannot be told apart when a box sticker is photographed on the way out.

## 2. Decision

* **Revert** the shared-label opt-in entirely: no digit-length rule, no
  `RepeatGate`, no `-B/-C` repeat keys, no `allowRepeat`. A barcode is deduped
  on its digits, whatever its length. Two things from the same commit range
  are **kept**: the misread refusal (SCN-13: under 12 digits, or a 12–14-digit
  read failing the GTIN check digit, is refused with the digits shown) and
  "0 pallets + loose boxes opens the loose phase" (BOT-30).
* **Build** a user-declared path: the worker captures **one** box, taps
  **"All boxes identical → print labels"** on its row, checks/edits the name,
  weight, expiry, production date, types the count N, and the scanner mints N
  **unique** barcodes (the existing `carton_labels` machinery: `28` + YYMMDD +
  8 random digits, GS1 internal prefix, Code 128 sticker, browser print). The
  N boxes are **booked directly** when the pallet (or loose pile) is confirmed
  — one `box_inventory` row each, each with its own minted barcode. The worker
  prints the stickers and puts one on each box. Outbound photographs a printed
  sticker → `find_box_by_barcode` finds exactly that row.
* **Only the worker decides.** Nothing in the system offers this path from the
  barcode's shape. The action sits on every captured row, in both the pallet
  phase and the loose phase.

Answers Tonmoy gave (2026-09-22): book directly (no scanning the printed
labels back); entry only after one box is captured (OCR prefills, fields stay
editable); sticker = item + weight + expiry + minted barcode (supplier barcode
stored, not printed); ship to production once verified.

## 3. What the worker sees

Pallet phase (and, identically, the loose phase):

1. Scans / tap-captures one carton as today. OCR fills name, weight, expiry.
2. Taps the row → row actions now show **Edit · Delete · All boxes identical**
   (he: `כל הקרטונים זהים`). The third action is hidden while the row is still
   OCR-processing, and on a `NOBC-`/`MANUAL-` provisional row without digits.
3. An overlay opens (same look as *New carton*'s form step, no item picker):
   * item name (he/en, read-only line from the row, editable name is out of
     scope — the row's Edit already covers it),
   * **weight per carton (kg)** — required, > 0, prefilled from OCR,
   * expiry date, production date — prefilled, editable via the calendar,
   * **how many cartons** — required, 1‥500,
   * sticker preview (real `CartonSticker`).
   Primary button: **Create N labels**.
4. On success the overlay shows **Print N labels** (opens the existing
   `/labels/print` sheet, `window.open` synchronously in the click) and
   **Done**. The Labels chip (`מדבקות`) can reprint any batch later.
5. The scan list now holds N rows for that item (the captured box's photo on
   the first row; the same `image_url` on all N), each with its own minted
   barcode. The header carton counter counts N. The single-item shortcut
   prompt does not fire for minted rows. The pallet-total input is prefilled
   with the committed count when minted rows exist.
6. Confirm pallet as today. Delete on a minted row removes that one box (a
   damaged carton); the printed sticker for it is simply not used.

Scanning a printed minted sticker back in during the same job is refused as a
duplicate (that box is already on the list).

## 4. Data

`carton_labels` (existing, one row per physical carton) gains:

| column | type | meaning |
|---|---|---|
| `origin` | `text not null default 'new_carton'` | `'new_carton'` (New carton chip) or `'identical'` (this feature) |
| `source_barcode` | `text` | the supplier barcode read off the captured sample carton (the shared one) |
| `pallet_number` | `int` | pallet the batch was minted on; `0` = loose pile |

Existing columns carry the rest: `barcode` (unique, minted), `serial`,
`batch_id`, `session_token`, `document_number`, `item_code`, names,
`weight_kg`, `quantity`, `production_date`, `expiry_date`, `status`,
`print_count`. Migration is additive; applied live with the Supabase MCP and
kept as SQL under `web-scanner/docs/migrations/`.

`box_inventory` (bot-written, unchanged schema): `barcode` = minted code,
`box_sku` = the 13-digit prefix of `source_barcode` (so per-SKU queries still
group the product), weight/expiry/production_date from the form. The join
between a stock row and its label row is the barcode.

Wire contract `/api/multi-pallet-complete` and `/api/multi-pallet-loose-complete`:
**unchanged**. Minted rows travel as ordinary `scanned_boxes` entries. The
server's uniform detection sees N identical weights and books N (the mix
branch `override?.total_count ?? itemBoxes.length`, the single branch
`box_count || itemBoxes.length`); nothing is multiplied by a declared count
that the rows do not already represent. The bot writes one row per box.

## 5. Components

Scanner:

* `lib/carton-barcode.ts` — reduced to `digitsOf`, `gtinCheckDigitValid`,
  `classifyRead` (+ test). `REPEAT_SUFFIX_RE`, `baseBarcode`,
  `isPerCartonUnique`, `repeatKey` deleted.
* `lib/repeat-gate.ts` + test — deleted. `SmartScanner.allowRepeat` and the
  gate wiring — deleted (the `git revert` of `a3d978d`).
* `app/pallet-verify/[token]/page.tsx` — LabelPrompt state/handlers/footer
  removed (reverts of `a3d978d`, `071248f`, `1288a96`, and the repeat half of
  `37ee47e`). New: `BoxScan.minted?: boolean`, `BoxScan.label_batch_id?`,
  row action, overlay wiring for both phases, `expandIdenticalBoxes`,
  minted-aware `uniformCandidateFrom`, prefilled pallet total.
* `lib/identical-boxes.ts` (+ vitest) — pure helpers: `sourceSku(barcode)`,
  `expandIdenticalBoxes(sample, labels, form)` → N `BoxScan`s.
* `components/terminal/IdenticalBoxesForm.tsx` — the overlay (form → created
  → print), built from `CartonCreator`'s form step.
* `app/api/carton-labels/route.ts` POST — accepts `origin`, `source_barcode`,
  `pallet_number`; `lib/carton-labels.ts` writes them; `CartonLabel` type
  extended. The Labels browser shows the batch like any other.
* i18n `en.ts` / `he.ts` — `identical.*` keys; `palletVerify.labelCount*`
  keys removed.

Bot: **no code change**. `find_box_by_barcode`'s "prefer an Available row"
ordering stays (harmless). Docs: `HOW_IT_WORKS.md` scenario, `CLAUDE.md`
demo-day section, `SCANNER_REFERENCE.md`/`ARCHITECTURE.md`.

## 6. Error handling

* Label minting fails (network/401/500) → toast, the sample row is untouched,
  nothing booked.
* Print window blocked → toast (`labels.printBlocked`); rows already exist,
  reprint from the Labels chip.
* Weight ≤ 0 or count < 1 → inline validation, button disabled.
* Session expired → `carton.sessionExpired` toast (existing key).
* A reload mid-pallet restores the N rows from the local snapshot (they are
  ordinary `BoxScan`s in `scannedBoxes`/`looseBoxes`).

## 7. Testing

* vitest: `lib/carton-barcode.test.ts` trimmed; new `lib/identical-boxes.test.ts`
  (N rows, unique barcodes, sku = 13-digit prefix, weight/expiry from the
  form, first row keeps the photo, all rows minted, batch id carried).
* `npm run build` + `npm run lint` + `npm test` green.
* Rendered-page check with the fake-camera recipe (stubbed fetch for
  session/ocr/upload/complete, `window.__bc` barcode injection): capture one
  box → row action → form → N rows in the list → confirm posts N
  `scanned_boxes` with distinct 16-digit `28…` barcodes and the sample's sku;
  scanning a minted barcode back is refused; loose phase same.
* Live DB: after the migration, one real `POST /api/carton-labels` with
  `origin: 'identical'` from a seeded session, then purge the QA rows.

## 8. Ship

Backup ref `backup/main-pre-identical-2026-09-22`; graph-mirror `preview` →
`main` (`--ship-scanner`); state prod sha + rollback. Bot docs to `whatsapp`.
