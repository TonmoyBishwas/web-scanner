# Pallet Inbound — Scenario Detection (Before / After)

**Screen:** `/pallet-verify/[token]` (`app/pallet-verify/[token]/page.tsx`)
**Changed:** 2026-05-31 (branch `preview`, commits `31dacb6` + `3f56e30`)
**Scope:** Frontend + the `/api/multi-pallet-complete` classifier only. No bot,
Airtable, Redis, or API-shape changes.

This is the flow where a worker scans the boxes on an inbound pallet so the
system can decide whether it's a **single-item** pallet (scan a few samples +
enter a count) or a **mix** pallet (scan every box).

---

## The problem this fixed

Two different questions used to appear around the same time and fight for the
same spot in the footer:

1. **"How many boxes on this pallet?"** — appeared after only **2 scans**.
2. **"What is on this pallet?"** — a 3-option card
   (*only this product / other products too / same product, weights vary —
   scan each box*).

Because OCR finishes **asynchronously** (each box is read a moment after it's
scanned), the second box's OCR could complete *while* the worker was already
looking at the "how many boxes" input — so the footer would suddenly swap to
the 3-option card. That's the "both come at the same time, confusing" report.
The third option was also a tiny grey underline link, barely tappable.

A second correctness bug: "same weight" allowed a **0.5 kg grace band**, so
catch-weight boxes that merely looked close (e.g. `10.090` vs `10.080`, 10 g
apart) were wrongly treated as one uniform weight — which would skip scanning
them and undercount the pallet.

---

## Before vs After (summary)

| Aspect | Before | After |
|---|---|---|
| When it asks | After **2** scans | After **4** boxes scanned **AND** all OCR finished (none still "reading…") |
| How it decides | Fired mid-OCR off 2 samples | **Derived** from the 4 completed scans → prompts can never overlap |
| Prompts on screen | Up to two could collide | Exactly **one** at a time |
| "Same weight" rule | Within **0.5 kg** (grace band) | **Exactly equal** (0.1 g float-noise epsilon only) |
| Mix pallet completion | Per-item count shortcut (scan some, count others) | **Scan every box** + enter total (confirm blocked until scanned ≥ total) |
| Tiny "scan each box" link | Present | **Removed** |
| <4-box pallet | n/a | Subtle "Fewer than 4 boxes? Tap to finish" escape |

---

## How it works NOW

Once **4 boxes are scanned and all have finished OCR**, the system inspects the
completed scans and auto-picks one path:

| What the 4 boxes show | Path |
|---|---|
| Same name **+ exactly same weight** | Ask one choice (Scenario A) |
| Same name **+ any weight difference** | Mix — scan every box (Scenario B) |
| **2+ different names** | Mix — scan every box (Scenario C) |

"Same weight" now means *exactly* equal. The internal tolerance is `0.0001 kg`
(0.1 g), which is below the 1 g resolution printed on labels — it exists only to
absorb floating-point noise, **not** as a real grace band.

---

## Scenarios & examples

### Scenario A — Single-item pallet (1 product, all EXACTLY the same weight)

> **Example:** A pallet of fixed-weight frozen chicken breast, every box stamped
> `10.8 kg`. Scan 4 boxes; all read the same name and `10.8`.

One question appears:

> **"Same product, same weight. Is this the only product on the pallet?"**
> - **[ Yes — only this product ]**
> - **[ No — other products too ]**

- **Yes — only this product** → asks **"How many boxes on this pallet?"**.
  Enter the real total (e.g. **65**). System does 65 × 10.8 kg, locks the single
  item, finishes the pallet. **You do NOT scan all 65** — 4 samples + the count.
  *(This is the ONLY scenario where counting replaces scanning.)*
- **No — other products too** → becomes a mix → goes to the mix path below.

*Why ask at all?* 4 identical boxes can't tell a true single-item pallet apart
from one where the other product just hasn't been reached yet. Only the worker
knows, so it asks once, clearly.

### Scenario B — Mix (a): one product, weights vary

> **Example:** A pallet of fresh ribeye, same item but each box a different catch
> weight — `10.8`, `10.090`, `10.080`, `9.7` …

**No choice card.** One name but the weights differ (even by ~10 g), so every box
is unique and must be recorded individually.

> Shows **"How many boxes total on this pallet?"** → enter total (e.g. **40**) →
> **scan all 40**. Confirm stays locked until scanned ≥ 40 (warns if you scan
> more than the declared total).

### Scenario C — Mix (b): more than one product

> **Example:** A pallet with chicken wings, beef mince, and lamb chops together.

**No choice card.** 2+ different names in the first 4 scans → mix, regardless of
weights.

> Same as B: enter the total → **scan every box** → confirm when scanned ≥ total.

### Edge case — fewer than 4 boxes on the pallet

> **Example:** A short pallet with only 3 boxes.

Classification needs 4 scans, so once 1–3 boxes are scanned and read, a small
link appears: **"Fewer than 4 boxes? Tap to finish"**, which routes to the
mix/total path so the worker is never stuck.

---

## The exact-weight rule in action

Using your example weights on a one-product pallet:

| Boxes read | Before (0.5 kg grace) | After (exact) |
|---|---|---|
| `10.8, 10.8, 10.8, 10.8` | single | **single** (count × weight) |
| `10.8, 10.090, 10.080` | range 0.72 kg → mix | **mix** (scan all) |
| `10.090, 10.080` (10 g apart) | range 0.01 kg → **wrongly single** | **mix** (scan all) |
| `10.081, 10.080` (1 g apart) | wrongly single | **mix** (scan all) |

The change errs toward "scan everything" — the safe direction (never
undercounts). Caveat: OCR must read the decimals accurately; if the model misreads
`10.09` as `10.1` on one box, that box correctly pushes the pallet to mix. Worth
watching during field testing whether weight-OCR precision is good enough that
genuinely fixed-weight pallets still read as single.

---

## What stayed the same

- **Server/bot/Airtable contract unchanged.** Single pallets still send
  `uniform_groups` with one entry (count × weight); mix pallets send an empty
  `uniform_groups` so the server uses per-item scanned counts. `pallet_type`
  (single/mix) is still derived server-side in
  `app/api/multi-pallet-complete/route.ts`.
- Barcode-vs-OCR identity, AI name-consolidation, the "fix this box" warnings
  that block confirm, per-pallet reset between pallets, and loose-box scanning
  are all untouched.

---

## Code touch points (for maintainers)

The "same weight" tolerance is mirrored and must stay in sync:

- `app/pallet-verify/[token]/page.tsx`
  - `UNIFORM_WEIGHT_TOLERANCE = 0.0001`
  - `detectType()` — single/mix badge + label
  - `maybeTriggerUniformPrompt()` — classify after ≥4 OCR'd boxes; raises the
    single-vs-mix choice only for the exact-weight single-product case
  - footer: single-or-mix choice → pallet-total input → Confirm; plus the
    "fewer than 4 boxes" escape
- `app/api/multi-pallet-complete/route.ts`
  - `UNIFORM_WEIGHT_TOLERANCE_KG = 0.0001`
  - `detectPalletType()` — the `pallet_type` sent to the bot
  - per-item `isUniform` weight calc
