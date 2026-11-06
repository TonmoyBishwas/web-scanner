# Non-meat receive form v3

The worker-facing non-meat receive form from Mevaser's approved Claude Design ("Non-Meat Receive
Form", approved 01/11): step 1 pallets, the loose-items screen, numbered cards with a 3-step rail
(packaging and quantity, expiry, pallet), the confirmation and a status screen that ends back in
WhatsApp. Behind the flag `receive_form_v3`, **off**. With the flag off, every page and API answer
is exactly as before.

## The flag

v3 is on for a form only when **both** hold:

1. `public.scanner_flags` row `flag = 'receive_form_v3'` is on for the form's chat (`enabled_all`,
   or `receipt_forms.chat_id` in `chat_ids`). No row, a DB error or a chat not listed = off.
2. The form's delivery supplier VAT (`deliveries.supplier_vat`) is listed in
   `RECEIVE_FORM_V3_SUPPLIER_VATS`. Unset = `570052894` (Bnei Darom). `all` = any supplier.

When both v3 and `receive_redesign` (28/10) are on, v3 wins. The page decides at load, then the
open form follows the flag through its 15 s poll, the way it follows `receive_redesign`, and never
while the worker is typing (it waits for the next poll):

- switched **off** under v3: today's form takes over with the v3 draft (`v3ToLegacyDraft`); the
  v3-only answers (pallet per line, outside the pallet, splits) are dropped;
- switched **on** under today's form: v3 takes over with the classic draft (`legacyToV3Draft`,
  step 1 first). A page that loaded with the flag off has no v3 data, so it reloads once (at most
  once per form per 10 minutes, so a server still saying "off" cannot loop it).

Caches: the flag row 30 s, a delivery's VAT 10 minutes, so a flip reaches an open form within
about 45 s.

Code: `lib/scanner-flags.ts` (`receiveFormV3On`), read by `app/receive/[id]/page.tsx` and
`GET /api/receipt-form/{id}` (`features.receive_form_v3: true`, a key added only when on).

## Env vars (scanner, Vercel Production; a change needs a redeploy)

| Var | Meaning | Unset |
|---|---|---|
| `RECEIVE_FORM_V3_SUPPLIER_VATS` | comma list of supplier VATs, or `all` | `570052894` |
| `BOT_WA_NUMBER` | the bot's WhatsApp number, for `https://wa.me/{n}` at the end (non-digits stripped) | the end screen only closes the tab |

## Data contract

The POST body keeps today's keys with today's meaning, so the bot
(`bot/services/receipt_form.py`, unchanged) and Priority get exactly what today's form sends. v3
adds optional keys the bot ignores:

- per line: `pallet` (1..pallets, `"loose"`, or null for nothing received / a partly loose line
  with no pallet chosen), `loose_qty` (packages outside the pallet), `split_unit` (always
  `"qty"`: the rows add up to the line's received quantity, units / kg, as the prototype's
  splitState; the server still accepts `"packages"`) and `splits` (2–3 rows `{qty, expiry_date}`);
  a split line's `expiry_date` is its **earliest** split date;
- top level: `form_version: 3`, `loose_lines`.

`parseAnswers` keeps these keys only when `form_version === 3`; any other body parses exactly as
before. POST runs `validateV3` on v3 bodies (pallets 0..50, every arrived line on a pallet or
outside, a sane loose count, splits adding up with the earliest date as the expiry); a failure is
422 `{error: 'invalid', errors, v3_errors}`. The answers are stored in `receipt_forms.answers` as
today, v3 keys included.

New read-only endpoint `GET /api/receipt-form/{id}/status?exp&sig` →
`{ok, erp, form_status, outcome, docno, office_lines, submitted_at}`, outcome one of `pending`,
`success`, `partial` (a received GR whose outbox row lists unmapped item codes), `timeout`,
`failed` (`lib/receive-v3-status.ts`). It reads what `/api/priority-status` reads, keyed by the
form's delivery. Nothing is written.

When the flag is on, the page also loads (read-only): the note photos (`deliveries` +
`invoice_ocr_results` images on our own Supabase storage only), the tenant's ERP
(`tenants.erp`; default Priority) and `BOT_WA_NUMBER`. Flag off: none of these reads happen.

Both forms send the save and the poll through one helper, `lib/receipt-form-client.ts`
(`postReceiptForm`, `getReceiptForm`), so v3's POST is byte for byte today's request
`{exp, sig, rev, answers}`; v3 reads the answer with `readSubmitAnswer` (409 `lines_changed` merges
the new lines and, when nothing new arrived, sends once more on the new rev, as today; 422 →
the error sheet; closed / in-flight / failed / expired → the matching notice). A save goes to the
status screen, which polls the status endpoint, then returns to WhatsApp.

Wiring: `app/receive/[id]/ReceiptForm.tsx` renders `ReceiveFormV3` when page.tsx hands it `v3`
(the boot data) and today's form otherwise; the v3 form is traced with today's `useReceiveTrace`
on the legacy view of its draft. Flag-off proof: `lib/receipt-form-flag-off.test.ts` renders
ReceiptForm for the Bnei Darom test note and compares it byte for byte with the markup of
origin/preview 177d411 (classic and 28/10 redesign). Rubik is not preloaded, so a flag-off page
never downloads it.

Files: `lib/receive-v3.ts` (types + pure logic), `lib/receive-v3-client.ts`,
`lib/receive-v3-status.ts`, `lib/receive-v3-server.ts`, `app/api/receipt-form/[id]/status/route.ts`,
`components/receive/v3/*` (the UI). Build spec: `SPEC_V3.md` (nov06c scratchpad).

## Switching it on for Bnei Darom

1. Apply `docs/migrations/2026-11-06-scanner-flag-receive-form-v3.sql` (Supabase SQL editor). It
   seeds the row for the e2e-harness chats only, so Mevaser's Bnei Darom test link shows v3 and
   nobody else's form changes. Take screenshots for Mevaser.
2. With his OK, add David's chat id (the `update … array_append` line in that file). Leave
   `RECEIVE_FORM_V3_SUPPLIER_VATS` unset: only Bnei Darom notes get v3.
3. Roll back at any time with the file's last `update` (everyone back on today's form).
