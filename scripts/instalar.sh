#!/bin/sh
# Instala (ou reconfigura) o NoPaper nesta máquina, perguntando como ele vai rodar:
#
#   Local     neste computador ou na rede interna, sem domínio e sem Traefik (http://…:porta)
#   Traefik   servidor com domínio, atrás de um Traefik que já está rodando (https://dominio)
#
# Uso:  sh scripts/instalar.sh [--local | --traefik]
#
# Cria o .env se ele não existir (com senhas e segredos gerados na hora) e sobe os containers.
# Pode ser rodado de novo para trocar de modo: os dados e os segredos que já existem são mantidos.
# Atrás de outro proxy (nginx, Caddy…): veja docs/publicacao-com-traefik.md, seção 5a.
set -e
cd "$(dirname "$0")/.."

MODE=""
for a in "$@"; do
  case "$a" in
    --local) MODE=local ;;
    --traefik) MODE=traefik ;;
    -h|--help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Opção desconhecida: $a (use --local ou --traefik)" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
fail() { printf '\nErro: %s\n' "$*" >&2; exit 1; }

# pergunta com resposta padrão; sem terminal (ou Enter) fica o padrão
ask() { # texto padrão
  printf '%s [%s]: ' "$1" "$2" >&2
  REPLY=""
  read -r REPLY || true
  [ -n "$REPLY" ] || REPLY="$2"
  printf '%s' "$REPLY"
}

get_env() { sed -n "s/^$1=//p" .env | tail -n 1; }

# grava CHAVE=valor no .env: troca a linha existente (mesmo comentada com "# ") ou acrescenta no fim
set_env() {
  K="$1" V="$2" awk '
    BEGIN { k = ENVIRON["K"]; v = ENVIRON["V"]; done = 0 }
    index($0, k "=") == 1 || index($0, "# " k "=") == 1 || index($0, "#" k "=") == 1 {
      if (!done) { print k "=" v; done = 1 }
      next
    }
    { print }
    END { if (!done) print k "=" v }' .env > .env.tmp
  cat .env.tmp > .env && rm -f .env.tmp
}

# desliga uma chave (vira comentário)
unset_env() {
  K="$1" awk 'BEGIN { k = ENVIRON["K"] } index($0, k "=") == 1 { print "# " $0; next } { print }' .env > .env.tmp
  cat .env.tmp > .env && rm -f .env.tmp
}

# a porta está aberta por algum programa ou container? (ss, senão a lista de portas publicadas do Docker)
port_busy() {
  if command -v ss >/dev/null 2>&1; then
    ss -ltnH 2>/dev/null | awk -v p=":$1" '{ a = $4; if (substr(a, length(a) - length(p) + 1) == p) f = 1 } END { exit !f }' && return 0
  fi
  docker ps --format '{{.Ports}}' 2>/dev/null | tr ',' '\n' | grep -q ":$1->" && return 0
  return 1
}

