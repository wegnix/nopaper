# Changelog

Todas as mudanças relevantes do NoPaper ficam registradas aqui.
Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/); versões seguem
[SemVer](https://semver.org/lang/pt-BR/): **CORREÇÃO** (1.0.x) só corrige, **MENOR** (1.x.0) traz
novidades compatíveis e **MAIOR** (x.0.0) exige alguma ação na atualização — descrita na própria seção.
Como atualizar: [docs/publicacao-com-traefik.md](docs/publicacao-com-traefik.md#12-atualizar-para-uma-versão-nova).

## [Não lançado]

## [1.3.0] - 2026-11-05

### Novo
- **Folha de pagamento** (só em espaços do tipo Empresa): cadastro de funcionários (CPF, cargo,
  admissão, PIX e dados bancários) e a folha de cada mês com o líquido do holerite — digitado ou
  detalhado em rubricas (salário base, INSS, IRRF, vale-transporte…) —, os valores pagos fora do
  holerite (metas, vitaminas, comissão, hora extra) e os descontos de produtos/vales. Mostra quanto vai
  pelo holerite e quanto vai por fora, os encargos (FGTS) e o custo total para a empresa.
- Cada funcionário do mês vira uma conta a pagar "Salário Fulano – Nov/2026", com o PIX dele, na
  categoria e pasta escolhidas em Configurar (padrão: Salário / FUNCIONARIO). Valor e vencimento seguem
  a folha; depois de pago, o lançamento fica travado até reverter o pagamento.
- Abrir um mês novo já traz os funcionários ativos com o líquido e as rubricas fixas do último mês.
- Importação do histórico a partir da planilha da folha (um bloco por mês), com prévia mês a mês,
  avisos e opção de desfazer. Os meses importados ficam só como histórico, sem criar contas a pagar.
- Novas permissões de grupo: ver a folha, lançar/editar o mês e gerenciar funcionários/rubricas.

### Melhorado
- Cartões: os dias de fechamento e de vencimento agora são escolhidos numa grade de dias (a lista
  longa fechava sozinha em alguns navegadores), e o cadastro explica com as datas reais em qual fatura
  cai uma compra feita hoje.
- Datas de Contas a pagar e a receber (vencimento, data do pagamento, parcelas, baixa em massa) e da
  folha agora são escolhidas num calendário próprio, igual em todos os navegadores e no iPhone, com
  atalho para hoje e troca rápida de mês/ano.

### Corrigido
- No celular, o cadastro de conta ficava mais largo que a tela (a barra de "Repetição" empurrava o
  diálogo) e cortava o botão de salvar.

## [1.2.1] - 2026-11-04

### Corrigido
- Cartões no iPhone: na imagem do cartão, o nome do titular e as datas de fechamento e vencimento
  ficavam cortados (o Safari do iOS calculava a altura do cartão de outro jeito). Agora o cartão tem a
  altura de um cartão de verdade e cresce se o texto precisar, sem cortar nada.

## [1.2.0] - 2026-11-04

### Corrigido
- **iPhone (app instalado na tela de início):** o topo ficava por baixo do relógio/notch e o menu não
  respondia ao toque. O app agora respeita as áreas seguras da tela (topo, laterais e indicador de
  início) e a barra de status segue a cor do tema. *Para valer no app já instalado, remova o ícone e
  adicione de novo pelo Safari (Compartilhar → Adicionar à Tela de Início).*
- No iOS, tocar num campo de texto dava zoom na página e ela não voltava.
- Início e Relatórios: no celular, quadros como "Precisa de atenção", "Por categoria" e "Maiores contas"
  passavam da largura da tela e cortavam os valores.
- Contas a pagar/receber em telas de notebook (até ~1500 px): a coluna de ações da tabela ficava cortada.
  Pasta e data de pagamento passam para dentro das colunas Descrição e Situação nessas telas.

### Alterado
- Celular e tablet repensados:
  - Contas a pagar/receber viram cartões (1 coluna no celular, 2 no tablet), com **Ordenar**,
    **selecionar pendentes** e botão de copiar descrição + valor. Os filtros de dia, pasta e categoria
    ficam recolhidos no botão **Filtros** no celular, e os indicadores do mês rolam para o lado.
  - Configurações: no lugar da fileira de abas que escondia itens, uma lista com todas as seções.
  - Cabeçalho, menu lateral, diálogos (abrem por baixo, como folha) e botões de ação com áreas de
    toque maiores; avisos (toasts) não ficam sob a barra de status.
  - Gráfico mês a mês: no toque, o 1º toque mostra o resumo do mês e o 2º abre a lista.
  - Início em 2 colunas no tablet; carrossel de cartões com encaixe ao deslizar.

## [1.1.1] - 2026-11-04

### Adicionado
- Filtro **Dia** em Contas a pagar e a receber: um botão para cada dia que tem vencimento no mês (com a
  quantidade de contas e um ponto vermelho se houver atraso); dá para escolher mais de um dia. A soma
  da lista e a exportação "como está na tela" respeitam o filtro.

### Corrigido
- Contas do mesmo dia apareciam em ordem aleatória. Agora, depois do vencimento, a ordem é alfabética
  pela descrição (sem diferenciar maiúsculas e acentos) — na lista, na exportação e nos alertas.

## [1.1.0] - 2026-11-04

### Adicionado
- Repetição **Semanal** e **Quinzenal** para contas a pagar e a receber (academia, diarista…): o dia da
  semana vem do primeiro vencimento; dá para definir quantas vezes, valores diferentes em cada uma ou
  "repetir sem data para acabar" (o sistema mantém 6 meses lançados e cria os seguintes sozinho).
  Cada semana é uma conta própria: paga separada, com comprovante, alertas e relatórios.

## [1.0.2] - 2026-11-04

### Adicionado
- Cartões: botão **Reverter pagamento** na fatura paga, e uma linha mostrando em que mês a fatura está em
  Contas a pagar (paga ou pendente), com link direto.
- Atualizações: quando há arquivos do projeto alterados no servidor, a tela mostra quais são e como
  desfazer; o motivo do bloqueio aparece ao lado do botão de atualizar.

### Alterado
- Contas a pagar e a receber abrem em **Todas** (pagas e pendentes do mês), não mais só nas pendentes:
  faturas de cartão e contas já pagas aparecem sem precisar trocar o filtro.

## [1.0.1] - 2026-11-04

### Segurança
- Os cabeçalhos de segurança (HSTS, Referrer-Policy, Permissions-Policy) agora saem em todas as
  páginas e arquivos da interface — antes o nginx os descartava nas rotas com cabeçalhos próprios.
  Nas respostas da API eles não saem mais duplicados.

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
