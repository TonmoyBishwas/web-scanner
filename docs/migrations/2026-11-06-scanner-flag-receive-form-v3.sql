-- 2026-11-06 — receive form v3 flag (scanner branch nov06-receive-form-v3).
--
-- NOT APPLIED by the branch. Idempotent. Nothing changes for anyone until it
-- is applied AND a chat is listed (or enabled_all is set).
--
-- The non-meat receive form v3 (Claude Design "Non-Meat Receive Form",
-- approved by Mevaser 01/11; docs/RECEIVE_FORM_V3.md). The scanner reads the
-- row 'receive_form_v3' (lib/scanner-flags.ts receiveFormV3On): the
-- /receive/{id} page's first render and its poll
-- (GET /api/receipt-form/{id} -> features.receive_form_v3, present only when
-- on). It is on for a form only when BOTH hold:
--   1. this row is on for the form's chat (enabled_all, or the chat id is in
--      chat_ids), and
--   2. the form's delivery supplier VAT (deliveries.supplier_vat) is in the
--      scanner env RECEIVE_FORM_V3_SUPPLIER_VATS — unset = 570052894
--      (שיווק והפצה בני דרום אגש"ח בע"מ, Bnei Darom); 'all' = any supplier.
-- No row, a DB error, a chat not listed or another supplier = OFF = today's
-- form, byte for byte. When both v3 and 'receive_redesign' are on, v3 wins.
--
-- Seeded OFF for real users: only the e2e-harness chats 999000000001..030.
-- Mevaser's Bnei Darom test link (form b0ef93a8-…, a harness chat, VAT
-- 570052894) shows v3 once this is applied — nobody else does.

insert into public.scanner_flags (flag, enabled_all, chat_ids, note)
values (
  'receive_form_v3', false,
  array(select (999000000000 + n)::text from generate_series(1, 30) as n),
  'Non-meat receive form v3 (Claude Design, approved 01/11). Harness chats only until Mevaser OKs. Supplier gate: env RECEIVE_FORM_V3_SUPPLIER_VATS (default 570052894 Bnei Darom).'
)
on conflict (flag) do nothing;

-- Test chats only: the insert above (harness chats 999000000001..030).
--
-- David only (his chat id; Bnei Darom notes only while the env is unset):
--   update public.scanner_flags
--      set chat_ids = array_append(chat_ids, '<chat id>'), updated_at = now()
--    where flag = 'receive_form_v3' and not ('<chat id>' = any(chat_ids));
--
-- Everyone (still Bnei Darom notes only while the env is unset):
--   update public.scanner_flags set enabled_all = true, updated_at = now() where flag = 'receive_form_v3';
--
-- Every supplier: set RECEIVE_FORM_V3_SUPPLIER_VATS=all on the scanner's
-- Vercel project (Production) and redeploy (an env change needs a redeploy).
--
-- Roll back (everyone back on today's form; a page already open keeps the
-- design it loaded with until it is reloaded):
--   update public.scanner_flags set enabled_all = false, chat_ids = '{}', updated_at = now() where flag = 'receive_form_v3';
--
-- (A running server instance caches the row for 30 s, and a delivery's
-- supplier VAT for 10 minutes.)
