import type { z } from 'zod';
import {
  accountingHandleSchema, bankAccountSchema, bankImportSchema, cardCategorySchema, cardOfxImportSchema, cardSchema, cardTxSchema, cardTxUpdateSchema,
  employeeSchema, esignSendAccountantSchema, payrollCommissionApplySchema, payrollCommissionsSchema, payrollEntryCreateSchema, payrollEntrySchema,
  payrollPayslipApplySchema, payrollPeriodCreateSchema, payrollPeriodUpdateSchema, payrollRubricOrderSchema, payrollRubricSchema, payrollSettingsSchema,
  reconcileSchema,
} from '@nopaper/shared';

/**
 * Áreas da API pública servidas pelas mesmas rotas da tela (cartões, bancos, folha, assinatura,
 * contador, relatórios, auditoria). Cada linha libera um endereço em `/api/v1` — o que não está
 * aqui não é alcançável por token. O endereço interno é o mesmo, trocando `/api/v1` por `/api`;
 * corpo e resposta têm o formato que a tela usa. A descrição OpenAPI sai desta lista.
 */
export interface V1Route {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  tag: string;
  summary: string;
  /** Permissões que a rota exige (texto para a documentação; quem confere é a rota interna). */
  perm: string;
  body?: z.ZodType;
  /** Envio de arquivo em multipart/form-data (campo `file`, mais os campos de texto citados). */
  upload?: string;
  /** Parâmetros de consulta, para a documentação. */
  query?: string;
  /** Resposta é um arquivo, não JSON. */
  file?: boolean;
}

const r = (method: V1Route['method'], path: string, tag: string, summary: string, perm: string, extra: Partial<V1Route> = {}): V1Route => ({ method, path, tag, summary, perm, ...extra });
const CARDS = 'Cartões', BANK = 'Contas bancárias', PAY = 'Folha de pagamento', SIGN = 'Assinatura de holerites', ACC = 'Contador', REP = 'Relatórios e auditoria';

