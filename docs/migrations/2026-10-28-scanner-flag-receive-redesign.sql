-- 2026-10-28 — receive form redesign flag (scanner branch oct28-receive-redesign).
--
-- NOT APPLIED by the branch: the orchestrator applies it. Idempotent.
--
-- public.scanner_flags exists since 2026-10-27 (units_mode, bot
-- docs/migrations/2026-10-27-units-carton.sql). The scanner reads the row
-- 'receive_redesign' for the form's chat (lib/scanner-flags.ts
-- receiveRedesignOn): the /receive/{id} page's first render and its poll
-- (GET /api/receipt-form/{id} -> features.receive_redesign). No row, a DB
-- error, or a chat not listed = OFF = today's form, byte for byte.
--
-- Seeded OFF for real users: only the e2e-harness chats 999000000001..030,
-- so the harness and the screenshots for Mevaser can see it. The texts it
-- shows (receive.v2.*) are DRAFTS until Mevaser approves them.

insert into public.scanner_flags (flag, enabled_all, chat_ids, note)
values (
  'receive_redesign', false,
  array(select (999000000000 + n)::text from generate_series(1, 30) as n),
  'Receive form redesign: compact cards + expiry walk (28/10). Harness chats only until Mevaser approves the texts.'
)
on conflict (flag) do nothing;

-- To turn it on for one worker later (e.g. David), by chat id:
--   update public.scanner_flags
--      set chat_ids = array_append(chat_ids, '<chat id>'), updated_at = now()
--    where flag = 'receive_redesign' and not ('<chat id>' = any(chat_ids));
-- Everyone:   update public.scanner_flags set enabled_all = true,  updated_at = now() where flag = 'receive_redesign';
-- Roll back:  update public.scanner_flags set enabled_all = false, chat_ids = '{}', updated_at = now() where flag = 'receive_redesign';
-- (A running server instance caches the row for 30 s.)
