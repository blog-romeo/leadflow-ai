#!/usr/bin/env bash
# Esegue migrazioni + test RLS su un cluster PostgreSQL temporaneo locale.
# Requisiti: PostgreSQL 15+ (initdb, pg_ctl, psql nel PATH o in /usr/lib/postgresql/*/bin).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
[ -n "$PGBIN" ] && export PATH="$PGBIN:$PATH"
WORK="$(mktemp -d)"
PORT="${PGPORT_TEST:-54329}"
RUN_AS=()
if [ "$(id -u)" = "0" ]; then
  chown postgres "$WORK"; RUN_AS=(runuser -u postgres --)
fi
cleanup() { "${RUN_AS[@]}" pg_ctl -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

"${RUN_AS[@]}" initdb -D "$WORK/data" -U postgres --auth=trust >/dev/null
"${RUN_AS[@]}" pg_ctl -D "$WORK/data" -o "-p $PORT -k $WORK -c listen_addresses=''" -l "$WORK/log" -w start >/dev/null

PSQL=("${RUN_AS[@]}" psql -X -q -v ON_ERROR_STOP=1 -h "$WORK" -p "$PORT" -U postgres -d postgres)
"${PSQL[@]}" -f "$ROOT/supabase/tests/local_supabase_stub.sql"
for f in "$ROOT"/supabase/migrations/*.sql; do
  echo "→ migrazione $(basename "$f")"
  "${PSQL[@]}" -f "$f"
done
# I test dei moduli precedenti verificano funzioni indipendenti dal billing: li eseguiamo con
# l'enforcement dei piani disattivato. rls_tests_billing.sql lo riattiva per i propri test.
"${PSQL[@]}" -c "select private.billing_set_enforcement(false)" >/dev/null
for t in "$ROOT"/supabase/tests/rls_tests*.sql; do
  echo "→ $(basename "$t")"
  "${PSQL[@]}" -f "$t"
done
