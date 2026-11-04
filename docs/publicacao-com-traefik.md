# Publicando o NoPaper num domínio com Traefik

Este guia leva um servidor Linux vazio até o NoPaper no ar em `https://seu-dominio`, com certificado
HTTPS automático (Let's Encrypt), backups e atualizações. Os comandos são para Debian/Ubuntu; em
outras distribuições só muda a instalação do Docker.

- [1. O que você precisa](#1-o-que-você-precisa)
- [2. Apontar o domínio](#2-apontar-o-domínio)
- [3. Instalar o Docker](#3-instalar-o-docker)
- [4. Onde ficam os dados](#4-onde-ficam-os-dados)
- [5. Portas](#5-portas)
- [6. Traefik](#6-traefik)
- [7. Baixar o NoPaper](#7-baixar-o-nopaper)
- [8. Configurar o `.env`](#8-configurar-o-env)
- [9. Subir](#9-subir)
- [10. Primeiro acesso](#10-primeiro-acesso)
- [11. E-mail, Telegram e backups](#11-e-mail-telegram-e-backups)
- [12. Atualizar para uma versão nova](#12-atualizar-para-uma-versão-nova)
- [13. Restaurar um backup](#13-restaurar-um-backup)
- [14. Problemas comuns](#14-problemas-comuns)

---

## 1. O que você precisa

| Item | Detalhe |
|---|---|
| Servidor | Linux 64 bits com acesso root/sudo. **2 GB de RAM** (a compilação das imagens usa ~1,5 GB; em uso o sistema fica bem abaixo disso), 1 vCPU, 10 GB de disco + o espaço dos anexos e backups. |
| Domínio | Um nome que você controla, ex.: `financeiro.suaempresa.com.br`. |
| Portas | **80** e **443** liberadas para a internet (firewall do provedor e do servidor). A Let's Encrypt valida pela 80. Se elas já estiverem em uso por outro serviço, veja a [seção 5](#5-portas). |
| Software | Docker Engine 24+ com o plugin Compose v2 (2.24 ou mais novo) e `git`. |

O NoPaper roda em quatro containers: `db` (PostgreSQL 17), `api` (Node.js), `web` (nginx com a
interface) e `updater` (atualização pela interface, seção 12). Só o `web` recebe acessos — e,
por padrão, apenas através do Traefik.

## 2. Apontar o domínio

No painel do seu DNS, crie um registro **A** (e **AAAA**, se o servidor tiver IPv6) com o nome
escolhido apontando para o IP público do servidor. Confira antes de seguir (pode levar alguns minutos):

```sh
dig +short financeiro.suaempresa.com.br     # deve mostrar o IP do servidor
```

## 3. Instalar o Docker

```sh
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"     # use o docker sem sudo (saia e entre de novo na sessão)
docker compose version              # confira: Docker Compose version v2.24 ou mais novo
```

## 4. Onde ficam os dados

Tudo o que não pode ser perdido fica numa pasta do servidor, **fora dos containers**: por padrão
`/storage/nopaper` (variável `DATA_PATH` no `.env`). Apagar, recriar ou atualizar os containers —
inclusive com `docker compose down -v` — não mexe nela.

| Pasta | O que guarda |
|---|---|
| `/storage/nopaper/banco/` | o banco de dados PostgreSQL (contas, pessoas, configurações) |
| `/storage/nopaper/anexos/` | boletos, notas fiscais e comprovantes enviados |
| `/storage/nopaper/backups/` | os backups gerados pelo sistema (`nopaper-AAAAMMDD-HHMMSS.tar.gz`) |
| `/storage/nopaper/atualizador/` | o estado e o registro das atualizações feitas pela interface |
| `/storage/traefik/letsencrypt/` | os certificados HTTPS (só se você usar o Traefik do passo 6a) |

- As pastas são **criadas sozinhas** na primeira subida, já com as permissões certas. Não é preciso
  criá-las antes nem dar `chmod`/`chown`.
- Para usar outro disco ou outro caminho (ex.: `/mnt/dados/nopaper`), troque `DATA_PATH` no `.env`
  **antes da primeira subida**.
- **Não edite nem apague arquivos dentro delas na mão** — use a interface (backups, restauração).
- O jeito certo de levar os dados para outro servidor é um **backup** do sistema (seção 11) e a
  **restauração** no servidor novo (seção 13). Se preferir copiar a pasta inteira, pare antes
  (`docker compose stop`) para o banco não ser copiado no meio de uma gravação.
- Mesmo com tudo em `/storage`, mantenha uma **cópia fora do servidor** (backup remoto, seção 11):
  um disco que falha leva a pasta junto.

## 5. Portas

**O NoPaper não ocupa nenhuma porta do servidor.** Banco (5432), API (3000) e interface (80) só
existem na rede interna dos containers, então nunca entram em conflito com outros containers ou
serviços — mesmo que eles usem esses mesmos números. Quem recebe o acesso de fora é o **Traefik**,
nas portas **80** e **443** do servidor.

Para ver o que já está usando uma porta:

```sh
sudo ss -ltnp | grep -E ':(80|443|8080) '
```

Escolha o caso que combina com o seu servidor:

| Situação | O que fazer |
|---|---|
| 80 e 443 livres | Siga o [passo 6a](#6a-o-servidor-ainda-não-tem-traefik) (Traefik pronto do repositório). |
| Já existe um **Traefik** usando 80/443 | Use o Traefik que já está lá: [passo 6b](#6b-o-servidor-já-tem-um-traefik). Não suba outro. |
| Outro proxy (**nginx, Caddy, Apache, Nginx Proxy Manager**…) usa 80/443 | Não use Traefik: publique o NoPaper numa porta livre e aponte o seu proxy para ela ([5a](#5a-sem-traefik-atrás-de-outro-proxy)). |
| 80/443 ocupadas por algo que não é proxy | Libere as portas ou troque as do Traefik ([5b](#5b-trocar-as-portas-do-traefik)) — com cuidado. |

### 5a. Sem Traefik, atrás de outro proxy

O arquivo `deploy/porta-direta.yml` tira o NoPaper do Traefik e publica a interface numa porta do
servidor, só para o próprio servidor (`127.0.0.1`). No `.env` do NoPaper:

```sh
COMPOSE_FILE=docker-compose.yml:deploy/porta-direta.yml
WEB_PORT=8080          # qualquer porta livre (confira com o comando ss acima)
WEB_BIND=127.0.0.1     # o proxy roda neste servidor; use 0.0.0.0 só se ele estiver em outra máquina
APP_URL=https://financeiro.suaempresa.com.br
```

As variáveis `TRAEFIK_*` deixam de ser usadas. Depois configure o seu proxy para encaminhar o
domínio para `http://127.0.0.1:8080` (o HTTPS fica com ele). Exemplos:

**nginx**

```nginx
server {
  listen 443 ssl http2;
  server_name financeiro.suaempresa.com.br;
  # ssl_certificate ... (o certificado que você já usa)
  client_max_body_size 0;            # restauração de backup pela interface envia arquivos grandes
  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
    proxy_read_timeout 3600s;
  }
}
```

**Caddy**

```caddy
financeiro.suaempresa.com.br {
  reverse_proxy 127.0.0.1:8080
}
```

> Use sempre pelo domínio com **HTTPS**: o cookie da sessão é marcado como seguro. Acessando
> `http://IP:8080` direto, sem o proxy, o login até entra, mas cai ao recarregar a página.

### 5b. Trocar as portas do Traefik

Em `deploy/traefik/.env` existem `HTTP_PORT` e `HTTPS_PORT` (padrão 80 e 443). Trocar é possível,
mas tem consequências:

- a **Let's Encrypt só valida pela porta 80 pública**. Com `HTTP_PORT` diferente de 80, o
  certificado só é emitido se algo na frente (roteador, firewall do provedor) encaminhar a porta 80
  da internet para a `HTTP_PORT` do servidor;
- com `HTTPS_PORT` diferente de 443, o endereço passa a ter a porta: `https://seu-dominio:8443`
  (ajuste `APP_URL` no `.env` do NoPaper para os links dos e-mails ficarem certos).

Se 80/443 já estão com um proxy, o caminho mais simples é o 5a.

## 6. Traefik

O NoPaper se registra num **Traefik**, que recebe o tráfego, cuida do HTTPS e encaminha para o
container certo. Assim dá para ter outros sistemas no mesmo servidor, cada um no seu domínio.
(Se você seguiu o 5a, pule para o passo 7.)

### 6a. O servidor ainda não tem Traefik

O repositório traz um Traefik pronto em `deploy/traefik/` (redireciona HTTP → HTTPS e emite os
certificados sozinho, guardados em `/storage/traefik/letsencrypt`). Depois de baixar o NoPaper
(passo 7):

```sh
cd nopaper/deploy/traefik
cp .env.example .env
nano .env                 # ACME_EMAIL = seu e-mail (a Let's Encrypt avisa por ele se algo der errado)
docker compose up -d
cd ../..
```

Ele cria a rede Docker `traefik`, o entrypoint HTTPS `websecure` e o resolvedor `letsencrypt` —
exatamente os valores padrão do `.env` do NoPaper.

### 6b. O servidor já tem um Traefik

Descubra três coisas na configuração dele e use-as no passo 8:

| No `.env` do NoPaper | O que é | Como achar |
|---|---|---|
| `TRAEFIK_NETWORK` | rede Docker em que o Traefik enxerga os containers | `docker network ls` / `providers.docker.network` |
| `TRAEFIK_ENTRYPOINT` | entrypoint da porta 443 | `entryPoints` da configuração estática (costuma ser `websecure` ou `https`) |
| `TRAEFIK_CERTRESOLVER` | nome do resolvedor ACME | `certificatesResolvers` (costuma ser `letsencrypt` ou `le`) |

O Traefik precisa ter o provider Docker ativo. Se ele usa `exposedbydefault=false`, nada muda: o
NoPaper já declara `traefik.enable=true`.

## 7. Baixar o NoPaper

Use sempre uma **versão publicada** (tag), não o `main`, e clone por **HTTPS** (é por onde a
atualização pela interface baixa as versões novas):

```sh
git clone https://github.com/wegnix/nopaper.git
cd nopaper
git checkout v1.0.0          # a versão mais recente está em Releases / CHANGELOG.md
```

A pasta do código pode ficar onde você preferir (ex.: `/opt/nopaper`); os dados vão para
`/storage/nopaper` de qualquer forma (seção 4).

## 8. Configurar o `.env`

```sh
cp .env.example .env
chmod 600 .env               # só o seu usuário lê (tem senhas)
```

Use **`cp`**, não `mv`: o `.env.example` faz parte do projeto, e apagá-lo bloqueia a atualização
pela interface (seção 12).

Gere os segredos e cole no `.env`:

```sh
echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"
echo "JWT_SECRET=$(openssl rand -base64 48)"
echo "SECRETS_KEY=$(openssl rand -base64 48)"
```

Preencha no mínimo:

| Variável | Valor |
|---|---|
| `APP_DOMAIN` | o domínio do passo 2, sem `https://` |
| `POSTGRES_PASSWORD`, `JWT_SECRET`, `SECRETS_KEY` | os valores gerados acima |
| `ADMIN_EMAIL` | e-mail do primeiro administrador |
| `ADMIN_PASSWORD` | senha **provisória** (mín. 8 caracteres) — será trocada no primeiro login |
| `DATA_PATH` | só se não quiser `/storage/nopaper` (seção 4) |
| `TRAEFIK_*` | só se o seu Traefik não usar os padrões (passo 6b) |
| `COMPOSE_FILE`, `WEB_PORT`, `WEB_BIND` | só sem Traefik (seção 5a) |

> **Guarde o `SECRETS_KEY` num lugar seguro, junto com a política de backups.** Ele cifra as
> senhas de SMTP, o token do Telegram e as credenciais do backup remoto guardados no banco. Um
> backup restaurado com outra chave funciona, mas esses segredos precisam ser digitados de novo.

## 9. Subir

```sh
docker compose up -d --build
docker compose ps            # db, api, web e updater devem ficar "healthy" (1–2 minutos)
docker compose logs -f api   # Ctrl+C para sair
ls /storage/nopaper          # banco  anexos  backups  atualizador
```

Na primeira subida a API cria as tabelas e o administrador do `.env`. No log aparece
`administrador inicial criado a partir do .env`. Em seguida, abra `https://seu-dominio`.
O primeiro certificado pode levar alguns segundos para ser emitido.

## 10. Primeiro acesso

1. Entre com o usuário (`ADMIN_USERNAME`, padrão `admin`) ou o e-mail e a senha provisória.
2. Defina a sua senha, o **nome** e o **perfil** do primeiro espaço:
   - **Pessoal** — pastas e categorias para finanças pessoais;
   - **Empresa** — o mesmo + pastas FUNCIONARIO/BANCO e categorias como Salário, Pró-Labore (restrita),
     Comissão, Férias, Frota.
3. **Apague o `ADMIN_PASSWORD` do `.env`** — ele não é mais lido.

Não existe cadastro público: novas pessoas são criadas por um administrador em
**Configurações → Membros** (dentro do espaço) ou **Configurações → Plataforma → Usuários**.

## 11. E-mail, Telegram e backups

Tudo em **Configurações → Plataforma** (só o administrador da plataforma vê):

- **E-mail e Telegram** — servidor SMTP (Gmail, Outlook, Amazon SES, Brevo…) e o bot do Telegram
  usados pelos alertas de vencimento. Cada espaço escolhe os seus alertas em Configurações → Alertas.
- **Segurança** — tempo sem uso até o logoff automático (padrão 60 minutos).
- **Backups e restauração** — agenda (diária, por exemplo), quantos guardar e uma **cópia remota**
  (SFTP ou qualquer destino do rclone). Cada backup tem o banco + os anexos, é verificado ao final e
  registra a versão do NoPaper que o gerou. Os arquivos ficam em `/storage/nopaper/backups/`.

Mantenha **sempre uma cópia fora do servidor** (o remoto acima, ou copiando os arquivos de
`/storage/nopaper/backups/` para outro lugar, ex.: `rsync -a /storage/nopaper/backups/ outro-servidor:backups-nopaper/`).

## 12. Atualizar para uma versão nova

Versões seguem SemVer: `1.0.x` (correção) e `1.x.0` (novidades) é só atualizar; `x.0.0` (maior)
traz nas notas o que fazer **antes** (ex.: variável nova no `.env`).

### Pela interface (recomendado)

Em **Configurações → Plataforma → Atualizações** aparecem as versões publicadas no GitHub mais novas
que a instalada, com as notas de cada uma.

1. Clique em **Atualizar para vX.Y.Z**.
2. **Faça o backup completo** (banco + todos os anexos) — obrigatório, vale por 1 hora. Se houver
   destino remoto configurado, ele vai junto; dá também para baixar uma cópia ali mesmo.
3. Marque que leu as mudanças (e, numa versão maior, que fez o que elas pedem) e confirme.

O sistema baixa a versão, reconstrói as imagens (alguns minutos: o NoPaper continua funcionando
nesse tempo), reinicia a API e a interface (fica fora do ar por alguns segundos) e confere se
voltaram saudáveis. **Se algo falhar, volta sozinho para a versão anterior** e mostra o registro.
As mudanças no banco (migrations) são aplicadas quando a API sobe; quem estiver com o sistema
aberto vê o aviso "Nova versão do NoPaper disponível" com o botão Recarregar. Os dados em
`/storage/nopaper` não são tocados pela troca de containers.

Quem faz isso é o serviço **`updater`** do `docker-compose.yml`. Para ele funcionar:

- a instalação precisa ser um **clone git** (passo 7, por HTTPS) e os arquivos do projeto não podem
  ter sido alterados no servidor (`git status` limpo — o `.env` não conta);
- ele usa o socket do Docker (`/var/run/docker.sock`). Com **Docker rootless**, crie um
  `docker-compose.override.yml` ao lado do `docker-compose.yml` com o caminho do seu socket:
  ```yaml
  services:
    updater:
      volumes:
        - /run/user/1000/docker.sock:/var/run/docker.sock
  ```
- ele respeita o `COMPOSE_FILE` do `.env` e o `docker-compose.override.yml` (ex.: porta direta da
  seção 5a), do mesmo jeito que quando você roda `docker compose` na pasta;
- se você mantém um fork, defina `UPDATE_REPO=seu-usuario/nopaper` no `.env`.

> **Segurança:** quem acessa o socket do Docker controla o servidor. Por isso o `updater` não é
> exposto (só a rede interna), só aceita pedidos da API com um token derivado do `JWT_SECRET`, só
> aplica tags `vX.Y.Z` existentes no repositório de origem e só pode ser acionado pelo administrador
> da plataforma, depois do backup. Se preferir não ter esse serviço, apague o bloco `updater` do
> `docker-compose.yml` e atualize pela linha de comando.

### Pela linha de comando

```sh
# 1) backup em Configurações → Plataforma → Backups → "Fazer backup agora"
# 2) atualizar
cd nopaper
git fetch --tags
git checkout v1.1.0          # a versão desejada
docker compose up -d --build
docker image prune -f        # opcional: apaga imagens antigas
```

**Voltar para a versão anterior:** `git checkout` da tag anterior e `docker compose up -d --build`.
Se a versão nova já tiver alterado o banco, restaure o backup feito antes (próxima seção).

## 13. Restaurar um backup

- **Pela interface** (recomendado): Configurações → Plataforma → Backups e restauração → aba
  *Restaurar*. Aceita um backup local, do remoto ou enviado do seu computador. O sistema confere o
  arquivo, faz um backup de segurança do estado atual, entra em manutenção, troca banco e anexos e,
  se algo falhar, desfaz sozinho.
- **Pela linha de comando** (sistema fora do ar, servidor novo):
  ```sh
  ./scripts/restore.sh /caminho/nopaper-AAAAMMDD-HHMMSS.tar.gz
  ```
  O script pede para digitar `RESTAURAR`, guarda o banco atual em
  `/storage/nopaper/backups/pre-restore-*.dump` e substitui banco e anexos.

Um backup só pode ser restaurado numa versão do NoPaper **igual ou mais nova** que a que o gerou.

## 14. Problemas comuns

| Sintoma | O que verificar |
|---|---|
| `Bind for 0.0.0.0:80 failed: port is already allocated` ou `address already in use` | Outro serviço usa a porta: `sudo ss -ltnp \| grep -E ':(80\|443) '`. Veja a [seção 5](#5-portas) (usar o proxy existente ou a porta direta). |
| `404 page not found` | O Traefik não encontrou o NoPaper: `TRAEFIK_NETWORK` errado ou o container `web` fora da rede (`docker network inspect traefik`). Veja `docker logs traefik`. |
| Certificado inválido / "TRAEFIK DEFAULT CERT" | DNS ainda não aponta para o servidor, porta 80 fechada ou `TRAEFIK_CERTRESOLVER` errado. O log do Traefik mostra o erro da Let's Encrypt. |
| `required variable APP_DOMAIN is missing` (ou `POSTGRES_PASSWORD`, `JWT_SECRET`) | Falta a variável no `.env` (na mesma pasta do `docker-compose.yml`). |
| `!override`/`!reset` desconhecido ao usar `deploy/porta-direta.yml` | Docker Compose antigo: atualize para 2.24 ou mais novo. |
| Pela porta direta o login entra mas cai ao recarregar | Está acessando por `http://`: a sessão exige HTTPS — acesse pelo domínio, através do seu proxy (seção 5a). |
| `api` reiniciando | `docker compose logs api` — normalmente variável inválida (ex.: `JWT_SECRET` com menos de 32 caracteres). |
| `Permission denied` em `/storage/nopaper/...` | A pasta foi criada/copiada por outro usuário com permissões restritas. Reinicie (`docker compose restart api`): a API corrige o dono de `anexos/` e `backups/` ao subir. Para o banco: `docker compose restart db`. |
| "ninguém consegue entrar" no log | Primeira subida sem `ADMIN_EMAIL`/`ADMIN_PASSWORD`. Preencha e rode `docker compose up -d`. |
| Esqueci a senha do administrador | `docker compose exec api node dist/scripts/reset-password.js <usuário ou e-mail>` — gera uma senha provisória. |
| Atualizações: "o serviço de atualização não está rodando" | `docker compose ps updater` e `docker compose logs updater`. Com Docker rootless, ajuste o caminho do socket (seção 12). |
| Atualizações: "arquivos do projeto alterados" | A tela lista os arquivos. Na pasta do projeto, `git restore <arquivo>` desfaz (o `.env` não é afetado). Caso comum: `deleted: .env.example` porque o `.env` foi criado com `mv` em vez de `cp` — `git restore .env.example` resolve. Mudanças que você precisa manter no compose vão num `docker-compose.override.yml`. |
| Build parando por falta de memória | Servidor com menos de 2 GB: crie um swap (`fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile`). |

Comandos úteis:

```sh
docker compose ps                 # estado dos containers
docker compose logs --tail 200 api
docker compose restart api
docker compose down               # para tudo (os dados continuam em /storage/nopaper)
```

> Os containers podem ser apagados e recriados à vontade. **O que não pode ser apagado é a pasta
> `/storage/nopaper`** (ou o `DATA_PATH` que você escolheu): ela é o sistema.
