#!/usr/bin/env bash
# Test di concorrenza del motore crediti e delle quote lead su un Postgres temporaneo:
# N connessioni parallele cercano di superare la quota nello stesso istante.
# Requisiti: PostgreSQL 15+ (initdb, pg_ctl, psql).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
[ -n "$PGBIN" ] && export PATH="$PGBIN:$PATH"
WORK="$(mktemp -d)"
PORT="${PGPORT_TEST:-54330}"
RUN_AS=()
if [ "$(id -u)" = "0" ]; then
  chown postgres "$WORK"; RUN_AS=(runuser -u postgres --)
fi
cleanup() { "${RUN_AS[@]}" pg_ctl -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

"${RUN_AS[@]}" initdb -D "$WORK/data" -U postgres --auth=trust >/dev/null
"${RUN_AS[@]}" pg_ctl -D "$WORK/data" -o "-p $PORT -k $WORK -c listen_addresses='' -c max_connections=120" -l "$WORK/log" -w start >/dev/null
PSQL=("${RUN_AS[@]}" psql -X -q -v ON_ERROR_STOP=1 -h "$WORK" -p "$PORT" -U postgres -d postgres)

"${PSQL[@]}" -f "$ROOT/supabase/tests/local_supabase_stub.sql"
for f in "$ROOT"/supabase/migrations/*.sql; do "${PSQL[@]}" -f "$f"; done

ORG=$("${PSQL[@]}" -At <<'SQL'
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000cc001', 'conc@test.test');
set role authenticated;
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000cc001"}';
select id from public.create_organization('Concorrenza Srl', null, 'IT');
SQL
)
"${PSQL[@]}" -At >/dev/null <<SQL
select private.billing_grant_manual_plan('$ORG', 'starter', 'test concorrenza');
select private.lock_quota_period('$ORG');
update public.usage_quotas set ai_credits_used = 490, leads_used = 240 where organization_id = '$ORG';
SQL

echo "→ 40 prenotazioni parallele con 10 crediti disponibili"
for i in $(seq 1 40); do
  "${PSQL[@]}" -At -c "set role service_role; select (public.billing_reserve_credits('$ORG', null, 'lead_analysis', 'conc:$i') ->> 'allowed')" >"$WORK/r$i" 2>&1 &
done
wait
ALLOWED=$(cat "$WORK"/r* | grep -c '^true$' || true)
STATE=$("${PSQL[@]}" -At -c "select ai_credits_used || '/' || ai_credits_reserved || '/' || ai_credits_limit from public.usage_quotas where organization_id = '$ORG'")
echo "   prenotazioni accettate: $ALLOWED — used/reserved/limit: $STATE"
[ "$ALLOWED" = "10" ] && [ "$STATE" = "490/10/500" ] || { echo "FAIL: superamento della quota crediti"; exit 1; }

echo "→ 30 conteggi lead paralleli (riferimenti sovrapposti) con 10 lead disponibili"
rm -f "$WORK"/r*
for i in $(seq 1 30); do
  a=$((i % 15)); b=$(((i + 1) % 15))
  "${PSQL[@]}" -At -c "set role service_role; select public.billing_count_new_leads('$ORG', null, array['lead-$a','lead-$b'])" >"$WORK/l$i" 2>&1 &
done
wait
if grep -l ERROR "$WORK"/l* >/dev/null 2>&1; then echo "FAIL: errori nei conteggi paralleli"; cat "$WORK"/l*; exit 1; fi
STATE=$("${PSQL[@]}" -At -c "select leads_used || '/' || leads_limit || '/' || (select count(*) from public.usage_ledger where organization_id = '$ORG' and kind = 'leads') from public.usage_quotas where organization_id = '$ORG'")
echo "   leads_used/limit/righe registro: $STATE"
[ "$STATE" = "250/250/10" ] || { echo "FAIL: quota lead o deduplicazione non rispettate"; exit 1; }

echo "Test di concorrenza billing superati."