# mostra como entrar: consulta o banco; sem resposta do banco, usa o .env
show_login() {
  PW=$(get_env ADMIN_PASSWORD)
  ROW=$(docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "select username || chr(9) || email || chr(9) || must_change_password::text from users where is_superadmin and deleted_at is null order by created_at limit 1"' </dev/null 2>/dev/null || true)
  if [ -n "$ROW" ]; then
    U=$(printf '%s' "$ROW" | cut -f1); E=$(printf '%s' "$ROW" | cut -f2); PENDING=$(printf '%s' "$ROW" | cut -f3)
    say "  Entrar com: $U  (ou $E)"
    if [ "$PENDING" = true ] && [ -n "$PW" ]; then
      say "  Senha provisória: $PW  (o sistema pede uma nova no primeiro acesso)"
    elif [ "$PENDING" = true ]; then
      say "  Senha provisória: a que estava em ADMIN_PASSWORD no .env quando o banco foi criado"
      say "  Esqueceu? docker compose exec api node dist/scripts/reset-password.js $U"
    else
      say "  Senha: a que você definiu no primeiro acesso"
    fi
  elif [ -n "$PW" ]; then
    U=$(get_env ADMIN_USERNAME); U="${U:-admin}"
    say "  Entrar com: $U  (ou $(get_env ADMIN_EMAIL))"
    say "  Senha provisória: $PW  (o sistema pede uma nova no primeiro acesso)"
  fi
}

# ---- Docker ------------------------------------------------------------------
command -v docker >/dev/null 2>&1 || fail "o Docker não está instalado. Instale e rode de novo (guia: docs/publicacao-com-traefik.md, seção 3)."
docker compose version >/dev/null 2>&1 || fail "falta o Docker Compose (plugin 'docker compose'), versão 2.24 ou mais nova."
if ! DOCKER_ERR=$(docker info 2>&1 >/dev/null); then
  case "$DOCKER_ERR" in
    *ermission*denied*)
      fail "o seu usuário não tem acesso ao Docker. Rode com sudo (sudo sh scripts/instalar.sh) ou entre no grupo docker: sudo usermod -aG docker \$USER (e abra a sessão de novo)." ;;
    *) fail "o Docker não respondeu. Ele está rodando? (sudo systemctl start docker)
$DOCKER_ERR" ;;
  esac
fi

# pasta pessoal de quem chamou (com sudo, a do usuário e não a do root)
OWNER="${SUDO_USER:-}"
HOME_DIR="$HOME"
if [ -n "$OWNER" ]; then HOME_DIR=$(getent passwd "$OWNER" 2>/dev/null | cut -d: -f6); [ -n "$HOME_DIR" ] || HOME_DIR="$HOME"; fi

# ---- Modo --------------------------------------------------------------------
NEW_ENV=""
if [ ! -f .env ]; then
  [ -f .env.example ] || fail "não achei o .env.example (rode a partir da pasta do NoPaper)."
  cp .env.example .env
  NEW_ENV=1
fi
chmod 600 .env
[ -z "$OWNER" ] || chown "$OWNER" .env 2>/dev/null || true

if [ -z "$MODE" ]; then
  CURRENT=2
  case "$(get_env COMPOSE_FILE)" in *porta-direta*) CURRENT=1 ;; esac
  [ -z "$NEW_ENV" ] || CURRENT=1
  say ""
  say "Como o NoPaper vai rodar nesta máquina?"
  say "  1) Local   — neste computador ou na rede interna, sem domínio (http, sem Traefik)"
  say "  2) Traefik — servidor com domínio, atrás de um Traefik que já está rodando (https)"
  case "$(ask 'Escolha 1 ou 2' "$CURRENT")" in
    1|l*|L*) MODE=local ;;
    2|t*|T*) MODE=traefik ;;
    *) fail "escolha 1 ou 2." ;;
  esac
fi

# ---- Segredos e administrador (só o que estiver vazio) --------------------------
command -v openssl >/dev/null 2>&1 || fail "falta o comando openssl (usado para gerar as senhas)."
[ -n "$(get_env POSTGRES_PASSWORD)" ] || set_env POSTGRES_PASSWORD "$(openssl rand -hex 24)"
[ -n "$(get_env JWT_SECRET)" ] || set_env JWT_SECRET "$(openssl rand -hex 48)"

