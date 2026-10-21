-- Rollback of 2026-10-22-scan-kpi-views.sql (ours). Drops only the KPI objects it created.
select cron.unschedule('scan-kpi-snapshot') where exists (select 1 from cron.job where jobname = 'scan-kpi-snapshot');
drop function if exists public.scan_kpi_snapshot(integer);
drop table if exists public.scan_kpi_daily;
drop view if exists public.scan_kpi_interruptions;
drop view if exists public.scan_kpi_pace;
drop view if exists public.scan_kpi_receipt;
drop view if exists public.scan_kpi_token_receipt;
