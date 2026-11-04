#!/bin/sh
# Restaura um backup do NoPaper (nopaper-AAAAMMDD-HHMMSS.tar.gz) na instalação Docker atual.
#
#   ./scripts/restore.sh caminho/do/nopaper-....tar.gz
#
# O banco atual é APAGADO e recriado a partir do backup; a pasta de anexos é substituída.
# Rode na pasta do projeto (onde está o docker-compose.yml). Para outro projeto/arquivo do
# compose, defina COMPOSE, ex.: COMPOSE="docker compose -p meuprojeto" ./scripts/restore.sh …
set -eu

FILE="${1:-}"
COMPOSE="${COMPOSE:-docker compose}"
DB_USER="${POSTGRES_USER:-nopaper}"
DB_NAME="${POSTGRES_DB:-nopaper}"
# pasta dos dados permanentes (mesma do docker-compose.yml): a cópia de segurança vai para backups/
DATA_PATH="${DATA_PATH:-$(sed -n 's/^DATA_PATH=//p' .env 2>/dev/null | tail -1)}"
DATA_PATH="${DATA_PATH:-/storage/nopaper}"

if [ -z "$FILE" ] || [ ! -f "$FILE" ]; then
  echo "Uso: $0 nopaper-AAAAMMDD-HHMMSS.tar.gz" >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
tar -xzf "$FILE" -C "$WORK"
[ -f "$WORK/database.dump" ] || { echo "Arquivo inválido: não contém database.dump" >&2; exit 1; }
[ -f "$WORK/manifest.json" ] && echo "Backup: $(grep -o '"createdAt": *"[^"]*"' "$WORK/manifest.json" | cut -d'"' -f4)"

if [ "${YES:-}" != "1" ]; then
  printf 'Isto APAGA o banco "%s" e os anexos atuais e coloca o backup no lugar. Digite RESTAURAR para continuar: ' "$DB_NAME"
  read -r answer
  [ "$answer" = "RESTAURAR" ] || { echo "Cancelado."; exit 1; }
fi

echo "→ parando api e web"
$COMPOSE stop api web >/dev/null
$COMPOSE up -d db >/dev/null
i=0; until $COMPOSE exec -T db pg_isready -U "$DB_USER" >/dev/null 2>&1; do i=$((i+1)); [ $i -gt 60 ] && { echo "Banco não respondeu" >&2; exit 1; }; sleep 1; done

# rede de segurança: guarda o banco atual antes de apagar (se ele existir)
if $COMPOSE exec -T db psql -U "$DB_USER" -d "$DB_NAME" -tAc 'select 1' >/dev/null 2>&1; then
  SAFETY="pre-restore-$(date +%Y%m%d-%H%M%S).dump"
  [ -w "$DATA_PATH/backups" ] && SAFETY="$DATA_PATH/backups/$SAFETY"
  echo "→ salvando o banco atual em $SAFETY (por segurança)"
  $COMPOSE exec -T db pg_dump -U "$DB_USER" --format=custom "$DB_NAME" > "$SAFETY"
fi

echo "→ recriando o banco $DB_NAME"
$COMPOSE exec -T db dropdb -U "$DB_USER" --if-exists --force "$DB_NAME"
$COMPOSE exec -T db createdb -U "$DB_USER" "$DB_NAME"

echo "→ restaurando dados"
$COMPOSE cp "$WORK/database.dump" db:/tmp/nopaper-restore.dump >/dev/null
$COMPOSE exec -T db pg_restore --no-owner --no-privileges --exit-on-error -U "$DB_USER" -d "$DB_NAME" /tmp/nopaper-restore.dump
$COMPOSE exec -T db rm -f /tmp/nopaper-restore.dump

if [ -d "$WORK/uploads" ]; then
  echo "→ restaurando anexos"
  $COMPOSE run --rm --no-deps -v "$WORK/uploads:/restore:ro" --entrypoint sh api \
    -c 'find /data/uploads -mindepth 1 -delete && cp -a /restore/. /data/uploads/ && chown -R node:node /data/uploads' >/dev/null
else
  echo "→ backup sem anexos (anexos atuais mantidos)"
fi

echo "→ iniciando api e web"
$COMPOSE up -d api web >/dev/null
echo "Pronto."