# ---- Pasta dos dados -------------------------------------------------------------
DATA=$(get_env DATA_PATH)
if [ -n "$NEW_ENV" ] || [ -z "$DATA" ]; then
  if [ "$MODE" = local ]; then DEFAULT_DATA="$HOME_DIR/nopaper-dados"; else DEFAULT_DATA="${DATA:-/storage/nopaper}"; fi
  say ""
  say "Onde guardar os dados (banco, anexos e backups)? Use uma pasta fora de pastas sincronizadas"
  say "(Nextcloud, Dropbox…): o banco não pode ser copiado enquanto está em uso."
  DATA=$(ask 'Pasta dos dados' "$DEFAULT_DATA")
  case "$DATA" in /*) ;; *) fail "informe o caminho completo da pasta (começando com /)." ;; esac
  set_env DATA_PATH "$DATA"
fi

FIRST_BOOT=""
[ -d "$DATA/banco" ] || FIRST_BOOT=1
if [ -n "$NEW_ENV" ] && [ -z "$FIRST_BOOT" ] && [ -n "$(ls -A "$DATA/banco" 2>/dev/null)" ]; then
  rm -f .env
  fail "já existe um banco em $DATA/banco, mas o .env é novo: as senhas geradas agora não abririam esse banco.
  - Recupere o .env da instalação anterior e rode de novo, ou
  - para começar do zero (apaga TUDO o que estava lá): pare o NoPaper e apague a pasta $DATA"
fi
if [ -n "$FIRST_BOOT" ]; then
  # só em instalação nova: num banco que já existe, uma chave nova deixaria de abrir os segredos guardados
  [ -n "$(get_env SECRETS_KEY)" ] || set_env SECRETS_KEY "$(openssl rand -hex 48)"
  EMAIL=$(get_env ADMIN_EMAIL)
  if [ -z "$EMAIL" ]; then
    say ""
    EMAIL=$(ask 'E-mail do administrador (primeiro usuário)' 'admin@nopaper.local')
    case "$EMAIL" in *@*.*) ;; *) fail "e-mail inválido: $EMAIL" ;; esac
    set_env ADMIN_EMAIL "$EMAIL"
  fi
  [ -n "$(get_env ADMIN_PASSWORD)" ] || set_env ADMIN_PASSWORD "$(openssl rand -hex 6)"
fi

# ---- Configuração de cada modo ---------------------------------------------------
if [ "$MODE" = local ]; then
  PORT=$(get_env WEB_PORT); PORT="${PORT:-8080}"
  # a porta que o próprio NoPaper já está usando não conta como ocupada
  OWN_PORT=""
  [ -z "$(docker compose ps -q web 2>/dev/null || true)" ] || OWN_PORT="$PORT"
  ROOTLESS=""
  case "$(docker info -f '{{.SecurityOptions}}' 2>/dev/null)" in *rootless*) ROOTLESS=1 ;; esac
  while :; do
    say ""
    PORT=$(ask 'Porta para abrir o NoPaper' "$PORT")
    case "$PORT" in ''|*[!0-9]*) say "Porta inválida."; PORT=8080; continue ;; esac
    if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then say "Porta inválida (1 a 65535)."; PORT=8080; continue; fi
    if [ -n "$ROOTLESS" ] && [ "$PORT" -lt 1024 ]; then
      say "O Docker desta máquina roda sem root e não pode abrir portas abaixo de 1024. Use 8080, por exemplo."
      PORT=8080; continue
    fi
    if [ "$PORT" != "$OWN_PORT" ] && port_busy "$PORT"; then
      say "A porta $PORT já está em uso nesta máquina (outro programa ou container). Escolha outra."
      PORT=$((PORT + 1)); continue
    fi
    break
  done

  LAN_IP=$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.*src \([0-9.]*\).*/\1/p')
  BIND=127.0.0.1
  HOST=localhost
  if [ -n "$LAN_IP" ]; then
    CUR=1; [ "$(get_env WEB_BIND)" = 0.0.0.0 ] && CUR=2
    say ""
    say "Quem vai acessar?"
    say "  1) Só este computador (http://localhost:$PORT)"
    say "  2) Também outros aparelhos da rede (http://$LAN_IP:$PORT)"
    case "$(ask 'Escolha 1 ou 2' "$CUR")" in
      2) BIND=0.0.0.0; HOST="$LAN_IP" ;;
    esac
  fi

  set_env COMPOSE_FILE "docker-compose.yml:deploy/porta-direta.yml"
  set_env WEB_PORT "$PORT"
  set_env WEB_BIND "$BIND"
  set_env APP_URL "http://$HOST:$PORT"
  case "$(get_env APP_DOMAIN)" in ''|nopaper.example.com) set_env APP_DOMAIN localhost ;; esac
  ADDRESS="http://$HOST:$PORT"