export const V1_AREA_ROUTES: V1Route[] = [
  // ---------------------------------------------------------------- cartões
  r('GET', '/cards', CARDS, 'Cartões do espaço, com a fatura atual', 'cards.view'),
  r('POST', '/cards', CARDS, 'Cadastra um cartão', 'cards.manage', { body: cardSchema }),
  r('PUT', '/cards/:id', CARDS, 'Altera um cartão (corpo completo)', 'cards.manage', { body: cardSchema }),
  r('GET', '/cards/:id/delete-impact', CARDS, 'O que seria apagado junto com o cartão', 'cards.manage'),
  r('DELETE', '/cards/:id', CARDS, 'Apaga o cartão com compras e faturas em aberto', 'cards.manage + payable.delete', { query: 'confirmName = nome do cartão, quando ele tem lançamentos' }),
  r('GET', '/cards/:id/statement', CARDS, 'Fatura de um mês: compras, total e a conta a pagar ligada', 'cards.view', { query: 'ref = AAAA-MM do vencimento (padrão: fatura atual)' }),
  r('POST', '/card-transactions', CARDS, 'Lança uma compra (à vista ou parcelada)', 'cards.edit', { body: cardTxSchema }),
  r('PUT', '/card-transactions/:id', CARDS, 'Altera uma compra', 'cards.edit', { body: cardTxUpdateSchema }),
  r('DELETE', '/card-transactions/:id', CARDS, 'Apaga uma compra', 'cards.edit', { query: 'mode = one | group (todas as parcelas) | forward (esta e as seguintes)' }),
  r('POST', '/card-transactions/:id/move', CARDS, 'Move a compra para outra fatura', 'cards.edit', { query: 'corpo: { "ref": "AAAA-MM" }' }),
  r('GET', '/card-categories', CARDS, 'Categorias de gasto do cartão', 'cards.view ou reports.view'),
  r('POST', '/card-categories', CARDS, 'Cria categoria de gasto', 'cards.manage', { body: cardCategorySchema }),
  r('PUT', '/card-categories/:id', CARDS, 'Altera categoria de gasto', 'cards.manage', { body: cardCategorySchema }),
  r('DELETE', '/card-categories/:id', CARDS, 'Apaga categoria de gasto', 'cards.manage', { query: 'moveTo = categoria que recebe as compras, quando há compras' }),
  r('POST', '/cards/ofx/read', CARDS, 'Lê uma fatura em OFX, sem gravar', 'cards.edit', { upload: 'file = arquivo .ofx' }),
  r('POST', '/cards/:id/ofx/import', CARDS, 'Importa os lançamentos lidos da fatura', 'cards.edit', { body: cardOfxImportSchema }),
  r('GET', '/cards/:id/imports', CARDS, 'Importações de fatura do cartão', 'cards.view'),
  r('DELETE', '/cards/imports/:id', CARDS, 'Desfaz uma importação de fatura', 'cards.edit'),

  // ---------------------------------------------------------------- contas bancárias
  r('GET', '/bank/accounts', BANK, 'Contas bancárias, com o resumo da conciliação', 'bank.view'),
  r('POST', '/bank/accounts', BANK, 'Cadastra conta bancária', 'bank.manage', { body: bankAccountSchema }),
  r('PUT', '/bank/accounts/:id', BANK, 'Altera conta bancária', 'bank.manage', { body: bankAccountSchema }),
  r('DELETE', '/bank/accounts/:id', BANK, 'Apaga conta bancária', 'bank.manage'),
  r('POST', '/bank/read', BANK, 'Lê um extrato OFX, sem gravar', 'bank.import', { upload: 'file = arquivo .ofx' }),
  r('POST', '/bank/import', BANK, 'Importa os lançamentos lidos do extrato', 'bank.import', { body: bankImportSchema }),
  r('GET', '/bank/imports', BANK, 'Extratos importados', 'bank.view'),
  r('DELETE', '/bank/imports/:id', BANK, 'Desfaz a importação de um extrato (só sem conciliados)', 'bank.import'),
  r('GET', '/bank/accounts/:id/reconcile', BANK, 'Lançamentos de um período e as contas candidatas a cada um', 'bank.view', { query: 'from, to = AAAA-MM-DD' }),
  r('POST', '/bank/accounts/:id/reconcile', BANK, 'Concilia: liga a uma conta, cria a conta ou ignora', 'bank.import (+ pay / create do tipo da conta)', { body: reconcileSchema }),
  r('POST', '/bank/transactions/:id/undo', BANK, 'Desfaz a conciliação de um lançamento', 'bank.import'),

  // ---------------------------------------------------------------- folha (só espaço Empresa)
  r('GET', '/payroll/meta', PAY, 'Funcionários, rubricas e configuração da folha', 'payroll.view'),
  r('PUT', '/payroll/settings', PAY, 'Configuração da folha (categoria, pasta, dia do pagamento, custos)', 'payroll.manage + bills.view_restricted', { body: payrollSettingsSchema }),
  r('PUT', '/payroll/settings/commissions', PAY, 'Regras de comissão', 'payroll.manage', { body: payrollCommissionsSchema }),
  r('POST', '/payroll/employees', PAY, 'Cadastra funcionário', 'payroll.manage', { body: employeeSchema }),
  r('PUT', '/payroll/employees/:id', PAY, 'Altera funcionário (corpo completo)', 'payroll.manage', { body: employeeSchema }),
  r('DELETE', '/payroll/employees/:id', PAY, 'Apaga funcionário sem lançamentos (ou desativa)', 'payroll.manage'),
  r('GET', '/payroll/employees/:id/history', PAY, 'Histórico de pagamentos do funcionário', 'payroll.view'),
  r('POST', '/payroll/rubrics', PAY, 'Cria rubrica', 'payroll.manage', { body: payrollRubricSchema }),
  r('PUT', '/payroll/rubrics/order', PAY, 'Reordena as rubricas', 'payroll.manage', { body: payrollRubricOrderSchema }),
  r('PUT', '/payroll/rubrics/:id', PAY, 'Altera rubrica', 'payroll.manage', { body: payrollRubricSchema }),
  r('DELETE', '/payroll/rubrics/:id', PAY, 'Apaga rubrica', 'payroll.manage'),
  r('GET', '/payroll/periods', PAY, 'Meses da folha, com totais', 'payroll.view'),
  r('GET', '/payroll/month/:ref', PAY, 'Folha de um mês (ref = AAAA-MM): lançamentos, linhas e totais', 'payroll.view'),
  r('POST', '/payroll/periods', PAY, 'Abre a folha de um mês', 'payroll.edit', { body: payrollPeriodCreateSchema }),
  r('PUT', '/payroll/periods/:id', PAY, 'Altera data de pagamento e observações do mês', 'payroll.edit', { body: payrollPeriodUpdateSchema }),
  r('POST', '/payroll/periods/:id/enable-bills', PAY, 'Passa a gerar as contas a pagar dos salários do mês', 'payroll.edit'),
  r('DELETE', '/payroll/periods/:id', PAY, 'Apaga a folha do mês (sem salário pago)', 'payroll.edit'),
  r('POST', '/payroll/entries', PAY, 'Lança um funcionário no mês', 'payroll.edit', { body: payrollEntryCreateSchema }),
  r('PUT', '/payroll/entries/:id', PAY, 'Altera o lançamento de um funcionário', 'payroll.edit', { body: payrollEntrySchema }),
  r('DELETE', '/payroll/entries/:id', PAY, 'Tira o funcionário da folha do mês', 'payroll.edit'),
  r('POST', '/payroll/payslips/read', PAY, 'Lê o PDF de holerites do contador, sem gravar', 'payroll.edit', { upload: 'file = PDF dos holerites' }),
  r('POST', '/payroll/periods/:id/payslips', PAY, 'Lança os holerites lidos na folha do mês', 'payroll.edit (+ payroll.manage para criar funcionário ou rubrica)', { body: payrollPayslipApplySchema }),
  r('POST', '/payroll/commissions/read', PAY, 'Lê o relatório de vendas (PDF), sem gravar', 'payroll.edit', { upload: 'file = PDF do relatório' }),
  r('POST', '/payroll/periods/:id/commissions', PAY, 'Aplica as comissões lidas na folha do mês', 'payroll.edit', { body: payrollCommissionApplySchema }),
  r('GET', '/payroll/periods/:id/commissions', PAY, 'Última aplicação de comissões do mês', 'payroll.view'),

  // ---------------------------------------------------------------- assinatura de holerites
  r('GET', '/payroll/periods/:id/signatures', SIGN, 'Holerites enviados para assinatura no mês e a situação de cada um', 'payroll.view'),
  r('POST', '/payroll/periods/:id/signatures', SIGN, 'Envia holerites para assinatura (PDF com todos; o sistema separa por funcionário)', 'payroll.edit', { upload: 'file = PDF dos holerites; ou corpo JSON { "docId": "<documento do contador>" }' }),
  r('GET', '/payroll/signatures/:id/link', SIGN, 'Link pessoal de assinatura do funcionário', 'payroll.edit'),
  r('GET', '/payroll/signatures/:id/file', SIGN, 'PDF do holerite (assinado, quando já foi)', 'payroll.view', { file: true }),
  r('DELETE', '/payroll/signatures/:id', SIGN, 'Cancela um envio ainda não assinado', 'payroll.edit'),
  r('GET', '/payroll/signature-terms', SIGN, 'Termos de aceite da assinatura eletrônica, por funcionário', 'payroll.view'),
  r('POST', '/payroll/signature-terms', SIGN, 'Gera o termo de aceite para quem ainda não tem', 'payroll.edit'),
  r('POST', '/payroll/signatures/send-accountant', SIGN, 'Envia holerites e termos assinados ao contador', 'accounting.send', { body: esignSendAccountantSchema }),

  // ---------------------------------------------------------------- contador
  r('GET', '/accounting/summary', ACC, 'Quantos documentos aguardam conferência', 'accounting.review, accounting.send ou accounting.upload'),
  r('GET', '/accounting/documents', ACC, 'Documentos trocados com o contador', 'accounting.review, accounting.send ou accounting.upload', { query: 'direction = to_client (do contador) | to_accountant (para o contador); status; month' }),
  r('GET', '/accounting/accountants', ACC, 'Contadores do espaço (para escolher o destinatário)', 'accounting.send'),
  r('POST', '/accounting/documents', ACC, 'Envio do contador para o espaço (guias, holerites…)', 'accounting.upload', { upload: 'campos kind, month, notes antes dos arquivos; até 20 arquivos' }),
  r('POST', '/accounting/outbox', ACC, 'Envio do espaço para o contador (notas fiscais e outros)', 'accounting.send', { upload: 'campos kind (invoice | other), month, notes, recipient antes dos arquivos' }),
  r('PUT', '/accounting/documents/:id', ACC, 'Marca como conferido/lançado, dispensa ou liga a uma conta', 'lado que recebe o documento', { body: accountingHandleSchema }),
  r('DELETE', '/accounting/documents/:id', ACC, 'Tira o documento da própria lista', 'quem enviou ou quem recebe'),
  r('GET', '/accounting/documents/:id/url', ACC, 'URL assinada (10 min) do arquivo', 'quem enviou ou quem recebe'),
  r('POST', '/accounting/documents/:id/payslips', ACC, 'Lê os holerites de um documento do contador', 'accounting.review + payroll.edit'),

  // ---------------------------------------------------------------- relatórios e auditoria
  r('GET', '/reports/overview', REP, 'Totais do ano por mês e por categoria, a pagar e a receber, e gastos do cartão', 'reports.view + ver o tipo', { query: 'type = payable | receivable, year' }),
  r('GET', '/export/sheet', REP, 'Planilha de contas (xlsx ou csv) com os mesmos filtros da lista', 'bills.export', { query: 'type, year, month, from, to, status, categoryId, folderId, search, format = xlsx | csv', file: true }),
  r('GET', '/audit', REP, 'Histórico de ações do espaço', 'audit.view', { query: 'before (cursor), area, user, q, from, to' }),
];
