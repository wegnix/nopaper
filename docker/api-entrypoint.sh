#!/bin/sh
# Sobe como root só para garantir que as pastas de dados (montadas do servidor, ex.:
# /storage/nopaper/anexos e /backups) pertençam ao usuário "node"; depois roda a API sem privilégios.
set -e
if [ "$(id -u)" = "0" ]; then
  for d in "$STORAGE_DIR" "$BACKUP_DIR"; do
    mkdir -p "$d"
    # só percorre tudo quando o dono está errado (pasta recém-criada pelo Docker ou copiada como root)
    [ "$(stat -c %u "$d")" = "$(id -u node)" ] || chown -R node:node "$d"
  done
  exec su-exec node "$@"
fi
exec "$@"