else
  DOMAIN=$(get_env APP_DOMAIN)
  case "$DOMAIN" in ''|nopaper.example.com|localhost)
    say ""
    DOMAIN=$(ask 'Domínio do NoPaper (sem https://), já apontando para este servidor' '')
    [ -n "$DOMAIN" ] || fail "o modo Traefik precisa de um domínio. Sem domínio, use o modo Local."
    set_env APP_DOMAIN "$DOMAIN" ;;
  esac
  unset_env COMPOSE_FILE
  unset_env WEB_PORT
  unset_env WEB_BIND
  case "$(get_env APP_URL)" in http://*) set_env APP_URL "" ;; esac

  NET=$(get_env TRAEFIK_NETWORK); NET="${NET:-traefik}"
  if ! docker network inspect "$NET" >/dev/null 2>&1; then
    fail "não existe a rede Docker \"$NET\": o Traefik não está rodando nesta máquina.
  - Para subir o Traefik que vem com o NoPaper: docs/publicacao-com-traefik.md, seção 6a.
  - Se o seu Traefik usa outra rede, ponha o nome dela em TRAEFIK_NETWORK no .env.
  - Para rodar sem Traefik: sh scripts/instalar.sh --local"
  fi
  ADDRESS="https://$DOMAIN"
fi

# ---- Subir -------------------------------------------------------------------------
# o .env pode ter um COMPOSE_FILE antigo exportado no terminal: vale o do arquivo
unset COMPOSE_FILE
docker compose config -q || fail "a configuração não fechou (mensagem acima). Confira o .env."
say ""
say "Construindo e subindo o NoPaper (a primeira vez leva alguns minutos)…"
UPLOG=$(mktemp)
RCF=$(mktemp)
{ docker compose up -d --build --remove-orphans 2>&1; echo $? > "$RCF"; } | tee "$UPLOG"
RC=$(cat "$RCF"); rm -f "$RCF"
if [ "$RC" != 0 ]; then
  say ""
  if grep -qiE 'port is already allocated|address already in use|bind for' "$UPLOG"; then
    say "A porta ${PORT:-escolhida} já está em uso nesta máquina. Rode de novo e escolha outra: sh scripts/instalar.sh --local"
  elif grep -qiE 'privileged port|permission denied.*bind' "$UPLOG"; then
    say "Sem permissão para abrir a porta ${PORT:-escolhida} (abaixo de 1024). Rode de novo e escolha 8080, por exemplo."
  fi
  rm -f "$UPLOG"
  say "Os dados de acesso ficam guardados (não mudam ao rodar de novo):"
  show_login
  fail "o NoPaper não subiu (mensagem acima)."
fi
rm -f "$UPLOG"

UP=1
if [ "$MODE" = local ] && command -v curl >/dev/null 2>&1; then
  printf 'Esperando o NoPaper responder'
  i=0
  while [ $i -lt 60 ]; do
    if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/api/health" 2>/dev/null; then break; fi
    printf '.'; sleep 2; i=$((i + 1))
  done
  say ""
  [ $i -lt 60 ] || UP=""
fi

say ""
if [ -n "$UP" ]; then
  say "NoPaper no ar: $ADDRESS"
else
  say "Os containers subiram, mas o NoPaper ainda não respondeu em $ADDRESS."
  say "Veja o que houve com: docker compose ps  e  docker compose logs --tail 100 api web"
fi
show_login
say "  Dados em: $DATA"
[ "$MODE" != local ] || say "  Sem HTTPS: instalar como aplicativo (PWA) e \"Copiar\" só funcionam em http://localhost, não pelo IP."
say "  Estado: docker compose ps   ·   Logs: docker compose logs -f api   ·   Parar: docker compose down"
