-- ════════════════════════════════════════════════════════════════════════════
-- LeadFlow AI — Migrazione 0004: nuovi tipi di attività per il Sales Agent.
-- File separato: i valori aggiunti con ADD VALUE diventano utilizzabili solo
-- dopo il commit della transazione che li crea.
-- ════════════════════════════════════════════════════════════════════════════
alter type public.activity_type add value if not exists 'proposal';
alter type public.activity_type add value if not exists 'message_draft';
alter type public.activity_type add value if not exists 'follow_up';
alter type public.activity_type add value if not exists 'opportunity';
alter type public.activity_type add value if not exists 'appointment';
alter type public.activity_type add value if not exists 'ai';
