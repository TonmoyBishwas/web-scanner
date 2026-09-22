# Scanner trace — per-user debugging trail

**Added 2026-09-22.** When a worker reports "at 10:42 the scanner got stuck",
nobody knows what they scanned, deleted, edited or refreshed. The trace
records all of it, server-side, for the users it is switched on for.

## What is recorded

One row per event in `public.scanner_events` (read via the `scanner_trace`
view, Israel local time). Every event carries the user (`chat_id`,
`nickname`), the page (`pallet-verify` / `scan` / `issue`), the session
`token`, a `load_id` (new on every page load — a reload shows up as a new
`load_id` with a `lifecycle/load` event whose `navigation` is `reload`) and a
`seq` for ordering inside that load.

| kind | event | what |
|---|---|---|
| `lifecycle` | `load`, `trace_on`, `visibility`, `pagehide`, `pageshow_bfcache`, `online`, `offline` | page load (URL, navigation type, user agent, viewport), tab hidden/shown, page left, connectivity |
| `phase` | the phase name | every phase change of the page (`scanning`, `confirming`, `loose_scanning`, `pallet_done`, …) with the pallet number |
| `ui` | see below | explicit worker actions |
| `fetch` | `request`, `response`, `network_error` | every same-origin `/api/*` call: method, URL, request body, status, response body, duration. Photos are replaced by `<image N chars>` / `<omitted N chars>` |
| `console` | `log` / `warn` / `error` | every console line (the same ones the in-page bug panel shows) |
| `error` | `unhandled`, `unhandledrejection` | uncaught exceptions |

`ui` events on **pallet-verify**: `scan_detected` (barcode, pallet, `ok`,
refusal `reason`, `duplicate`), `manual_capture`, `retry_ocr`, `delete_box`,
`loose_scan_detected`, `loose_manual_capture`, `loose_retry_ocr`,
`loose_delete_box`, `complete_as_single`, `cancel_single_confirm`,
`continue_as_mix`, `edit_open`, `edit_save` (every field the worker saved),
`create_barcode`, `no_barcode`, `identical_created`, `count_submit`,
`confirm_pallet` (scanned count, declared count, override, forced mix,
detected type), `pallet_completed` (LPN, type, box count), `next_pallet`,
`pallet_released`, `confirm_loose`, `restored_from_cache` /
`restored_loose_from_cache` (the page came back after a reload with N boxes).
On **scan**: `scan_detected`, `manual_capture`, `force_confirm_entry`,
`issue_resolve`, `undo_scan`, `confirm_session`. On **issue**:
`scan_detected`, `confirm_issue`, `cancel_detail`, `complete_issue`.

OCR results are not a separate `ui` event: they are the `fetch/response` of
`/api/multi-pallet-ocr` (or `/api/ocr`), body included.

## Switching it on and off

Decided per user on `public.users`, by the server (`GET /api/trace`), never
by the browser:

| column | meaning |
|---|---|
| `trace_enabled boolean` | permanently on. **David Hirsch (`972544965384`) is `true`.** |
| `trace_until timestamptz` | on until this moment — the "just for today" switch |

```sql
-- David: always on (already set)
update users set trace_enabled = true where chat_id = 972544965384;

-- Ariel: record today only (until midnight Israel time)
update users set trace_until = (current_date + 1)::timestamp at time zone 'Asia/Jerusalem'
 where chat_id = 972528336755;

-- switch someone off
update users set trace_enabled = false, trace_until = null where chat_id = …;
```

An untraced user costs one small `GET /api/trace` per page load and nothing
else. A traced user's page batches events every 2 s (`POST /api/trace`,
`keepalive`) and fires a `sendBeacon` on page hide so the last actions before
a refresh survive. A red dot on the in-page bug button shows the session is
being recorded. Rows older than 30 days are purged nightly by the pg_cron
job `purge-scanner-events`.

## Reading a report

The worker says "David, around 10:40 today, pallet 2". Pull the timeline:

```sql
select local_time, load_id, seq, kind, event, data
  from scanner_trace
 where nickname = 'דוד הירש'
   and local_time between '2026-09-22 10:30' and '2026-09-22 11:00'
 order by ts, id;
```

Or by session token (from the scanner URL the bot sent):

```sql
select local_time, kind, event, data from scanner_trace
 where token = '<token>' order by ts, id;
```

Useful filters: `kind = 'ui'` for the worker's actions only; `event in
('load','restored_from_cache')` to see reloads; `kind = 'fetch' and
(data->>'status')::int >= 400` for failed API calls.

## Code

- `lib/scanner-trace.ts` — client: `startScannerTrace({token, page, workerChatId?})`
  once per page, `trace(kind, event, data?)` from handlers; fetch wrapper,
  lifecycle listeners, console forwarding (via `onDebugLogEntry` in
  `lib/debug-log.ts`), batching + beacon.
- `lib/scanner-trace-sanitize.ts` — what never reaches the DB (photos, huge
  strings, cycles); unit-tested in `lib/scanner-trace-sanitize.test.ts`.
- `app/api/trace/route.ts` — resolves the user from the session token (or
  the split-job `?w=` worker id), answers `enabled`, inserts batches. Refuses
  inserts for untraced users.
- Migration: `docs/migrations/2026-09-22-scanner-events.sql`
  (Supabase migration `scanner_events_trace`, applied live 2026-09-22).
