# Changelog

Todas as mudanças relevantes do NoPaper ficam registradas aqui.
Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/); versões seguem
[SemVer](https://semver.org/lang/pt-BR/): **CORREÇÃO** (1.0.x) só corrige, **MENOR** (1.x.0) traz
novidades compatíveis e **MAIOR** (x.0.0) exige alguma ação na atualização — descrita na própria seção.
Como atualizar: [docs/publicacao-com-traefik.md](docs/publicacao-com-traefik.md#12-atualizar-para-uma-versão-nova).

## [Não lançado]

## [1.0.0] - 2026-11-04

Primeira versão pública.

### Adicionado
- Espaços (organizações) multiusuário com membros, grupos e permissões granulares (anti-escalada).
- Perfis de espaço **Pessoal** e **Empresa**, cada um com pastas e categorias padrão próprias;
  no 1º acesso o administrador escolhe nome e perfil do espaço inicial.
- Contas a pagar e a receber: pastas, categorias com cores (inclusive restritas), recorrência mensal/anual
  com ou sem fim, parceladas (até 420 parcelas, com nº inicial — ex.: 42/213), anexos (boleto, nota,
  comprovante) com leitura automática, filtros, KPIs e exportação (planilha e ZIP).
- Cartões de crédito: ciclo de fechamento, compras parceladas, fatura que vira conta a pagar, cor preta,
  logos das bandeiras, titular no cartão; edição clicando no cartão e exclusão com confirmação segura.
- Importação de planilhas com mapeamento, prévia e desfazer.
- Relatórios e painel inicial com gráficos.
- Alertas por Telegram e e-mail; backups agendados (local + remoto via rclone/SFTP) verificados,
  e restauração pela web com rollback automático.
- Auditoria com filtros e modo detalhado (antes → depois).
- **Atualização pela interface** (Configurações → Plataforma → Atualizações): mostra as Releases novas
  do GitHub com as notas, exige um backup completo feito na hora e volta sozinha para a versão anterior
  se algo falhar. Releases criadas automaticamente a partir deste CHANGELOG ao publicar uma tag.
- **Logoff por inatividade** configurável em Configurações → Plataforma → Segurança (padrão 60 min,
  de 5 min a 24 h), com aviso 1 minuto antes; também aplicado pelo servidor.
- Tela de entrada com três animações que se alternam a cada acesso; menu lateral com degradê.
- PWA (instala como app); temas claro e escuro.
- Versão do sistema visível no menu lateral, gravada nos backups e aviso de "nova versão disponível".
- Dados permanentes numa pasta do servidor, fora dos containers: `/storage/nopaper` (`DATA_PATH`), com
  subpastas `banco/`, `anexos/`, `backups/` e `atualizador/`.
- Guia de publicação com Traefik (inclusive um Traefik pronto em `deploy/traefik/`, com portas
  configuráveis), opção sem Traefik atrás de outro proxy (`deploy/porta-direta.yml`) e licença MIT.

### Segurança
- Senhas com Argon2id, sessão com token curto e renovação rotativa com detecção de reuso.
- Limite de tentativas de login por IP (só confiando no IP vindo dos proxies internos) e bloqueio de
  15 minutos por conta após 5 senhas erradas.
- Sair numa aba encerra a sessão em todas; os dados em cache são descartados ao sair.
