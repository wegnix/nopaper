#!/bin/sh
# Sites que podem exibir o NoPaper em quadro (iframe): EMBED_ALLOWED_ORIGINS, separados por vírgula
# (ex.: https://sistema.exemplo.com). Vazio = ninguém além do próprio NoPaper, como sempre foi.
# Com a lista, o X-Frame-Options (que não aceita lista) dá lugar a "frame-ancestors" em todas as
# respostas — telas, API e arquivos: o navegador confere cada quadro acima do documento.
set -e
LIST=$(echo "${EMBED_ALLOWED_ORIGINS:-}" | tr ',' ' ' | xargs)
[ -z "$LIST" ] && exit 0
for o in $LIST; do
  if ! echo "$o" | grep -Eq '^https?://[A-Za-z0-9.-]+(:[0-9]+)?$'; then
    # valor errado não derruba o site: sobe fechado (ninguém embute) e avisa no log
    echo "EMBED_ALLOWED_ORIGINS ignorado: \"$o\" não é um endereço válido (use https://dominio, sem caminho)" >&2
    exit 0
  fi
done
sed -i "s|^add_header X-Frame-Options SAMEORIGIN always;|add_header Content-Security-Policy \"frame-ancestors 'self' $LIST\" always;|" /etc/nginx/snippets/security-headers.conf
sed -i "s|frame-ancestors 'self'\"|frame-ancestors 'self' $LIST\"|" /etc/nginx/conf.d/default.conf
echo "NoPaper pode ser embutido por: $LIST"
