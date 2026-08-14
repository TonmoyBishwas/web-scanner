# Pallet Inbound — Scenario Detection (Before / After)

**Screen:** `/pallet-verify/[token]` (`app/pallet-verify/[token]/page.tsx`)
**Changed:** 2026-05-31 (`31dacb6` + `3f56e30`), **revised 2026-08-14 (`c658c5c`)**
**Scope:** Frontend + the `/api/multi-pallet-complete` classifier only. No bot,
Airtable, Redis, or API-shape changes.

> **2026-08-14 revision — the sample threshold is back to 2.** Everything below
> about the *exact-weight* rule still holds. What changed: the May fix raised the
> classification gate from 2 scans to **4** to stop two prompts colliding, but on
> a two-box pallet that left the worker with only the "fewer than 4 boxes" escape
> — which sets `forcedMix`, i.e. *"this is a mix, scan every box"*. Two scans then
> counted against a declared ten and the worker got a false shortfall warning.
> The gate is now `UNIFORM_MIN_SAMPLES = 2` again, and the collision it was
> guarding against is handled directly: **the prompt retracts itself** as soon as
> a later box contradicts it. Read "4" as "2" throughout the sections below.

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

| Aspect | Before | After (May 2026) | **Now (Aug 2026)** |
|---|---|---|---|
| When it asks | After **2** scans | After **4** boxes scanned **AND** all OCR finished (none still "reading…") | After **2** boxes, all OCR finished (`UNIFORM_MIN_SAMPLES = 2`) |
| How it decides | Fired mid-OCR off 2 samples | **Derived** from the 4 completed scans → prompts can never overlap | Derived from the completed scans, and **retracted** if a later box disagrees |
| Prompts on screen | Up to two could collide | Exactly **one** at a time | Exactly one, and it can withdraw itself |
| "Same weight" rule | Within **0.5 kg** (grace band) | **Exactly equal** (0.1 g float-noise epsilon only) | unchanged — exactly equal |
| Mix pallet completion | Per-item count shortcut (scan some, count others) | **Scan every box** + enter total (confirm blocked until scanned ≥ total) | unchanged |
| Tiny "scan each box" link | Present | **Removed** | — |
| Survives a reload | no | no | **yes** — `restoreUniformPrompt` re-derives it from the cache |
| Short-pallet escape | n/a | grey "Fewer than 4 boxes? Tap to finish" link | full-width **"Done scanning? Enter the pallet total"** button |

---

## How it works NOW

Once **2 boxes are scanned and all have finished OCR**, the system inspects the
completed scans and auto-picks one path:

| What the boxes show | Path |
|---|---|
| Same name **+ exactly same weight** | Ask one choice (Scenario A) |
| Same name **+ any weight difference** | Mix — scan every box (Scenario B) |
| **2+ different names** | Mix — scan every box (Scenario C) |

If the choice is on screen and the **next** box breaks the pattern — a second
product, or a different weight — the choice is withdrawn and the pallet falls to
the mix path on its own. The worker never has to undo anything.

"Same weight" now means *exactly* equal. The internal tolerance is `0.0001 kg`
(0.1 g), which is below the 1 g resolution printed on labels — it exists only to
absorb floating-point noise, **not** as a real grace band.

---

## Scenarios & examples

### Scenario A — Single-item pallet (1 product, all EXACTLY the same weight)

> **Example:** A pallet of fixed-weight frozen chicken breast, every box stamped
> `10.8 kg`. Scan 2 boxes; both read the same name and `10.8`.

One question appears:

> **"Same product, same weight. Is this the only product on the pallet?"**
> - **[ Yes — only this product ]**
> - **[ No — other products too ]**

- **Yes — only this product** → asks **"How many boxes on this pallet?"**.
  Enter the real total (e.g. **65**). System does 65 × 10.8 kg, locks the single
  item, finishes the pallet. **You do NOT scan all 65** — 2 samples + the count.
  *(This is the ONLY scenario where counting replaces scanning.)*
- **No — other products too** → becomes a mix → goes to the mix path below.

*Why ask at all?* Identical boxes can't tell a true single-item pallet apart
from one where the other product just hasn't been reached yet. Only the worker
knows, so it asks once, clearly.

> ⚠️ **The tradeoff of asking at 2** (accepted deliberately): on a genuine mix
> pallet whose first two boxes happen to match, the choice appears early, and a
> mistaken *"Yes — only this product"* books the whole pallet as one item. The
> guard is that the prompt is offered, not forced — and it retracts itself the
> moment a later scan disagrees.

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

**No choice card.** 2+ different names among the completed scans → mix,
regardless of weights.

> Same as B: enter the total → **scan every box** → confirm when scanned ≥ total.

### Edge case — a pallet the scanner can't classify

> **Example:** a short pallet of 3 boxes that aren't all one uniform item.

Once 1–3 boxes are scanned and read with no shortcut on offer, the footer shows
a full-width **"Done scanning? Enter the pallet total"** button, which routes to
the mix/total path so the worker is never stuck.

It was previously a thin grey underline reading *"Fewer than 4 boxes? Tap to
finish"* — easy to miss, and easy to tap by accident on a pallet that *was*
uniform, which is exactly how the false-shortfall report arose. It now carries
the same visual weight as the other footer actions.

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
  - `UNIFORM_WEIGHT_TOLERANCE = 0.0001`, `UNIFORM_MIN_SAMPLES = 2`
  - `detectType()` — single/mix badge + label
  - `uniformCandidateFrom(done, merges)` — the shared predicate (≥2 done boxes,
    one group key, weight spread < tolerance)
  - `maybeTriggerUniformPrompt()` — raises the choice for the exact-weight
    single-product case, **and clears an open prompt when the candidate no
    longer holds**
  - `restoreUniformPrompt(cached)` — re-derives it after a reload, reading the
    *cached* flags (the refs aren't synced yet at that point)
  - `handlePalletCountSubmit()` → `handleConfirmPallet({boxCount, groups})` —
    the declared count and locked groups are passed **explicitly**; reading them
    from state inside the deferred callback posted `box_count: 0`
  - footer: single-or-mix choice → pallet-total input → swipe Confirm; plus the
    "Done scanning?" escape
- `app/api/multi-pallet-complete/route.ts`
  - `UNIFORM_WEIGHT_TOLERANCE_KG = 0.0001`
  - `detectPalletType()` — the `pallet_type` sent to the bot
  - `totalBoxes = uniform_weight ? (box_count || itemBoxes.length) : itemBoxes.length`
    — that `||` fallback is what silently turned a lost `box_count` into the
    sample count
  - per-item `isUniform` weight calc
