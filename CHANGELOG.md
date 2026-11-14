# Changelog

Todas as mudanças relevantes do NoPaper ficam registradas aqui.
Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/); versões seguem
[SemVer](https://semver.org/lang/pt-BR/): **CORREÇÃO** (1.0.x) só corrige, **MENOR** (1.x.0) traz
novidades compatíveis e **MAIOR** (x.0.0) exige alguma ação na atualização — descrita na própria seção.
Como atualizar: [docs/publicacao-com-traefik.md](docs/publicacao-com-traefik.md#12-atualizar-para-uma-versão-nova).

## [Não lançado]

## [1.23.1] - 2026-11-13

### Corrigido
- **Senhas de PDF valem também para os anexos já guardados**: as regras só eram tentadas na hora de anexar, então
  um PDF protegido que entrou antes de a regra existir (por exemplo, o histórico trazido de outro sistema)
  continuava pedindo senha ao abrir. Agora, ao criar uma regra, o NoPaper passa por todos os anexos de contas do
  espaço e tira a senha dos que ela abre; o botão **Aplicar aos anexos já guardados** (Configuração do espaço →
  Senhas de PDF) refaz essa passada quando quiser e diz quantos abriram e quantos continuam protegidos.

## [1.23.0] - 2026-11-13

### Novo
- **Limite de chamadas por token** (Configurações → Integrações → janela do token → Chamadas por minuto): cada
  token de integração pode ter o próprio limite, de 60 a 3.000 chamadas por minuto. Em branco vale o padrão de
  300. Serve para uma carga grande, como uma migração: aumente no token usado, rode a carga e volte ao padrão
  (ou apague o token). A mudança vale em até meio minuto e fica registrada na auditoria; os cabeçalhos
  `x-ratelimit-limit` e `x-ratelimit-remaining` de cada resposta mostram o limite em vigor.

### Corrigido
- API pública: as gravações (criar, editar, dar baixa, anexar) contavam também no limite geral de 600 chamadas
  por minuto por endereço IP, além do limite do token. Agora contam só no limite do token.

## [1.22.0] - 2026-11-13

### Novo
- **Aviso de espaço errado nas importações**: quem participa de mais de um espaço pode abrir um e enviar o
  arquivo de outro. Agora o NoPaper confere o arquivo antes de importar e, se ele não for do espaço aberto,
  mostra um aviso em destaque com o que achou no arquivo, o botão para ir ao espaço certo e a opção de continuar
  só depois de marcar que conferiu. Vale para:
  - **Holerites** (Importar holerites e Assinaturas): compara o CNPJ impresso no holerite com o CNPJ do espaço
    (matriz e filial contam como a mesma empresa); sem CNPJ para comparar, olha os funcionários.
  - **Extrato bancário (OFX)**: avisa quando a conta do arquivo está cadastrada em outro espaço seu.
  - **Fatura do cartão (OFX)**: o cartão guarda a conta da primeira fatura importada; nas seguintes, a tela
    escolhe o cartão certo sozinha e avisa se a fatura for de outro cartão ou de outro espaço.
  O nome do outro espaço só aparece para quem é membro dele; para os demais, o aviso diz apenas que o arquivo
  não é deste espaço. Para o aviso dos holerites funcionar, preencha o CNPJ em Configuração do espaço.
- **Espaço privado** (Configuração do espaço → Espaço privado): uma chave que só o dono do espaço liga. Com ela,
  os administradores da plataforma que não administram aquele espaço deixam de alcançá-lo: não conseguem
  incluir nem tirar membros, não definem senha provisória nem removem a conta de quem participa dele, e não
  veem o nome do espaço nem a auditoria dele nas telas da Plataforma (aparece só "Espaço privado"). Serve para
  quando há mais de um administrador da plataforma e cada um tem o seu espaço pessoal, ou uma empresa que os
  outros não devem ver. Atenção a dois limites, escritos também na tela: quem participa de um espaço privado
  só troca a própria senha (esqueceu → só quem tem acesso ao servidor redefine), e o backup da instalação
  continua levando os dados de todos os espaços — quem baixa o backup ou acessa o servidor alcança esses dados.

### Corrigido
- **Extrato OFX não reconhecia a conta** quando a agência estava cadastrada sem o dígito e o arquivo do banco
  trazia com ele (ou o contrário): a importação oferecia criar outra conta. Agora é reconhecida como a mesma.

## [1.21.4] - 2026-11-13

### Mudou
- **Marcas do menu lateral**: a logo do NoPaper ficou maior (44 px) e a do espaço voltou a ser menor que ela
  (36 px com o menu aberto, 28 px recolhido) — a marca do NoPaper é sempre a maior do menu.

## [1.21.3] - 2026-11-13

### Corrigido
- **Folha de pagamento no celular**: nomes compridos de funcionários (nome completo, em maiúsculas) eram cortados
  com "…" na lista do mês, na aba Funcionários e na janela de Assinaturas. Agora o nome quebra em duas linhas.

### Mudou
- **Logo do espaço maior no menu lateral**: passou de 32 para 44 px no seletor de espaço (com o menu aberto).
- **Configuração do espaço**: o item "Dados do espaço" do menu das Configurações passou a se chamar
  "Configuração do espaço", já que a página reúne também senhas de PDF e exibição integrada. O endereço da
  página não mudou.

## [1.21.2] - 2026-11-13

### Mudou
- **Exibição integrada**: o cartão "Dentro de outros sistemas" (Configurações → Dados do espaço) passou a se
  chamar "Exibição integrada" e ocupa a largura toda da página, como os demais. A chave agora é "Habilitar este
  espaço na exibição integrada"; o que ela faz não mudou.

## [1.21.1] - 2026-11-13

### Corrigido
- **Modo embutido sem espaço liberado**: a tela "Nenhum espaço disponível aqui" agora tem o botão "Abrir o NoPaper
  em outra aba", que leva direto aos dados do espaço fora do outro sistema, para ligar a chave. Antes não havia
  como sair dessa tela.

## [1.21.0] - 2026-11-13

### Novo
- **Quais espaços aparecem dentro de outro sistema**: em Configurações → Dados do espaço há agora o cartão
  "Dentro de outros sistemas", com a chave "Mostrar este espaço quando o NoPaper estiver dentro de outro
  sistema". No modo embutido só aparecem os espaços com a chave ligada; os demais continuam disponíveis para
  quem abre o NoPaper direto. O cartão só existe em instalações com `EMBED_ALLOWED_ORIGINS` preenchido.

### Mudou
- **Atenção ao atualizar, se você usa o modo embutido**: a chave vem desligada em todos os espaços. Depois de
  atualizar, abra o NoPaper direto e ligue-a nos espaços que devem aparecer no outro sistema; até lá, o modo
  embutido mostra "Nenhum espaço disponível aqui".

## [1.20.0] - 2026-11-13

### Novo
- **NoPaper dentro de outro sistema (modo embutido)**: quando o NoPaper é aberto em um quadro (iframe) de outro
  sistema, ou com `?embed=1` no endereço, ele esconde o menu lateral e o cabeçalho e mostra só a tela, com uma
  faixa fina para trocar de espaço, buscar, mudar o tema e sair. O modo se mantém ao navegar, ao recarregar e
  depois do login, e o NoPaper avisa a página de fora a cada troca de tela, para o menu de lá acompanhar.
- **Quem pode embutir**: nova variável `EMBED_ALLOWED_ORIGINS` no `.env` do servidor, com os sites autorizados a
  exibir o NoPaper em quadro (ex.: `https://sistema.exemplo.com`). Vazia, nada muda: nenhum outro site consegue
  embutir. Cada pessoa continua entrando com a própria conta; para o login funcionar dentro do quadro, o NoPaper
  e o outro sistema precisam estar no mesmo domínio registrado.
- **Segundo endereço** (`APP_EXTRA_DOMAIN` no `.env`): o mesmo NoPaper pode responder em mais um domínio, com
  certificado emitido pelo Traefik. Passo a passo no manual de publicação, seção 11a.

## [1.19.0] - 2026-11-13

### Novo
- **Integrações (API pública)**: em Configurações → Espaço → Integrações dá para criar tokens para outros
  sistemas acessarem o espaço pela API `/api/v1`. Cada token tem nome, as permissões que você marcar (as mesmas
  dos grupos; modelos "Só leitura" e "Leitura e escrita"), validade opcional e lista opcional de endereços IP
  aceitos. O token aparece uma única vez, na criação; a tela mostra o último uso e permite revogar na hora.
  Membros, grupos, dados do espaço, alertas e os próprios tokens ficam fora do alcance de qualquer token.
- **API v1 — leitura de contas**: espaço e permissões do token (`/space`), contas a pagar e a receber com filtros
  e paginação (`/bills`), totais do mês (`/bills/summary`), anexos por link assinado, categorias e pastas.
  Categorias restritas só aparecem para tokens com essa permissão. Limite de 300 chamadas por minuto por token.
  A descrição completa fica em `/api/v1/openapi.json`.
- **API v1 — gravação de contas**: criar conta ou série inteira (mensal, parcelada, sem fim…), alterar, dar baixa e
  reverter, apagar (só a conta, as seguintes ou a série), anexar e remover boleto, nota e comprovante, ler um
  documento sem guardar, e criar, alterar e apagar categorias e pastas. As regras são as mesmas da tela, e tudo
  fica na auditoria como "Integração <nome do token>". Cada conta pode levar o identificador do sistema de origem
  (`externalId`): repetir a criação devolve a conta que já existe em vez de duplicar. Os POST aceitam
  `Idempotency-Key`.
- **API v1 — demais áreas**: cartões (cartões, compras, faturas, categorias de gasto, fatura em OFX), contas
  bancárias (contas, extrato OFX, conciliação), folha de pagamento (funcionários, rubricas, meses, lançamentos,
  holerites em PDF, comissões), assinatura de holerites (enviar, acompanhar, baixar o assinado, termos), área do
  contador (recebidos, enviados, conferir), relatório anual, planilha de contas e auditoria. Usam as mesmas regras
  e os mesmos formatos da tela.
- **Fila de eventos** (`/api/v1/events`): outro sistema consulta o que mudou no espaço desde a última leitura
  (conta criada, paga, apagada, compra no cartão, holerite assinado, documento do contador…), sem precisar reler
  tudo. Serve para sistemas em rede interna, que não recebem chamadas de fora.
- **Webhooks**: cada token pode ter um endereço que o NoPaper avisa a cada mudança, com assinatura para conferir
  a origem, escolha dos tipos de evento, envio de teste, novas tentativas quando o destino falha e pausa depois
  de 24 h de falhas. Por segurança o endereço precisa ser https e da internet; para um destino na sua rede
  interna, ligue `WEBHOOK_ALLOW_PRIVATE=1` no `.env` do servidor.
- Permissão nova **Gerenciar integrações** (administradores do espaço já têm).

## [1.18.0] - 2026-11-13

### Novo
- **Dados da empresa nos documentos**: o termo de aceite e o comprovante de assinatura dos holerites agora têm
  um cabeçalho com a logo, a razão social, CNPJ e inscrições, endereço e contato da empresa. As impressões da
  folha de pagamento e dos relatórios ganharam a mesma identificação no alto da página. Sai o que estiver
  preenchido em Configurações → Dados do espaço (perfil Empresa). Documentos já assinados não mudam.

### Melhorado
- **Fatura de luz e de água vai direto como boleto**: a fatura que é nota fiscal e boleto no mesmo papel
  (Copel, Sanepar) passa a ser reconhecida como boleto, já com o código de barras, o valor e o vencimento.

### Corrigido
- Em algumas notas fiscais o sistema "achava" um código de barras de concessionária que não existia; agora o
  dígito verificador geral do código também é conferido.

## [1.17.1] - 2026-11-13

### Corrigido
- **Exportar o ano inteiro em ZIP**: o servidor carregava todos os anexos na memória antes de enviar; numa
  exportação grande isso podia derrubar a API. Agora os arquivos são lidos do disco um por vez. O download
  também passou a renovar a sessão sozinho se o acesso vencer no meio do caminho.

## [1.17.0] - 2026-11-13

### Novo
- **Código do boleto no e-mail de alertas**: cada conta com boleto vai com a linha digitável no próprio e-mail,
  e o link "Copiar pelo NoPaper" abre o sistema já com o código de barras na tela (para copiar ou ler com a
  câmera do banco). Conta com PIX ganha o link para abrir o QR Code.
- **E-mail de alertas mais completo**: cada conta mostra a categoria, a pessoa relacionada e os anexos que já
  tem (boleto, nota fiscal), e cada bloco traz a quantidade de contas e o total. O e-mail agora lista todas
  as contas (antes cortava em 30 por seção, sem avisar).
- **Alertas "nos próximos dias"**: além de avisar em dias escolhidos (no dia, 3 dias antes…), dá para receber
  todo dia tudo o que vence hoje e nos próximos 1 a 30 dias.
- **Alertas só de algumas categorias**: em cada tipo de conta, escolha quais categorias entram no resumo
  (o padrão continua sendo todas).
- **Horário do alerta com minutos**: o envio pode ser marcado de 5 em 5 minutos (ex.: 07:45).
- **Minhas cores**: o botão "Cores" na lista de contas deixa cada pessoa trocar a cor com que vê cada
  categoria, sem mudar a cor para os outros. Vale em qualquer aparelho em que ela entrar.
- **Leitura de documentos escaneados e fotos**: boletos, notas e comprovantes que chegam como imagem (PDF
  escaneado, foto, print) agora são lidos por OCR, e o código de barras do boleto e o QR Code do PIX são lidos
  direto da imagem — a conta já vem com o código, o valor e o vencimento preenchidos. Vale também para guias
  de INSS (DARF) e FGTS, cujo texto não era legível.
- **Senhas de PDF**: faturas que chegam em PDF protegido (a Copel usa os 4 primeiros dígitos do CPF/CNPJ) agora
  são abertas sozinhas ao anexar. Em Configurações → Dados do espaço → **Senhas de PDF**, crie regras: os
  primeiros ou últimos dígitos (ou todos) do CPF/CNPJ do espaço, de outro CPF/CNPJ (conta em nome de outra
  pessoa) ou uma senha fixa. O NoPaper tenta cada regra, lê o documento e guarda a cópia sem senha — ela abre
  no visualizador, imprime e entra no ZIP sem pedir nada. Se nenhuma regra abrir, a tela de nova conta pede a
  senha e pode guardá-la para as próximas.
- **Imprimir anexo em imagem**: o botão Imprimir do visualizador agora aparece também para fotos e imagens,
  não só para PDF.

### Melhorado
- **Holerites** anexados às contas de salário são reconhecidos e vão para o lugar da nota fiscal.
- **Faturas de serviço** sem as palavras "nota fiscal" (com "Fatura de Serviço" e duplicata) são reconhecidas.

### Corrigido
- Boletos entregues como dois arquivos colados (o segundo protegido por senha) não eram lidos.
- Em notas e relatórios cheios de números, o sistema às vezes "achava" uma linha digitável que não existia e
  a gravava como código de barras da conta.

### Para quem instala
- A imagem da API passou a incluir os programas de leitura de imagens (`poppler-utils`, `tesseract-ocr` com
  português, `zbar`, `imagemagick` e `qpdf`). A atualização pela web reconstrói a imagem; a primeira demora um pouco
  mais. Sem esses programas o sistema funciona como antes, só sem ler documentos escaneados nem abrir PDFs com senha.

## [1.16.0] - 2026-11-13

### Novo
- **Logo do espaço**: em Configurações → Dados do espaço dá para enviar a logo (PNG, JPG, WebP ou SVG — clicando
  ou arrastando a imagem). Ela aparece no menu lateral e na lista de espaços, no lugar da inicial do nome; sem
  logo, a inicial continua. A imagem é reduzida automaticamente e pode ser trocada ou removida a qualquer hora.

- **Dados cadastrais da empresa**: espaços do perfil Empresa ganharam inscrição estadual e municipal, telefone,
  WhatsApp, e-mail, site e endereço completo (CEP, rua, número, complemento, bairro, cidade e UF). Espaços do
  perfil Pessoal continuam só com o essencial.

### Melhorado
- **Dados do espaço reorganizado em cartões**: a tela agora é dividida em blocos lado a lado (dados do espaço,
  documentos, contato e endereço), com cada campo no tamanho do que vai nele, aviso de alterações não salvas e
  botão para desfazer.
- **Fuso horário mais simples e correto**: no lugar da lista longa de cidades, os 4 fusos oficiais do Brasil
  (Brasília, Amazonas, Acre e Fernando de Noronha), com a hora atual do fuso escolhido para conferir.

## [1.15.1] - 2026-11-13

### Melhorado
- **Despesas e Receitas no espaço Pessoal**: em espaços do perfil Pessoal, "Contas a pagar" passa a se
  chamar **Despesas** e "Contas a receber", **Receitas** — no menu, nos títulos, nos relatórios, na
  importação, nos alertas e nas permissões. Em espaços do perfil Empresa os nomes continuam os mesmos.
- **A lista de contas abre em "Pendentes"**: ao entrar em Contas a pagar ou a receber, aparece primeiro o
  que ainda falta pagar ou receber no mês. "Todas", "Vencidas" e "Pagas" continuam a um clique.

## [1.15.0] - 2026-11-12

### Melhorado
- **Cadastro de funcionários reorganizado**: a janela ficou dividida em blocos (dados da pessoa, na empresa,
  para pagar o salário) e cada campo tem um tamanho de acordo com o que vai nele — código de vendedor e
  matrícula do holerite, por exemplo, ficaram pequenos, lado a lado com as datas.
- **Chave PIX com o tipo reconhecido**: ao digitar, o fim do campo mostra se a chave é CPF, CNPJ, celular,
  e-mail ou aleatória (ou avisa quando não parece uma chave completa). Com o campo vazio, os botões
  "Usar o CPF" e "Usar o celular" aproveitam o que já está no cadastro.
- **Banco, agência e conta em campos separados** no funcionário, com o banco escolhido da lista (nome e
  código, como em Contas bancárias) e o tipo de conta. O que estava anotado no campo antigo continua à
  vista, com o botão "Passar para os campos" — é só conferir e salvar.
- **Calendário com escolha de ano**: em qualquer campo de data, clique no ano para abrir uma grade de anos
  (e no mês para a de meses). Uma admissão de 2015 agora se escolhe em quatro cliques.

## [1.14.0] - 2026-11-11

### Novo
- **QR Code do PIX e código de barras do boleto na tela**: nas contas com PIX ou boleto, ao lado do botão de
  copiar, há um botão que abre o código grande para ler com a câmera do app do banco — sem digitar nada.
  Com chave PIX (CPF, CNPJ, e-mail, celular ou aleatória) o QR Code já leva o valor da conta (dá para
  desligar e digitar o valor no banco); com PIX copia e cola, mostra o próprio código. O boleto aparece em
  barras, com a linha digitável logo abaixo. Está na lista de contas e na janela da conta.

### Corrigido
- A primeira conta aberta para editar depois de carregar a página vinha com os campos em branco.

## [1.13.3] - 2026-11-11

### Melhorado
- **Holerites do contador direto na folha**: quando o contador envia o PDF dos holerites pelo NoPaper, não é
  mais preciso baixar o arquivo e subir de novo. As janelas **Importar holerites** e **Assinaturas** da
  folha mostram a lista "Enviados pelo contador" (o do mês da folha aparece primeiro, marcado "desta
  folha"): um clique usa aquele arquivo para lançar os valores ou para enviar aos funcionários assinarem.
  Escolher um arquivo do computador continua disponível.
- **Tipo "Termos" nos envios ao contador**: os termos de aceite assinados pelos funcionários chegam ao contador
  como **Termos** (antes caíam em "Outro documento"), e o tipo também pode ser escolhido ao enviar um
  arquivo: Notas fiscais | Termos | Outro. Os termos já enviados foram reclassificados.

## [1.13.2] - 2026-11-11

### Novo
- **Cota de armazenamento por espaço** (Configurações → Plataforma → Segurança): a tela mostra quanto cada
  espaço usa de arquivos (anexos de contas, documentos do contador, holerites) e o limite dele — 5 GB por
  padrão, ajustável por espaço. Perto do limite o envio avisa; ao atingir, o espaço não envia arquivos
  novos até apagar algo ou ter o limite aumentado.

### Segurança
- Os envios do contador passam a ser gravados direto no disco, sem ocupar a memória do servidor.
- Um PDF montado de propósito não consegue mais prender a leitura de holerites e do relatório de vendas.
- Importações têm tetos: fatura OFX com até 1.000 lançamentos e 3.000 parcelas futuras por vez; planilha
  da folha com até 240 meses e 10 mil lançamentos por vez.
- O link de assinatura de holerites e as chaves de arquivo não ficam mais gravados nos registros de acesso
  do servidor.
- A página não aceita mais scripts embutidos (política de conteúdo do navegador mais rígida).
- O nome de uma categoria restrita não é mais confirmado a quem não a vê; a contagem de contas de cada
  pasta não inclui as de categoria restrita para quem não as vê; desfazer a conciliação de uma conta que
  virou recorrente é bloqueado com a orientação do que fazer.
- Manual de publicação: notas sobre o IP real do visitante atrás de outro proxy e sobre o alcance do
  administrador da plataforma.

## [1.13.1] - 2026-11-11

### Segurança
Revisão completa de segurança do sistema. Não havia acesso a dados de outro espaço; as correções fecham
vazamentos dentro do próprio espaço e pontos fracos contra ataques.
- **Alertas**: só quem pode ver as contas que entram no resumo (e as categorias restritas, se incluídas)
  escolhe quem recebe os alertas. Antes, a permissão de configurar alertas bastava para receber tudo.
- **Auditoria**: cada pessoa vê só os registros das áreas a que tem acesso (contas a pagar, a receber,
  cartões, bancos, folha, contador, membros…); o administrador do espaço continua vendo tudo. Registros
  que envolvem contas de categoria restrita ficam ocultos para quem não vê restritas também em bancos e
  importações.
- **Salários**: a categoria das contas de salário da folha passa a ser **restrita** — só aparece em Contas a
  pagar para quem tem "Ver categorias restritas" (dê essa permissão a quem paga os salários). As
  observações dessas contas não trazem mais a divisão do valor.
- **Séries de contas**: quem não vê categorias restritas não lê nem altera, pela série, as parcelas que
  estão em categoria restrita.
- **Importação de planilhas**: a conferência, a lista e o desfazer respeitam as categorias restritas;
  importar contas já pagas exige a permissão de dar baixa.
- **Cartões**: lançamentos de uma fatura já paga não podem mais ser criados, apagados, movidos ou ter o
  valor alterado (reverta o pagamento em Contas a pagar antes); a conta da fatura só aparece na tela do
  cartão para quem pode vê-la em Contas a pagar.
- **Grupos e membros**: quem não é administrador não altera grupos nem membros que têm permissões que ele
  próprio não tem, e só associa contas já existentes de pessoas com quem divide algum espaço.
- **Login**: a resposta não revela mais se um usuário existe; o bloqueio por senhas erradas passou a valer
  por conta e endereço (5 erros), com limites gerais por endereço e por conta — alguém de fora não consegue
  mais travar o login de outra pessoa com poucas tentativas. A confirmação da senha atual (trocar e-mail ou
  senha) entra na mesma contagem.
- **Sessão**: um token de sessão copiado do navegador é detectado quando o dono volta a usar o sistema, e a
  sessão é encerrada.
- **Assinatura de holerites**: tentativas de CPF feitas ao mesmo tempo contam uma a uma; a imagem da
  assinatura tem limite de tamanho.
- **Arquivos**: um extrato ou fatura OFX montado de propósito não consegue mais travar o sistema; planilhas
  CSV exportadas não executam fórmulas escondidas em descrições; fuso horário do espaço é validado (um valor
  inválido interrompia os alertas de todos os espaços).
- **Mais de um contador no mesmo espaço**: ao enviar arquivos (ou holerites assinados) ao contador, escolha
  para qual deles vai ou "Todos os contadores". Cada contador só vê e baixa o que foi enviado a ele ou a
  todos. Envios antigos continuam visíveis a todos os contadores do espaço.
- Outros: o andamento da restauração não mostra mais mensagens internas de erro a quem não é administrador
  da plataforma; a análise automática de documentos exige permissão de contas; conciliações simultâneas do
  mesmo lançamento são bloqueadas.

## [1.13.0] - 2026-11-11

### Novo
- **Assinatura digital do holerite** (Folha → mês → **Assinaturas**; espaços Empresa): envie o PDF dos
  holerites do contador e o sistema separa o de cada funcionário e cria um link pessoal para cada um. Mande
  o link pelo WhatsApp (botão pronto) ou copie. O funcionário abre no celular, informa o CPF, confere o
  holerite e assina com o dedo. A assinatura e a data entram no próprio campo do holerite (nas duas vias) e
  o documento ganha uma página de comprovante (nome, CPF, data e hora, aparelho, código do documento); depois
  disso não pode mais ser alterado. O funcionário baixa a via dele pelo mesmo link; a via da empresa fica
  na folha e pode ser enviada ao contador com um clique. A janela mostra quem já assinou, quem abriu e quem
  falta. Cinco CPFs errados bloqueiam o link por 15 minutos. Precisa do CPF e da matrícula do holerite no
  cadastro do funcionário.
- **Termo de aceite de assinatura eletrônica**: antes do primeiro holerite, cada funcionário assina, uma vez,
  um termo em que concorda em receber e assinar os holerites eletronicamente. É um documento próprio, com a
  razão social e o CNPJ da empresa e o nome e o CPF do funcionário, assinado do mesmo jeito (link, CPF,
  assinatura com o dedo), com comprovante e envio ao contador. Ele é criado junto com o primeiro holerite —
  se o funcionário abrir o link do holerite antes, o sistema leva ao termo e depois volta — ou pelo botão
  **Gerar para quem falta**.
- **Razão social** em Configurações → Espaço → Dados do espaço (espaços Empresa): o nome que já existia passa
  a ser o **nome fantasia**; a razão social é a que vai nos documentos (termo de aceite e comprovantes).
  Para enviar holerites para assinatura é preciso preencher a razão social e o CNPJ.

## [1.12.0] - 2026-11-11

### Novo
- **Logo nova**: a folha de papel se desfazendo em pixels — o papel virando dado. Aparece no menu, no login,
  na aba do navegador e no ícone do app (no iPhone, para trocar o ícone da tela de início, remova o app e
  adicione de novo pelo Safari).
- **Logo em movimento nas esperas**: os quadradinhos saem da folha e formam um anel girando em volta da logo
  ao abrir o sistema, no backup, na restauração, na atualização e no envio de documentos do contador; no
  envio de arquivos grandes ao contador o anel vai se completando conforme o arquivo sobe. O “carregando”
  pequeno dos botões e das listas também virou um anel de quadradinhos.

### Melhorado
- **Opção escolhida bem mais visível** nos seletores de opções lado a lado (ex.: Todas | Pendentes | Vencidas
  | Pagas; Novos | Lançados | Dispensados | Todos; “do pagamento” × “trabalhado” na folha): a opção marcada
  agora fica preenchida em violeta, nos temas claro e escuro, em todas as telas.
- **Configurações**: a seção aberta fica destacada em violeta no menu lateral.
- **Recolher menu**: o botão saiu do rodapé do menu lateral e virou um ícone na borda do menu com a página,
  na altura da logo (o atalho Ctrl+B continua valendo).

## [1.11.0] - 2026-11-10

### Novo
- **Enviar arquivos para o contador** (menu Contador → **Enviados ao contador**): solte as notas fiscais (ou
  outro arquivo), diga o mês e, se quiser, uma observação — e pronto. Além de PDF e imagem, aceita XML e
  arquivos compactados (ZIP, RAR, 7z), de até 200 MB cada, com barra de progresso no envio; esses não abrem
  na tela, o contador baixa. A lista mostra o que já foi enviado e
  quando o contador recebeu. Usa a permissão nova “Enviar documentos para o contador” (administradores já
  têm).
- **Recebidos** (no menu do contador): o que o espaço mandou para ele, com selo de quantos ainda não viu.
  Abrir ou baixar um arquivo já marca como recebido e avisa o espaço; dá para marcar todos de uma vez,
  buscar e filtrar por mês.
- Cada lado tira o arquivo só da própria lista: o registro de quem enviou continua, como nos documentos do
  contador.

### Alterado
- Quem confere os documentos do contador não vê mais a tela de envio do contador (por tipo de guia): no
  lugar, o botão **Enviar ao contador** leva ao envio simples de notas fiscais.

## [1.10.0] - 2026-11-10

### Novo
- **Área do contador** (menu **Contador**): o contador entra no NoPaper como membro do espaço, no grupo
  **Contador** (criado em todos os espaços), e só enxerga essa tela. Por ela envia os PDFs do mês, vários
  de uma vez, escolhendo o tipo — **Holerites**, **Mensalidade do escritório**, **DAS**, **DARF**, **DAE**,
  **GARE / DARE / GNRE** ou **Outro documento** —, o mês de referência e uma observação, e acompanha se
  cada envio já foi conferido. Para ele o NoPaper é só essa tela (o Início), sem busca e sem outros
  menus, com o **histórico de envios** separado por mês, com busca e filtros por tipo e mês. Esse histórico
  é o registro fiel do que ele mandou: se o espaço tirar um documento da lista, o registro e o arquivo continuam com
  ele. O contador também pode **remover** o que enviou: se ninguém conferiu, o documento é apagado; se já
  foi conferido, sai só do histórico dele.
- **Conferir e lançar**: quem tem a permissão “Conferir e lançar os documentos do contador” vê tudo o que
  chegou, com o valor e o vencimento já lidos das guias. **Lançar conta** abre a nova conta a pagar com a
  descrição sugerida (ex.: “DAS – Out/2026”), valor, vencimento e código de barras preenchidos e o arquivo
  anexado; **Importar na folha** abre a importação dos holerites com o PDF enviado. Também dá para marcar
  como lançado, dispensar ou tirar da lista (o contador continua com o registro do envio).
- **Aviso de documento novo**: selo no menu e faixa no Início para quem confere; e, com os alertas do
  espaço ligados, mensagem na hora por Telegram e e-mail (Configurações → Alertas → “Avisar quando o
  contador enviar documentos”).

- **Remover conta de usuário** (Plataforma → Usuários): além de desativar (agora com botão direto na lista,
  que bloqueia o acesso e pode ser desfeito), dá para **remover** a conta. Ela sai de todos os espaços e das
  listas, e o e-mail e o usuário ficam livres; nada do que a pessoa fez é apagado — contas lançadas, anexos
  e a auditoria continuam com o nome dela. Dono de espaço e o último administrador da plataforma não podem
  ser removidos.

- **Membros**: ao adicionar um membro, dá para **escolher uma conta que já existe** em vez de digitar o
  e-mail (administrador da plataforma vê todas as contas; os demais, as pessoas com quem já dividem algum
  espaço).
- **Plataforma → Usuários → Editar**: nova seção **Espaços**, para colocar a conta num espaço, escolher os
  grupos dela em cada um ou tirá-la de lá, sem precisar entrar no espaço.

### Corrigido
- PDFs cheios de números (holerites, relatórios) não são mais confundidos com boleto na leitura automática
  de anexos.

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
