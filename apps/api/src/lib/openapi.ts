import { z } from 'zod';
import { API_RATE_LIMIT_PER_MINUTE } from '@nopaper/shared';
import { V1_AREA_ROUTES } from './v1catalog.js';
import { APP_VERSION } from './version.js';

/**
 * Descrição da API pública em OpenAPI 3.0 (servida em /api/v1/openapi.json).
 * Rota nova em routes/v1.ts → acrescentar aqui: este arquivo é o contrato que quem integra lê.
 */
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: unknown) => ({ content: { 'application/json': { schema } } });
const ok = (description: string, schema: unknown) => ({ description, ...json(schema) });
const err = (description: string) => ({ description, ...json(ref('Error')) });
const body = (schema: unknown, description?: string) => ({ required: true, ...(description ? { description } : {}), ...json(schema) });
const file = { required: true, content: { 'multipart/form-data': { schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary', description: 'PDF, PNG, JPG ou WEBP' } } } } } };
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };
const idemParam = { name: 'Idempotency-Key', in: 'header', required: false, description: 'Opcional. A mesma chave em até 24 h devolve a resposta da 1ª chamada (cabeçalho `Idempotent-Replay: true`), sem refazer a ação.', schema: { type: 'string', maxLength: 120 } };
const writeErrors = { 400: err('Corpo inválido (`validation`, com `issues`) ou regra do sistema não atendida (`invalid_request`)'), 404: err('Não existe, é de outro espaço ou está numa categoria restrita'), 409: err('Conflito: `locked`, `not_paid`, `external_id_conflict`, `idempotency_mismatch`, `idempotency_in_progress`') };
const errors = { 401: err('Token ausente, inválido, revogado ou vencido'), 403: err('O token não tem a permissão (o campo `required` diz qual) ou o IP não é aceito'), 429: err('Limite de chamadas atingido; ver o cabeçalho Retry-After') };
const q = (name: string, schema: unknown, description: string, required = false) => ({ name, in: 'query', required, description, schema });
const money = { type: 'string', pattern: '^\\d+\\.\\d{2}$', example: '1234.56', description: 'Valor decimal em texto, com ponto.' };
const date = { type: 'string', format: 'date', example: '2026-12-10' };
const uuid = { type: 'string', format: 'uuid' };
const nullable = (s: object) => ({ ...s, nullable: true });
const billType = { type: 'string', enum: ['payable', 'receivable'], description: 'payable = a pagar; receivable = a receber' };

/** Corpo de uma rota de área, tirado do mesmo schema que valida a chamada. */
function bodySchema(schema: z.ZodType) {
  try {
    const { $schema: _drop, ...rest } = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any', target: 'openapi-3.0' }) as Record<string, unknown>;
    return rest;
  } catch { return { type: 'object' }; }
}

/** Caminhos das áreas servidas pelas rotas da tela (lib/v1catalog.ts). */
function areaPaths() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of V1_AREA_ROUTES) {
    const path = r.path.replace(/:(\w+)/g, '{$1}');
    const params = [...r.path.matchAll(/:(\w+)/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
    const notes = [`Permissão: \`${r.perm}\`.`, r.query ? `Consulta: ${r.query}.` : '', r.upload ? `Envio em multipart/form-data: ${r.upload}.` : ''].filter(Boolean).join(' ');
    (paths[path] ??= {})[r.method.toLowerCase()] = {
      tags: [r.tag], summary: r.summary, description: notes, ...(params.length ? { parameters: params } : {}),
      ...(r.body ? { requestBody: { required: true, ...json(bodySchema(r.body)) } } : {}),
      ...(r.upload && !r.body ? { requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object' } } } } } : {}),
      responses: {
        200: r.file ? { description: 'Arquivo', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } } : ok('Mesmo formato que a tela do NoPaper recebe', { type: 'object' }),
        400: err('Corpo inválido ou regra do sistema não atendida'), 404: err('Não encontrado'), 409: err('Conflito (ex.: fatura já paga)'), ...errors,
      },
    };
  }
  return paths;
}

export function openApiDocument(baseUrl: string) {
  return {
    openapi: '3.0.3',
    info: {
      title: 'NoPaper API',
      version: `v1 (${APP_VERSION})`,
      description: [
        'API pública do NoPaper para integração com outros sistemas.',
        '',
        '**Autenticação:** `Authorization: Bearer np_…`. O token é criado em Configurações → Espaço → Integrações, pertence a um espaço e carrega as permissões marcadas por quem criou. Não há cabeçalho de espaço: ele vem do token.',
        '',
        '**Formatos:** dinheiro em texto decimal (`"1234.56"`), datas `AAAA-MM-DD` no fuso do espaço, instantes em ISO 8601 UTC, ids em UUID.',
        '',
        '**Erros:** status HTTP + `{ "error": { "code", "message" } }`.',
        '',
        `**Limite:** ${API_RATE_LIMIT_PER_MINUTE} chamadas por minuto por token; ao passar, 429 com \`Retry-After\`.`,
        '',
        '**Listas:** `limit` (até 200) e `cursor`; a resposta traz `items` e `nextCursor` (null na última página).',
        '',
        '**Gravação:** as regras são as mesmas da tela. Para não duplicar ao repetir uma chamada, mande `externalId` (o identificador do registro no seu sistema, único no espaço) ao criar contas e, se quiser, o cabeçalho `Idempotency-Key` nos POST. Toda gravação aparece na auditoria do espaço como "Integração <nome do token>".',
        '',
        '**Eventos:** `GET /events?after=<cursor>` devolve, em ordem, o que mudou no espaço. Guarde `nextCursor` e mande de volta; para começar de agora, use `eventsCursor` de `/space`. O evento diz o que mudou e em qual registro — o estado atual vem de um GET no recurso.',
        '',
        '**Webhooks:** opcionais, configurados no token (Configurações → Integrações). O NoPaper faz POST do mesmo objeto de `/events` no endereço informado, com `X-NoPaper-Event`, `X-NoPaper-Delivery` (id do evento) e `X-NoPaper-Signature: t=<unix>,v1=<hex>`, em que `v1` = HMAC-SHA256 de `"<t>.<corpo>"` com o segredo do webhook. Responda 2xx em até 10 s. Falhou: tenta de novo com intervalo crescente, sempre em ordem; 24 h falhando, o webhook é pausado. Trate entregas repetidas pelo id.',
        '',
        '**Áreas além de contas** (cartões, bancos, folha, assinatura, contador, relatórios, auditoria): usam as mesmas rotas e os mesmos formatos da tela do NoPaper. O corpo de cada chamada está descrito aqui; as respostas são os objetos que a tela recebe e podem ganhar campos.',
        '',
        '**Estabilidade:** campos novos podem aparecer na v1; nenhum campo existente muda de sentido ou some.',
        '',
        'Categorias restritas (ex.: salários) só aparecem para tokens com `bills.view_restricted`; sem ela, essas contas ficam fora de listas e totais e o acesso direto responde 404.',
      ].join('\n'),
    },
    servers: [{ url: `${baseUrl.replace(/\/$/, '')}/api/v1` }],
    security: [{ token: [] }],
    tags: [{ name: 'Espaço' }, { name: 'Eventos' }, { name: 'Contas' }, { name: 'Categorias e pastas' }, ...[...new Set(V1_AREA_ROUTES.map((r) => r.tag))].map((name) => ({ name }))],
    paths: {
      '/space': {
        get: {
          tags: ['Espaço'], summary: 'Espaço do token e permissões (teste de conexão)',
          responses: { 200: ok('Espaço e integração', ref('Space')), ...errors },
        },
      },
      '/events': {
        get: {
          tags: ['Eventos'], summary: 'O que mudou no espaço desde o cursor',
          description: 'Só aparecem eventos das áreas que o token pode ver, e nada de categoria restrita sem `bills.view_restricted`.',
          parameters: [
            q('after', { type: 'string', default: '0' }, 'Cursor: `nextCursor` da chamada anterior, ou `eventsCursor` de `/space`'),
            q('limit', { type: 'integer', minimum: 1, maximum: 200, default: 100 }, 'Máximo de eventos'),
            q('types', { type: 'string', example: 'bill.,attachment.' }, 'Só tipos que começam com um destes prefixos, separados por vírgula'),
          ],
          responses: { 200: ok('Eventos em ordem', { type: 'object', properties: { items: { type: 'array', items: ref('Event') }, nextCursor: { type: 'string' }, hasMore: { type: 'boolean', description: 'true = chame de novo já, há mais' } } }), ...errors },
        },
      },
      '/bills': {
        get: {
          tags: ['Contas'], summary: 'Lista contas a pagar e a receber',
          description: 'Ordenadas por vencimento. Exige `payable.view` e/ou `receivable.view`; sem `type`, vêm os tipos que o token pode ver.',
          parameters: [
            q('type', billType, 'Só um tipo'),
            q('status', { type: 'string', enum: ['pending', 'paid', 'overdue'] }, 'pending = em aberto; paid = baixada; overdue = em aberto e vencida'),
            q('dueFrom', date, 'Vencimento a partir de'), q('dueTo', date, 'Vencimento até'),
            q('paidFrom', date, 'Pagamento a partir de'), q('paidTo', date, 'Pagamento até'),
            q('categoryId', uuid, 'Só desta categoria'),
            q('folderId', { type: 'string' }, 'Id da pasta, ou `none` para contas sem pasta'),
            q('search', { type: 'string', maxLength: 120 }, 'Texto na descrição, pessoa ou observações'),
            q('externalId', { type: 'string' }, 'A conta com este identificador externo'),
            q('updatedSince', { type: 'string', format: 'date-time' }, 'Só o que foi alterado a partir deste instante'),
            q('limit', { type: 'integer', minimum: 1, maximum: 200, default: 50 }, 'Itens por página'),
            q('cursor', { type: 'string' }, 'Valor de `nextCursor` da página anterior'),
          ],
          responses: { 200: ok('Página de contas', { type: 'object', properties: { items: { type: 'array', items: ref('Bill') }, nextCursor: nullable({ type: 'string' }) } }), 400: err('Parâmetro inválido'), ...errors },
        },
        post: {
          tags: ['Contas'], summary: 'Cria uma conta ou uma série',
          description: 'Exige `payable.create` ou `receivable.create`. Com `recurrence`, cria todas as ocorrências de uma vez. Se já existir conta com o `externalId` enviado, nada é criado: a resposta é 200 com `created: false` e a conta (ou série) existente.',
          parameters: [idemParam], requestBody: body(ref('BillCreate')),
          responses: { 201: ok('Criada', ref('BillCreated')), 200: ok('Já existia com este externalId', ref('BillCreated')), ...writeErrors, ...errors },
        },
      },
      '/bills/summary': {
        get: {
          tags: ['Contas'], summary: 'Totais de um mês',
          parameters: [q('type', billType, 'Tipo', true), q('year', { type: 'integer' }, 'Ano', true), q('month', { type: 'integer', minimum: 1, maximum: 12 }, 'Mês', true)],
          responses: { 200: ok('Totais do mês, vencidas e a vencer em 7 dias', ref('BillSummary')), 400: err('Parâmetro inválido'), ...errors },
        },
      },
      '/bills/{id}': {
        get: {
          tags: ['Contas'], summary: 'Uma conta',
          parameters: [{ name: 'id', in: 'path', required: true, schema: uuid }],
          responses: { 200: ok('Conta', ref('Bill')), 404: err('Não existe, é de outro espaço ou está numa categoria restrita'), ...errors },
        },
        patch: {
          tags: ['Contas'], summary: 'Altera uma conta',
          description: 'Só os campos enviados mudam. Exige `*.edit`; mexer em `paidAt`/`paidAmount` de conta já baixada exige `*.pay`. Conta de fatura de cartão ou de salário não aceita mudar valor nem vencimento (409 `locked`).',
          parameters: [idParam], requestBody: body(ref('BillUpdate')),
          responses: { 200: ok('Conta alterada', ref('Bill')), ...writeErrors, ...errors },
        },
        delete: {
          tags: ['Contas'], summary: 'Apaga uma conta ou parte da série',
          description: 'Exige `*.delete`. Os anexos vão junto. Contas pagas de `following` são preservadas.',
          parameters: [idParam, q('scope', { type: 'string', enum: ['one', 'following', 'series'], default: 'one' }, 'one = só esta; following = esta e as seguintes em aberto; series = a série inteira')],
          responses: { 200: ok('Quantas foram apagadas', { type: 'object', properties: { deleted: { type: 'integer' }, preservedPaid: { type: 'integer' } } }), ...writeErrors, ...errors },
        },
      },
      '/bills/{id}/pay': {
        post: {
          tags: ['Contas'], summary: 'Dá baixa (paga ou recebe)', description: 'Exige `*.pay`. Sem corpo: data de hoje no fuso do espaço e o valor da conta.',
          parameters: [idParam, idemParam], requestBody: { ...json({ type: 'object', properties: { paidAt: date, paidAmount: money } }) },
          responses: { 200: ok('Conta baixada', ref('Bill')), ...writeErrors, ...errors },
        },
      },
      '/bills/{id}/unpay': {
        post: { tags: ['Contas'], summary: 'Reverte a baixa', parameters: [idParam, idemParam], responses: { 200: ok('Conta em aberto de novo', ref('Bill')), ...writeErrors, ...errors } },
      },
      '/bills/{id}/series': {
        get: { tags: ['Contas'], summary: 'Todas as contas da mesma série', parameters: [idParam], responses: { 200: ok('Série', { type: 'object', properties: { seriesId: nullable(uuid), items: { type: 'array', items: ref('Bill') } } }), 404: err('Conta não encontrada'), ...errors } },
      },
      '/bills/{id}/attachments': {
        post: {
          tags: ['Contas'], summary: 'Anexa um arquivo',
          description: 'Um arquivo por vaga; enviar de novo troca. Com `slot=auto` o sistema lê o documento e escolhe a vaga (400 `classification_unknown` se não reconhecer). Boleto lido preenche a linha digitável da conta, se estiver vazia.',
          parameters: [idParam, q('slot', { type: 'string', enum: ['auto', 'boleto', 'invoice', 'payment_proof'], default: 'auto' }, 'Vaga do anexo')], requestBody: file,
          responses: { 200: ok('Anexado', { type: 'object', properties: { slot: { type: 'string' }, detected: nullable({ type: 'object', description: 'O que foi lido do documento (só com slot=auto)' }), bill: ref('Bill') } }), 413: err('Cota de armazenamento do espaço (`storage_quota`)'), ...writeErrors, ...errors },
        },
      },
      '/bills/{id}/attachments/{slot}': {
        delete: { tags: ['Contas'], summary: 'Remove o anexo de uma vaga', parameters: [idParam, { name: 'slot', in: 'path', required: true, schema: { type: 'string', enum: ['boleto', 'invoice', 'payment_proof'] } }], responses: { 200: ok('Conta sem o anexo', ref('Bill')), ...writeErrors, ...errors } },
      },
      '/documents/analyze': {
        post: {
          tags: ['Contas'], summary: 'Lê um documento sem guardar', description: 'Devolve o tipo (boleto, nota, comprovante), valor, vencimento, linha digitável e PIX que o leitor encontrou.',
          requestBody: file, responses: { 200: ok('Leitura', { type: 'object' }), ...writeErrors, ...errors },
        },
      },
      '/attachments/{id}/url': {
        get: {
          tags: ['Contas'], summary: 'URL assinada de um anexo',
          description: 'A URL vale 10 minutos e não precisa do token. Peça uma nova a cada uso.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: uuid }],
          responses: { 200: ok('Endereços para ver e baixar', ref('AttachmentUrl')), 404: err('Anexo não encontrado'), ...errors },
        },
      },
      '/categories': {
        get: { tags: ['Categorias e pastas'], summary: 'Categorias do espaço', responses: { 200: ok('Categorias em ordem alfabética', { type: 'object', properties: { items: { type: 'array', items: ref('Category') } } }), ...errors } },
        post: { tags: ['Categorias e pastas'], summary: 'Cria categoria', description: 'Exige `bills.categories`. O nome é único no espaço.', parameters: [idemParam], requestBody: body(ref('CategoryInput')), responses: { 201: ok('Criada', ref('Category')), ...writeErrors, ...errors } },
      },
      '/categories/{id}': {
        patch: { tags: ['Categorias e pastas'], summary: 'Altera categoria', parameters: [idParam], requestBody: body(ref('CategoryInput')), responses: { 200: ok('Alterada', ref('Category')), ...writeErrors, ...errors } },
        delete: { tags: ['Categorias e pastas'], summary: 'Apaga categoria sem contas', parameters: [idParam], responses: { 200: ok('Apagada', { type: 'object', properties: { deleted: { type: 'boolean' } } }), ...writeErrors, ...errors } },
      },
      '/folders': {
        get: { tags: ['Categorias e pastas'], summary: 'Pastas do espaço', responses: { 200: ok('Pastas em ordem alfabética', { type: 'object', properties: { items: { type: 'array', items: ref('Folder') } } }), ...errors } },
        post: { tags: ['Categorias e pastas'], summary: 'Cria pasta', description: 'Exige `bills.folders`.', parameters: [idemParam], requestBody: body(ref('FolderInput')), responses: { 201: ok('Criada', ref('Folder')), ...writeErrors, ...errors } },
      },
      '/folders/{id}': {
        patch: { tags: ['Categorias e pastas'], summary: 'Altera pasta', parameters: [idParam], requestBody: body(ref('FolderInput')), responses: { 200: ok('Alterada', ref('Folder')), ...writeErrors, ...errors } },
        delete: { tags: ['Categorias e pastas'], summary: 'Apaga pasta', description: 'As contas da pasta ficam sem pasta.', parameters: [idParam], responses: { 200: ok('Apagada', { type: 'object', properties: { deleted: { type: 'boolean' } } }), ...writeErrors, ...errors } },
      },
      ...areaPaths(),
    },
    components: {
      securitySchemes: { token: { type: 'http', scheme: 'bearer', description: 'Token de integração (`np_…`)' } },
      schemas: {
        Error: {
          type: 'object',
          properties: {
            error: {
              type: 'object', required: ['code', 'message'],
              properties: {
                code: { type: 'string', description: 'unauthorized, token_expired, ip_not_allowed, forbidden, not_found, validation, invalid_request, locked, not_paid, external_id_conflict, idempotency_mismatch, idempotency_in_progress, classification_unknown, storage_quota, rate_limited, maintenance, internal' },
                message: { type: 'string', description: 'Explicação em português' },
                required: { type: 'array', items: { type: 'string' }, description: 'Em `forbidden`: permissões que serviriam' },
                issues: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, message: { type: 'string' } } }, description: 'Em `validation`: campos com problema' },
              },
            },
          },
        },
        Event: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Crescente; também é o cursor' },
            type: {
              type: 'string',
              description: 'bill.created | updated | deleted | paid | unpaid | series_changed | imported | import_undone; attachment.added | removed; category.* e folder.* (created | updated | deleted); card.*, card.transaction.* (+ moved), card.category.*, card.import.created | undone; bank.account.*, bank.import.created | undone, bank.transaction.reconciled | unreconciled; payroll.employee.*, payroll.entry.*, payroll.period.*, payroll.rubric.*, payroll.payslips.imported, payroll.commissions.applied, payroll.settings.updated; payslip.signature.created | signed | cancelled, payslip.term.created; accounting.document.received | sent | updated; ping (teste de webhook)',
            },
            occurredAt: { type: 'string', format: 'date-time' },
            resource: { type: 'object', properties: { type: nullable({ type: 'string', example: 'bill' }), id: nullable({ type: 'string' }), ids: { type: 'array', items: { type: 'string' }, description: 'Na baixa em massa: todas as contas' }, externalId: nullable({ type: 'string', description: 'Em contas' }) } },
            billType: billType,
            actor: { type: 'object', properties: { type: { type: 'string', enum: ['user', 'integration', 'system'] }, name: nullable({ type: 'string' }) } },
          },
        },
        Space: {
          type: 'object',
          properties: {
            id: uuid, name: { type: 'string' }, legalName: nullable({ type: 'string' }), document: nullable({ type: 'string', description: 'CPF ou CNPJ formatado' }),
            kind: { type: 'string', enum: ['personal', 'company'] }, timezone: { type: 'string', example: 'America/Sao_Paulo' }, today: date,
            integration: { type: 'object', properties: { id: uuid, name: { type: 'string' }, permissions: { type: 'array', items: { type: 'string' } }, expiresAt: nullable(date) } },
            eventsCursor: { type: 'string', description: 'Cursor do evento mais recente' },
            apiVersion: { type: 'string', example: 'v1' }, serverVersion: { type: 'string' },
          },
        },
        Bill: {
          type: 'object',
          properties: {
            id: uuid, type: billType, description: { type: 'string' }, amount: money, dueDate: date,
            status: { type: 'string', enum: ['pending', 'paid'] }, overdue: { type: 'boolean', description: 'Em aberto e vencida (pelo "hoje" do espaço)' },
            paidAt: nullable(date), paidAmount: nullable(money), categoryId: uuid, folderId: nullable(uuid),
            relatedPerson: nullable({ type: 'string', description: 'Fornecedor, cliente ou pessoa' }), notes: nullable({ type: 'string' }),
            barcode: nullable({ type: 'string', description: 'Linha digitável do boleto' }), pixKey: nullable({ type: 'string', description: 'Chave PIX ou código copia e cola' }),
            paymentMethod: nullable({ type: 'string' }),
            recurrence: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['once', 'weekly', 'biweekly', 'monthly', 'yearly', 'installments'] },
                seriesId: nullable({ ...uuid, description: 'Igual em todas as contas da mesma série' }),
                installmentNumber: nullable({ type: 'integer' }), totalInstallments: nullable({ type: 'integer' }), indefinite: { type: 'boolean' },
              },
            },
            origin: { type: 'string', enum: ['manual', 'card_statement', 'payroll'], description: 'Fatura de cartão e salário da folha têm valor e vencimento controlados no módulo de origem' },
            locked: { type: 'boolean', description: 'true quando valor e vencimento não podem ser alterados pela conta' },
            externalId: nullable({ type: 'string', description: 'Identificador da conta no sistema que a criou pela API (único no espaço)' }), source: nullable({ type: 'string', description: 'Nome do sistema de origem' }),
            attachments: { type: 'array', items: ref('Attachment') },
            createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' },
          },
        },
        BillCreate: {
          type: 'object', required: ['type', 'description', 'categoryId', 'dueDate'],
          properties: {
            type: billType, description: { type: 'string', maxLength: 255 }, categoryId: uuid, folderId: nullable(uuid),
            amount: { ...money, description: 'Obrigatório, salvo quando `recurrence.amounts` traz os valores' }, dueDate: { ...date, description: 'Vencimento (da 1ª ocorrência, numa série)' },
            relatedPerson: nullable({ type: 'string', maxLength: 128 }), notes: nullable({ type: 'string', maxLength: 2000 }), barcode: nullable({ type: 'string', maxLength: 120 }),
            pixKey: nullable({ type: 'string', maxLength: 600 }), paymentMethod: nullable({ type: 'string', maxLength: 64 }),
            paidAt: nullable({ ...date, description: 'Já criar como baixada (exige `*.pay`); numa série vale para a 1ª ocorrência' }), paidAmount: nullable(money),
            recurrence: {
              type: 'object', required: ['type'],
              properties: {
                type: { type: 'string', enum: ['once', 'weekly', 'biweekly', 'monthly', 'yearly', 'installments'] },
                indefinite: { type: 'boolean', description: 'Sem data para acabar (semanal a anual): o sistema mantém os próximos 24 meses lançados' },
                occurrences: { type: 'integer', minimum: 1, maximum: 420, description: 'Quantidade de contas ou de parcelas' },
                amounts: { type: 'array', items: money, description: 'Valor de cada ocorrência, quando diferem' },
                dueDates: { type: 'array', items: date, description: 'Vencimento de cada ocorrência, quando não seguem o calendário' },
                firstInstallment: { type: 'integer', description: 'Parcelado que começou fora do sistema: número da 1ª parcela lançada (ex.: 42 de 213)' },
                externalIds: { type: 'array', items: nullable({ type: 'string' }), description: 'Identificador externo de cada ocorrência, na ordem; o 1º é o da própria conta' },
              },
            },
            externalId: { type: 'string', maxLength: 120, description: 'Identificador no seu sistema, sem espaços. Único no espaço' }, source: { type: 'string', maxLength: 40 },
          },
        },
        BillCreated: {
          type: 'object',
          properties: { created: { type: 'boolean', description: 'false = já existia conta com o externalId' }, seriesId: nullable(uuid), items: { type: 'array', items: ref('Bill'), description: 'A conta, ou todas as ocorrências da série' } },
        },
        BillUpdate: {
          type: 'object',
          properties: {
            description: { type: 'string' }, categoryId: uuid, folderId: nullable(uuid), amount: money, dueDate: date,
            relatedPerson: nullable({ type: 'string' }), notes: nullable({ type: 'string' }), barcode: nullable({ type: 'string' }), pixKey: nullable({ type: 'string' }), paymentMethod: nullable({ type: 'string' }),
            paidAt: { ...date, description: 'Só em conta já baixada' }, paidAmount: { ...money, description: 'Só em conta já baixada' },
            applyToFollowing: { type: 'boolean', description: 'Leva a mudança (menos o vencimento) às próximas contas em aberto da série' },
            externalId: nullable({ type: 'string' }), source: nullable({ type: 'string' }),
          },
        },
        CategoryInput: { type: 'object', properties: { name: { type: 'string', maxLength: 64 }, color: { type: 'string' }, kind: { type: 'string', enum: ['payable', 'receivable', 'both'] }, restricted: { type: 'boolean', description: 'Exige `bills.view_restricted`; só em categoria sem contas' } } },
        FolderInput: { type: 'object', properties: { name: { type: 'string', maxLength: 64 }, label: { type: 'string', maxLength: 32, description: 'Sigla' }, color: { type: 'string' } } },
        Attachment: {
          type: 'object',
          properties: { id: uuid, slot: { type: 'string', enum: ['boleto', 'invoice', 'payment_proof'], description: 'Um arquivo por vaga: boleto, nota fiscal, comprovante' }, name: { type: 'string' }, mime: { type: 'string' }, size: { type: 'integer', description: 'Bytes' } },
        },
        AttachmentUrl: {
          type: 'object',
          properties: { id: uuid, billId: uuid, slot: { type: 'string' }, name: { type: 'string' }, mime: { type: 'string' }, size: { type: 'integer' }, url: { type: 'string', format: 'uri' }, downloadUrl: { type: 'string', format: 'uri' }, expiresInSeconds: { type: 'integer', example: 600 } },
        },
        BillSummary: {
          type: 'object',
          properties: {
            type: billType, year: { type: 'integer' }, month: { type: 'integer' }, today: date,
            pending: ref('Total'), paid: ref('Total'), forecast: ref('Total'),
            overdue: { ...ref('Total'), description: 'Todas as vencidas, de qualquer mês' }, dueSoon: { ...ref('Total'), description: 'Vencem de hoje a 7 dias' },
            categoriesActive: { type: 'integer' },
            byCategory: { type: 'array', items: { type: 'object', properties: { categoryId: uuid, total: money, paid: money, count: { type: 'integer' } } } },
          },
        },
        Total: { type: 'object', properties: { total: money, count: { type: 'integer' } } },
        Category: {
          type: 'object',
          properties: { id: uuid, name: { type: 'string' }, color: { type: 'string' }, kind: { type: 'string', enum: ['payable', 'receivable', 'both'] }, restricted: { type: 'boolean' }, updatedAt: { type: 'string', format: 'date-time' } },
        },
        Folder: {
          type: 'object',
          properties: { id: uuid, name: { type: 'string' }, label: { type: 'string', description: 'Sigla' }, color: { type: 'string' }, updatedAt: { type: 'string', format: 'date-time' } },
        },
      },
    },
  };
}
