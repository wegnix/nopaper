# NoPaper

**Gestão financeira sem papel para casas e pequenas empresas.** Contas a pagar e a receber, cartões
de crédito, anexos com leitura automática de boleto e PIX, relatórios, alertas e backups — num
sistema web multiusuário que você hospeda no seu próprio servidor.

[![Versão](https://img.shields.io/badge/vers%C3%A3o-1.0.0-5b4be8)](CHANGELOG.md)
[![Licença: MIT](https://img.shields.io/badge/licen%C3%A7a-MIT-green)](LICENSE)

> Interface em português do Brasil, com formatos brasileiros (R$, datas, CPF/CNPJ, boleto FEBRABAN, PIX).

---

## Funcionalidades

**Contas a pagar e a receber**
- Pastas (ex.: fixas/variáveis, com/sem nota) e categorias coloridas; categorias **restritas**, que só
  aparecem para quem tem permissão.
- Repetição mensal ou anual, com ou sem data para acabar; **parcelamentos** de até 420 parcelas, inclusive
  começando no meio (ex.: consórcio na parcela 42 de 213); alteração de valor "desta em diante".
- Anexos por conta (boleto, nota fiscal, comprovante) com **leitura automática** da linha digitável,
  do código PIX e do valor/vencimento.
- Filtros, indicadores do mês, pagamento em lote e exportação para planilha ou ZIP com os anexos
  (para a contabilidade).

**Cartões de crédito**
- Ciclo de fechamento e vencimento, compras parceladas e estornos; cada fatura vira uma conta a pagar
  sincronizada. Limite usado, titular e bandeira no cartão.

**Espaços e pessoas**
- Vários **espaços** (casa, empresa, cliente…) isolados entre si, cada um com perfil **Pessoal** ou
  **Empresa** e estrutura inicial de pastas e categorias própria.
- Membros, grupos e permissões granulares (ver, lançar, pagar, apagar, administrar), sem
  escalada de privilégio. Sem cadastro público: só administradores criam contas.
- **Auditoria** de tudo o que muda, com filtros e o "antes → depois" de cada edição.

**Operação**
- Importação de planilhas (.xlsx/.csv) com mapeamento de colunas, prévia e desfazer.
- Painel e relatórios anuais por mês, categoria e pasta.
- Alertas de vencimento por **e-mail** e **Telegram**.
- **Backups agendados** (banco + anexos), verificados, com cópia remota por SFTP ou rclone
  (Google Drive, S3…), e **restauração pela interface** com desfazer automático em caso de falha.
- **Atualização pela interface**: as versões novas publicadas no GitHub aparecem com as notas; a
  atualização exige um backup completo antes e volta sozinha para a versão anterior se algo falhar.
- Instala como aplicativo (PWA), temas claro e escuro.

## Tecnologia

| Parte | Stack |
|---|---|
| Interface (`apps/web`) | React 19, Vite, Tailwind CSS 4, Radix UI, TanStack Query |
| API (`apps/api`) | Node.js 22, Fastify 5, Drizzle ORM, pg-boss (tarefas agendadas) |
| Banco | PostgreSQL 17 |
| Compartilhado (`packages/shared`) | TypeScript + Zod: validação, permissões, dinheiro, datas, boleto e PIX |
| Produção | Docker Compose atrás do [Traefik](https://traefik.io) (HTTPS automático) |

## Instalação

Você precisa de um servidor Linux com Docker e de um domínio apontando para ele. O passo a passo
completo — DNS, onde ficam os dados (`/storage/nopaper`), portas e conflitos, Traefik (inclusive se
você ainda não tem um, ou se usa outro proxy), configuração, primeiro acesso, backups, atualização e
solução de problemas — está em
**[docs/publicacao-com-traefik.md](docs/publicacao-com-traefik.md)**.

Resumo, para quem já tem Docker e Traefik:

```sh
git clone https://github.com/wegnix/nopaper.git && cd nopaper
git checkout v1.0.0
cp .env.example .env && chmod 600 .env
nano .env                         # domínio, senhas/segredos e o administrador inicial
docker compose up -d --build
```

Abra `https://seu-dominio`, entre com o administrador do `.env` e siga a tela de primeiro acesso
(nova senha + nome e perfil do primeiro espaço).

## Configuração

Tudo pelo arquivo `.env` (modelo comentado em [.env.example](.env.example)):

| Variável | Obrigatória | Para quê |
|---|---|---|
| `APP_DOMAIN` | sim | Domínio do sistema (usado pelo Traefik) |
| `DATA_PATH` | não | Pasta dos dados permanentes (padrão `/storage/nopaper`: `banco/`, `anexos/`, `backups/`, `atualizador/`) |
| `POSTGRES_PASSWORD` | sim | Senha do banco |
| `JWT_SECRET` | sim | Assina as sessões (≥ 32 caracteres) |
| `SECRETS_KEY` | recomendada | Cifra os segredos guardados no banco (SMTP, Telegram, backup remoto) |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | na 1ª subida | Administrador inicial; a senha é provisória |
| `ADMIN_USERNAME`, `ADMIN_NAME`, `ADMIN_ORG_NAME` | não | Usuário, nome e sugestão de nome do 1º espaço |
| `APP_URL` | não | URL dos links em e-mails/Telegram (padrão: `https://APP_DOMAIN`) |
| `TRAEFIK_NETWORK`, `TRAEFIK_ENTRYPOINT`, `TRAEFIK_CERTRESOLVER` | não | Para usar um Traefik já existente com outros nomes |
| `COMPOSE_FILE`, `WEB_PORT`, `WEB_BIND` | não | Sem Traefik: publica a interface numa porta para outro proxy (nginx, Caddy…) |
| `TZ`, `MAX_UPLOAD_MB`, `LOG_LEVEL` | não | Fuso padrão, tamanho máximo de anexo, nível de log |
| `STORAGE_QUOTA_MB` | não | Cota padrão de arquivos por espaço (5120 = 5 GB); ajustável por espaço em Plataforma → Segurança |
| `UPDATE_REPO` | não | Repositório das atualizações (padrão `wegnix/nopaper`; troque se usar um fork) |

E-mail (SMTP), bot do Telegram e backups são configurados depois, pela interface, em
**Configurações → Plataforma**.

## Segurança

- Senhas com Argon2id; sessões com token de acesso curto + renovação rotativa com detecção de reuso.
- Logoff por inatividade configurável (padrão 60 min), aplicado no navegador e no servidor.
- Limite de tentativas por IP e bloqueio temporário por conta após 5 senhas erradas.
- Segredos de integração cifrados no banco e nunca devolvidos para o navegador.
- Anexos servidos só por links assinados de curta duração.
- Cabeçalhos de segurança no nginx (HSTS, X-Frame-Options, nosniff, Permissions-Policy); banco e API
  sem portas expostas — só a interface, através do Traefik.

Encontrou uma vulnerabilidade? Não abra uma issue pública — use
**[Security → Report a vulnerability](https://github.com/wegnix/nopaper/security/advisories/new)** no GitHub.

## Versões

O NoPaper segue [SemVer](https://semver.org/lang/pt-BR/): `MAIOR.MENOR.CORREÇÃO`.
Cada versão vira uma [Release](https://github.com/wegnix/nopaper/releases) com as notas do
[CHANGELOG.md](CHANGELOG.md), e a instalação mostra as novas em **Configurações → Plataforma →
Atualizações**, de onde se atualiza com um clique (depois do backup obrigatório). Versões **maiores**
avisam nas notas o que fazer antes. A versão instalada aparece no rodapé do menu lateral.

## Licença e créditos

Distribuído sob a **[licença MIT](LICENSE)**: você pode usar, copiar, modificar e redistribuir,
inclusive comercialmente, desde que mantenha o aviso de copyright e a licença.

Criado por **Wesley Farias** ([@wegnix](https://github.com/wegnix)). Se você fizer uma versão
modificada ou usar o NoPaper num projeto seu, mencione o projeto original com um link para este
repositório — e, se quiser, conte para mim abrindo uma issue. Sugestões e relatos de erro também são
bem-vindos nas [issues](https://github.com/wegnix/nopaper/issues).
