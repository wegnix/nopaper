# Changelog

Todas as mudanças relevantes do NoPaper ficam registradas aqui.
Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/); versões seguem
[SemVer](https://semver.org/lang/pt-BR/): **CORREÇÃO** (1.0.x) só corrige, **MENOR** (1.x.0) traz
novidades compatíveis e **MAIOR** (x.0.0) exige alguma ação na atualização — descrita na própria seção.
Como atualizar: [docs/publicacao-com-traefik.md](docs/publicacao-com-traefik.md#12-atualizar-para-uma-versão-nova).

## [Não lançado]

## [1.9.0] - 2026-11-10

### Novo
- **Importar holerites** (Folha de pagamento → **Importar holerites**): envie o PDF que o contador manda
  com os holerites de todos. Cada holerite entra detalhado no lançamento do funcionário (salário,
  diferença salarial, horas extras, INSS, consignado…), já conferido com o valor líquido — não precisa
  mais digitar. As duas vias de cada holerite contam uma vez só, e metas, comissões e descontos por fora
  não mudam. Na 1ª vez você confere quem é quem (a matrícula fica salva no cadastro) e a rubrica de cada
  linha do holerite (as que faltam são criadas); nos meses seguintes é só enviar e lançar. Antes de
  gravar, a tela mostra o que muda em cada pessoa. Quem recebe um valor diferente do holerite (ex.: sócia
  com pró-labore que recebe como funcionária) tem o campo **Líquido combinado**: a diferença entra por
  fora e é lembrada ao importar de novo. Salário já pago não é alterado.
- **Só holerite**: para quem tem holerite mas não recebe pela empresa (sócio que não trabalha, acordo…).
  Marque no cadastro do funcionário ou direto na importação: o holerite fica registrado no mês, sem
  valor a pagar, sem conta a pagar e sem custo, e a pessoa fica fora dos totais e da impressão da folha.
- Cadastro do funcionário: campo **Matrícula no holerite**.

### Alterado
- **Importar vendas (comissões)** e **Importar holerites** sugerem a folha certa quando a folha do espaço é
  contada pelo mês do pagamento: vendas e holerites de outubro entram na folha de novembro (quem trabalha
  num mês recebe no seguinte). O mês continua podendo ser trocado na janela.
- Dois modelos de holerite são reconhecidos: “Recibo de Pagamento de Salário” e “Demonstrativo de Pagamento
  de Salário” (neste, o CPF do holerite já preenche o cadastro de quem for criado na importação).
- **Pró-labore sem FGTS**: vencimento do holerite marcado como **sem FGTS** (Configurar → Rubricas) não entra
  no cálculo de FGTS, 13º e férias do custo da empresa. A rubrica “Pró-labore” já nasce assim.

## [1.8.0] - 2026-11-10

### Novo
- **Importar a fatura do cartão em OFX** (Cartões → **Importar fatura**): escolha o arquivo exportado
  no app do banco e confira antes de importar. A fatura é sugerida pelas datas das compras; a descrição
  vem limpa (sem a cidade) e pode ser editada; a categoria é sugerida pelo que você usou antes na mesma
  loja. Compra parcelada (ex.: 02/12) entra nesta fatura e as parcelas seguintes já vão para as próximas.
  Estornos abatem da fatura; o pagamento da fatura anterior fica de fora. O que já está lançado é
  reconhecido e não entra de novo, e cada importação pode ser desfeita (enquanto nenhuma fatura com
  lançamentos dela estiver paga). Parcela futura nunca cai em fatura já paga.
- **Categorias do cartão**: as compras no cartão agora têm categorias próprias (Cartões → **Categorias**),
  separadas das de Contas a pagar — lá a fatura inteira continua com a categoria escolhida no cadastro do
  cartão. Crie, renomeie, mude a cor ou apague (as compras vão para outra categoria). Todo espaço começa com
  uma lista pronta (Supermercado, Combustível, Compras online, Assinaturas, Saúde e farmácia, Seguros…) e as
  compras já existentes foram classificadas pelo nome da loja (a categoria de contas a pagar que elas tinham
  deixa de ser usada nas compras; confira e ajuste em Editar, se quiser).
- **Gastos por categoria na fatura**: valor, percentual e total consumido de cada categoria do cartão; clique
  numa categoria para ver só as compras dela. Também no Relatório, em "Dentro das faturas de cartão".
- A categoria da compra é sugerida pelo nome da loja (na importação da fatura e ao lançar à mão) e, depois, pelo
  que você usou antes na mesma loja. Ao trocar a categoria de uma compra, dá para mudar junto as outras da mesma loja.

### Corrigido
- Janelas Categorias e Pastas de Contas a pagar/receber mostravam "0 conta(s)" em todas.

## [1.7.0] - 2026-11-09

### Novo
- **Contas bancárias e extrato OFX** (espaços Pessoal e Empresa): importe o extrato exportado do banco
  em OFX (padrão ou com datas ISO 8601). A conta bancária é reconhecida pelo banco, agência e número do
  arquivo (ou cadastrada na hora), o saldo do extrato fica guardado e lançamentos já importados não
  entram de novo.
- **Conciliação** do extrato com as contas a pagar e a receber, em três modos: **Só conferir** (o que
  está no extrato e no NoPaper, só no extrato e só no NoPaper, sem alterar nada), **Ligar às contas**
  (o NoPaper sugere o par pelo mesmo valor e data próxima; ao aplicar, dá baixa na data do banco ou só
  liga se a conta já estava paga) e **Ligar e criar contas** (o que sobrar vira conta nova já paga, na
  categoria escolhida — dá para marcar vários de uma vez). Lançamentos podem ser ignorados, e tudo pode
  ser desfeito lançamento a lançamento ou por importação.
- Permissões novas em Grupos: ver contas bancárias, importar/conciliar extratos e cadastrar contas
  bancárias.

### Melhorado
- Listas de escolha (categoria, pasta, tipo, mês…) no computador abrem uma lista própria do NoPaper,
  que fica aberta com um clique — antes, em alguns sistemas a lista do navegador fechava ao soltar o
  botão do mouse. No celular e no tablet continua o seletor do próprio aparelho.
- Cadastro da conta bancária: o banco é escolhido com busca (nome ou código).

## [1.6.0] - 2026-11-09

### Novo
- Folha de pagamento: **comissões pelo relatório de vendas**. Em Configurar → Comissões, crie as
  regras (grupos de produtos, % sobre o valor de vendas ou R$ por unidade, metas como "30 unidades ou
  mais paga R$ 5 por unidade" e a rubrica onde o valor entra). Todo mês, no botão **Importar vendas**
  da Folha de pagamento, envie o PDF "Vendas Vendedor e Grupo Produtos": o mês da folha vem do período
  do relatório (dá para trocar), a prévia mostra a conta de cada vendedor e, ao confirmar, os valores
  entram nos lançamentos (importar de novo substitui, não duplica). Depois de importar, o mês mostra o
  resumo das comissões e o botão **Ver comissões**, que reabre a tela para conferir, mudar as ligações
  de vendedores ou lançar de novo após mudar uma regra (sem enviar o PDF outra vez).
- Cadastro do funcionário: campo **Código de vendedor** (o número do relatório de vendas). Só quem tem
  código recebe comissão; dá para ligar também na hora de importar o relatório.

### Melhorado
- Janelas de cadastro e configuração (configurar a folha, funcionário, lançamento e mês da folha,
  contas a pagar/receber, cartão e compra no cartão, categoria, pasta, grupo, membro e usuário):
  **Salvar** grava e mantém a janela aberta, com o aviso "Alterações não salvas"/"Tudo salvo";
  **Fechar** fecha quando você quiser e pergunta antes de descartar o que não foi salvo. Ao criar algo,
  a janela continua aberta já editando o que foi criado (na compra do cartão, fica pronta para a
  próxima compra).

## [1.5.0] - 2026-11-06

### Novo
- Folha de pagamento: o botão **Imprimir** abre uma janela para escolher as colunas que vão para o
  papel (por exemplo, tirar uma campanha que acabou ou a coluna "Por fora") e mudar a ordem delas
  com as setas. A escolha fica salva para os próximos meses. Um extra desmarcado que tenha valor no
  mês entra na coluna **Outros extras**, para o total do salário continuar fechando; extras sem valor
  no mês já não aparecem.

## [1.4.1] - 2026-11-06

### Corrigido
- Folha de pagamento: o indicador "Pelo holerite" virou **Líquido dos holerites** e agora bate com a
  soma da coluna Holerite. Quando os descontos de um funcionário passam dos extras e são abatidos do
  próprio salário, o indicador mostra quanto foi abatido, e a linha dele avisa "desconto maior que os
  extras" com o valor que será depositado.
- O botão **Ordenar** das seções do lançamento aparece também em salários já pagos (a ordem é uma
  configuração geral e não altera o lançamento).

## [1.4.0] - 2026-11-06

### Novo
- Folha de pagamento: **imprimir a folha do mês** em A4 paisagem, no formato da planilha — líquido do
  holerite, uma coluna para cada valor fora do holerite usado no mês (Meta global, Meta individual,
  Vitaminas…), total do salário, descontos, salário a pagar e valor por fora, com totais.
- Rubricas novas no holerite: **Diferença salarial**, **Periculosidade** e **Empréstimo consignado**
  (criadas também nos espaços que já usam a folha).
- A **ordem das rubricas** pode ser mudada em Configurar → Rubricas (setas ↑ ↓) ou direto no
  lançamento (botão **Ordenar** de cada seção); o lançamento e a impressão seguem essa ordem.
- **Custo para a empresa** de cada funcionário calculado pela legislação, sobre o bruto do holerite:
  FGTS 8%, INSS patronal conforme o regime tributário (Simples Nacional: já está no DAS; Simples
  anexo IV ou Lucro Presumido/Real: 20% + RAT + terceiros), reservas mensais de 13º e de férias + 1/3
  com os encargos delas, e outros custos lançados (vale-alimentação, parte da empresa no VT…).
  Regime, alíquotas e reservas ficam em Configurar → **Custos**.

- Funcionários: **histórico mais completo** — total pago até hoje, média por mês, quanto foi pelo
  holerite e por fora, e cada ano com o total pago (anos anteriores recolhidos).
- Funcionários: campo **Telefone / WhatsApp**, com botão para abrir a conversa no WhatsApp.

### Alterado
- O FGTS deixou de ser digitado: é calculado sozinho (8% do total de vantagens). A seção "Encargos da
  empresa" virou **Outros custos da empresa**, para benefícios pagos pela empresa.

### Corrigido
- Holerite detalhado agora fecha com o papel: mostra Total de vantagens, Total de descontos e Valor
  líquido como no holerite e pede o **valor líquido do holerite** para conferir. Se as rubricas não
  baterem com ele, avisa quanto falta ou sobra e não deixa salvar. Lançamentos detalhados sem
  conferência aparecem como "holerite não conferido" na lista do mês.

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
