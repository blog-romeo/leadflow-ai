-- ════════════════════════════════════════════════════════════════════════════
-- LeadFlow AI — Prompt 7: esecuzione pianificata della conservazione dei dati.
-- private.purge_expired_data() esiste dalla migrazione 0003 ma non veniva eseguita da nulla
-- (solo un suggerimento pg_cron nel README). Questo wrapper permette alla function pianificata
-- "retention-tick" (Netlify) di eseguirla con la service role. L'esecuzione resta DISATTIVATA
-- finché RETENTION_PURGE_ENABLED=true non viene impostata (decisione del titolare).
-- Migrazione additiva: non elimina nulla da sola.
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.run_retention_purge()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  r record;
begin
  select * into r from private.purge_expired_data();
  return jsonb_build_object('purged_soft_deleted', r.purged_soft_deleted, 'purged_retention', r.purged_retention, 'ran_at', now());
end $$;
revoke all on function public.run_retention_purge() from public, anon, authenticated;
grant execute on function public.run_retention_purge() to service_role;
